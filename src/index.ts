/**
 * dsh-agent-toolface：工具面分档（agent 作用域收窄 + 运行时切换原语）。
 *
 * 背景（2026-09-13 实测）：模型可见 274 个工具 / 122,076 字符 ≈ 30,519 tok，
 * 其中 63 个工具（sec_/red_/blue_/otw_/xp_/clyan_/video_/download_ 族）14 天内
 * 零调用却占 30,830 字符 ≈ 7,708 tok（约 25%）。本插件把这部分变成「默认不可见、
 * 一键恢复」。语义与判据见 `docs/semantic.md`；纪律见 AGENTS.md §5.20。
 *
 * 关键约束：宿主 `ctx.tools.restrict()` 只接受有作用域的 ctx（拒绝进程级收窄，
 * 因为那会掩蔽所有 agent）——因此本插件的正确挂载点是 **agent preset 行**，
 * 收窄天然只作用于挂载该预设的会话。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  auditLine,
  denyFor,
  domainCosts as computeDomainCosts,
  domainCoverage,
  expandPatterns,
  faceCost,
  parseMode,
  planDomain,
} from './logic.ts'
import type { ToolSchemaLike, ToolfaceMode } from './logic.ts'

export const name = 'agent-toolface'

/** 宿主 `tools` 服务的可见面（宽松声明：跨包不 import，避免版本耦合）。 */
export const inject = ['tools'] as const

export interface Config {
  /** 默认档位：lean = 按 deny 收窄；full = 全量可见；domain = 只留常驻 + 当前域。 */
  mode: string
  /** lean 档的 deny 模式：精确工具名或尾随 `*` 的前缀。 */
  deny: string[]
  /** 域定义：域 id → 工具模式（语法同 deny）。`mode=domain` 时生效。 */
  domains: Record<string, string[]>
  /** 常驻模式：任何域下都可见（跨域通用工具）。`mode=domain` 时生效。 */
  resident: string[]
}

export const Config = z.object({
  mode: z.string().default('lean'),
  deny: z.array(z.string()).default([]),
  domains: z.dict(z.array(z.string())).default({}),
  resident: z.array(z.string()).default([]),
})

interface ToolsLike {
  schemas(scope?: unknown): ToolSchemaLike[]
  restrict(filter: { deny?: string[]; allow?: string[] }): () => void
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('agent-toolface')
  const tools = ctx.tools as unknown as ToolsLike

  const initial = parseMode(config.mode)
  if (initial === undefined) {
    throw new Error(
      `dsh-agent-toolface: config.mode 必须是 'lean' 或 'full'，收到 ${JSON.stringify(config.mode)}`,
    )
  }

  const dshHome = process.env['DSH_HOME'] ?? join(process.env['USERPROFILE'] ?? process.cwd(), '.dsh')
  const auditPath = join(dshHome, 'toolface-events.log')

  let mode: ToolfaceMode = initial
  let lift: (() => void) | undefined
  let applied = false
  let reason: string | undefined
  let unmatched: string[] = []
  let denied: string[] = []
  /** 当前开启的域列表（空 = 只常驻）。仅在 mode=domain 时有意义。 */
  // v0.3（2026-11-04）单域 → 多域。实测依据（33 天审计 156 次切换）：域切换约 4.7 次/天，
  // 而「改插件 + 查情报 + 生成素材」这类跨域活只能靠来回切——每切一次都要付一次全量
  // schema 快照（tools.schemas() 对每个工具深克隆 parameters，274 工具 ≈ 8s，2026-09-26 剖面）。
  // 多域让并集一次生效；**不碰 I5**——仍是运行期状态，重启回预设默认，不落盘。
  let currentDomains: string[] = []
  /** 上一行审计的关键字段指纹（除时间戳外）——同状态不重复落盘。 */
  let lastAuditKey = ''

  const writeAudit = async (action: string, face: ToolSchemaLike[]): Promise<void> => {
    try {
      const cost = faceCost(face, denied)
      // 2026-10-03 修复日志爆量：审计关心的是**状态变化**，不是心跳。
      // 实测自激期间该文件涨到 2,311,441 行 / 439 MB（每 ~275 ms 一行，内容完全相同）。
      // 故按「除时间戳外的全部字段」去重——同状态不重复落盘。
      const key = [action, mode, applied, denied.length, face.length, cost.tokens,
        unmatched.join(',')].join('|')
      if (key === lastAuditKey) return
      lastAuditKey = key
      await mkdir(dshHome, { recursive: true })
      await appendFile(
        auditPath,
        auditLine({
          at: new Date().toISOString(),
          action,
          mode,
          applied,
          deniedCount: denied.length,
          globalTools: face.length,
          savedTokens: cost.tokens,
          unmatched,
          ...(reason === undefined ? {} : { reason }),
        }),
        'utf8',
      )
    } catch (err) {
      logger.warn(`审计写入失败: ${(err as Error).message}`)
    }
  }

  /** 先撤销已有收窄，再按目标档位重挂（I2 幂等）。 */
  const applyMode = (
    next: ToolfaceMode,
    override: readonly string[] | undefined,
    action: string,
    domainTargets?: readonly string[] | undefined,
  ): ToolSchemaLike[] => {
    mode = next
    unmatched = []
    denied = []
    applied = false
    reason = undefined

    if (lift !== undefined) {
      try {
        lift()
      } catch (err) {
        logger.warn(`撤销上一条收窄失败: ${(err as Error).message}`)
      }
      lift = undefined
    }

    // 宿主 `tools.schemas()` 每次调用都要对**每个**工具深克隆 parameters
    // （tools.schemaOf → values.snapshotJsonValue，实测 274 工具 ≈ 8s/次，2026-09-26 CPU 剖面）。
    // 因此整个 applyMode 只取**一份**快照，下面全部复用它——这曾在启动路径上被调 5 次，
    // 单次 apply 就烧掉约 40s（冷启 60s 的主因，任务 t-bec5b8b7）。
    const face = tools.schemas()
    const allNames = face.map(s => s.name)

    if (mode === 'domain') {
      // 按域（v0.3 起可多域）：只 deny「被域覆盖 ∧ 非常驻 ∧ 非任一目标域」的工具。
      // 不在任何域里的工具永不被 deny ⇒ 官方基础工具与未归类插件自动常驻（fail-safe）。
      //
      // 失败时**保留原已开域**：在 A 域里误传一个拼错的域名，不该把 A 也弄丢。
      // 这与 planDomain 的「不做半开」是同一取向——宁可维持原状并响亮报错，
      // 也不让状态悄悄变成「什么都没开 / 只开了一半」。
      const previous = currentDomains
      const requested = [...(domainTargets ?? [])]
      const plan = planDomain(allNames, config.domains, config.resident, requested)
      unmatched = plan.unmatched
      if (!plan.known) {
        currentDomains = previous
        const known = Object.keys(config.domains).sort().join(', ')
        const bad = plan.unknownDomains.join(', ')
        reason = `未知域 ${bad}；已配置域：${known === '' ? '（无）' : known}`
        logger.warn(`工具面按域跳过：${reason}`)
      } else {
        currentDomains = requested
        denied = plan.deny
      }
    } else {
      currentDomains = []
      const patterns = denyFor(mode, config.deny, override)
      if (patterns.length > 0) {
        const plan = expandPatterns(patterns, allNames)
        unmatched = plan.unmatched
        denied = plan.matched
        if (plan.matched.length === 0) {
          reason = 'deny 模式全部未命中已知工具'
          logger.warn(`工具面收窄跳过：${reason}（未命中 ${unmatched.join(', ')}）`)
        }
      }
    }

    if (denied.length > 0) {
      try {
        lift = tools.restrict({ deny: denied })
        applied = true
      } catch (err) {
        reason = (err as Error).message
        logger.error(`工具面收窄失败（本会话保持全量可见）: ${reason}`)
      }
    }

    const cost = faceCost(face, denied)
    const domainLabel = currentDomains.length === 0 ? '' : '(' + currentDomains.join(',') + ')'
    logger.info(
      `工具面档位 ${mode}${domainLabel}：`
      + `收窄 ${denied.length} 项（全局面 ${face.length} 个工具），`
      + `applied=${applied}，省约 ${cost.tokens} tok`,
    )
    void writeAudit(action, face)
    return face
  }

  applyMode(mode, undefined, 'load')

  // 补挂：仅当未命中的模式**变少**（说明确有新工具注册进来）时才重试，且次数封顶。
  //
  // ⚠ 2026-10-03 修复自激循环。实测症状：web 进程 34% 单核持续占用（15 秒烧 5.13 CPU 秒）、
  //   审计日志涨到 2,311,441 行 / 439 MB、工具调用后主模型请求长时间无响应（主人从轨迹上看到
  //   「命令 263 ms 完成，之后近 1 分钟没有进入思考状态」）。
  //   根因：原守卫 `unmatched.length === 0` 在本机**恒不成立** —— 配置里的
  //   `sec_*/red_*/blue_*/otw_*/xp_*` 五个模式永远匹配不到工具，unmatched 恒为 5 项。
  //   于是每次 tools/change 都安排 reapply，而 reapply 内的 `lift()/restrict()` 又触发
  //   tools/change ⇒ 每 ~275 ms 自激一轮，每轮一次全量 schema 快照
  //   （宿主对每个工具深克隆 parameters，290 个工具/次，见 applyMode 注释）。
  //   新判据把「未命中恒定」这一真实语义表达出来：没有新工具注册 ⇒ 重试无意义。
  // 启动期各插件连续注册工具会连发 tools/change，逐次 applyMode 等于逐次全量 schema 快照
  // ⇒ 去抖合并成一次（交互式切换走工具入口，不经这里，故不影响响应性）。
  const MAX_REAPPLY = 5
  let reapplyTimer: ReturnType<typeof setTimeout> | undefined
  let reapplyCount = 0
  let lastUnmatchedCount = unmatched.length
  ctx.on('tools/change', () => {
    if (mode === 'full' || unmatched.length === 0) return
    if (unmatched.length >= lastUnmatchedCount) return  // 未命中没变少 ⇒ 无新工具 ⇒ 不重试
    if (reapplyCount >= MAX_REAPPLY) return             // 封顶，防提供方持续抖动
    if (reapplyTimer !== undefined) clearTimeout(reapplyTimer)
    reapplyTimer = setTimeout(() => {
      reapplyTimer = undefined
      if (mode === 'full' || unmatched.length === 0) return
      if (unmatched.length >= lastUnmatchedCount) return
      reapplyCount += 1
      applyMode(mode, undefined, 'reapply', currentDomains)
      lastUnmatchedCount = unmatched.length
    }, 250)
  })

  ctx.tools.register(defineTool({
    name: 'toolface',
    description:
      '工具面分档：查看或切换本会话可见工具的收窄档位，并报告每一档的代价。'
      + 'lean=按 deny 列表收窄；full=全量可见；domain=按域（只留常驻集 + 指定域，不指定则只留常驻）。'
      + 'domain 是**替换**（只开给到的域）；open 是**累加**（并入已开集合，用于一类跨域活要同时用到两类工具时）；'
      + 'close 是移除（不给 name = 清空回只常驻）。'
      + 'status 会报每个域的工具数与 token（切之前先看代价）以及「域外地板」——不在任何域里的工具永不被收窄，'
      + '它决定收窄最多能省多少。'
      + '收窄只作用于本会话（agent 作用域），不影响其他会话或子代理；档位不持久化，重启回到预设默认。'
      + '当某个族的工具在当前会话不可见时，先用它恢复（full / domain / open），再执行任务。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'status=查看当前档位/已开域/各域成本；lean=按 deny 列表收窄；'
          + 'full=恢复全量可见；domain=替换为给定域（不给 name 则只留常驻集）；'
          + 'open=累加开启（保留已开域）；close=关闭给定域（不给 name 则全部关闭）',
      },
      deny: {
        type: 'array',
        items: { type: 'string' },
        description: 'lean 时覆盖配置的 deny 模式（精确工具名或尾随 * 的前缀），仅本次会话有效',
      },
      name: {
        // ⚠ 保持 string 而非 array：宿主按 parameters schema **严格校验**参数，
        // 把类型改成 array 会让既有的 `name: "quant"` 调用直接 INVALID_ARGS
        // （2026-11-04 实测：`"name" must be an array`）——那是破坏兼容，不是新能力。
        // 多域改用逗号分隔（SQL 式习惯，零破坏）：name: "cleanup,security"。
        type: 'string',
        description: 'domain/open/close 要操作的域 id；多个用英文逗号分隔（如 "cleanup,security"）。'
          + 'domain 省略=只留常驻集、close 省略=全部关闭。各域成本见 status 的 domainCosts',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          domain: { type: 'string' },
          openDomains: { type: 'array', items: { type: 'string' }, required: true },
          domains: { type: 'array', items: { type: 'string' }, required: true },
          domainCosts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                tools: { type: 'number', required: true },
                tokens: { type: 'number', required: true },
              },
            },
          },
          outside: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tools: { type: 'number', required: true },
              tokens: { type: 'number', required: true },
            },
          },
          applied: { type: 'boolean', required: true },
          deniedCount: { type: 'number', required: true },
          globalTools: { type: 'number', required: true },
          savedChars: { type: 'number', required: true },
          savedTokens: { type: 'number', required: true },
          unmatched: { type: 'array', items: { type: 'string' }, required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const r = value as {
          mode?: string
          domain?: string
          openDomains?: string[]
          domains?: string[]
          domainCosts?: Array<{ id?: string; tools?: number; tokens?: number }>
          outside?: { tools?: number; tokens?: number }
          applied?: boolean
          deniedCount?: number
          globalTools?: number
          savedChars?: number
          savedTokens?: number
          unmatched?: string[]
          reason?: string
        }
        const total = r.globalTools ?? 0
        const openList = Array.isArray(r.openDomains)
          ? r.openDomains
          : (r.domain === undefined ? [] : [r.domain])
        const lines: string[] = []
        if (r.mode === 'full') {
          lines.push(`工具面 [full] 全局面 ${total} 个工具可见（收窄已解除）`)
        } else {
          const tag = r.mode === 'domain'
            ? (openList.length === 0 ? 'domain·仅常驻' : 'domain: ' + openList.join('+'))
            : 'lean'
          lines.push(
            `工具面 [${tag}] 收窄 ${r.deniedCount ?? 0} 个工具（全局面 ${total} 个），`
            + `省约 ${r.savedTokens ?? 0} tok（${r.savedChars ?? 0} 字符）`,
          )
          if (r.applied === false) lines.push(`· 收窄未生效：${r.reason ?? '未知原因'}`)
        }
        // 域外地板：收窄能省多少的上限由它决定（域外工具永不被 deny，见 I9 ③）。
        if (r.mode === 'domain' && r.outside !== undefined) {
          lines.push(
            `· 域外地板：${r.outside.tools ?? 0} 个工具 / ${r.outside.tokens ?? 0} tok（永不被收窄）`,
          )
        }
        const costs = Array.isArray(r.domainCosts) ? r.domainCosts : []
        if (costs.length > 0) {
          // 域成本让「切之前先知道代价」成为可能；已开的标 ·已开，省得再回头查 status。
          const openSet = new Set(openList)
          const shown = costs.slice(0, 10).map(c => {
            const id = c.id ?? '?'
            return id + '(' + (c.tools ?? 0) + '/' + (c.tokens ?? 0)
              + (openSet.has(id) ? '·已开' : '') + ')'
          })
          lines.push(
            `· 域成本（${costs.length} 个，降序）：` + shown.join(' · ')
            + (costs.length > 10 ? ' …还有 ' + (costs.length - 10) + ' 个' : ''),
          )
        } else if (Array.isArray(r.domains) && r.domains.length > 0) {
          lines.push(`· 可用域（${r.domains.length}）：${r.domains.join(', ')}`)
        }
        if (Array.isArray(r.unmatched) && r.unmatched.length > 0) {
          lines.push(`· 未匹配模式：${r.unmatched.join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { action?: unknown; deny?: unknown; name?: unknown }
      const action = typeof input.action === 'string' ? input.action : 'status'
      const override = Array.isArray(input.deny)
        ? input.deny.filter((v): v is string => typeof v === 'string')
        : undefined
      // `name` 接受单字符串或字符串数组（多域一次给全）；空白项丢弃。
      // 逗号分隔支持多域（schema 声明是 string，见 parameters.name 的注释）；
      // 数组分支保留给「绕过 schema 直接调 execute」的场合。
      const rawNames = Array.isArray(input.name)
        ? input.name.filter((v): v is string => typeof v === 'string')
        : (typeof input.name === 'string' ? input.name.split(',') : [])
      const domainNames = [...new Set(rawNames.map(n => n.trim()).filter(n => n !== ''))]
      const knownDomains = Object.keys(config.domains).sort()

      // 同一请求只取一份 schema 快照（宿主每次调用都对全部工具深克隆，见 applyMode 注释）。
      let face: ToolSchemaLike[]
      if (action === 'lean' || action === 'full') {
        face = applyMode(action, override, action)
      } else if (action === 'domain') {
        // 替换语义（v0.2 行为不变）：只开给定的这些域；不给 name = 只常驻。
        const auditAction = domainNames.length === 0 ? 'domain' : 'domain:' + domainNames.join('+')
        face = applyMode('domain', undefined, auditAction, domainNames)
      } else if (action === 'open') {
        // 累加语义（v0.3 新增）：把给定域并入已开集合；已全在集合里 ⇒ 幂等不重挂（I2）。
        if (domainNames.length === 0) {
          face = tools.schemas()
          return {
            ok: false,
            mode,
            openDomains: [...currentDomains],
            domains: knownDomains,
            applied,
            deniedCount: denied.length,
            globalTools: face.length,
            savedChars: 0,
            savedTokens: 0,
            unmatched,
            reason: 'action=open 需要 name（要开启的域 id）；回到「只常驻」请用 action=domain 不带 name',
          }
        }
        const merged = [...new Set([...currentDomains, ...domainNames])]
        face = merged.length === currentDomains.length
          ? tools.schemas()
          : applyMode('domain', undefined, 'open:' + domainNames.join('+'), merged)
      } else if (action === 'close') {
        // 移除语义（v0.3 新增）：不给 name = 清空全部域（回到只常驻）。
        const remain = domainNames.length === 0
          ? []
          : currentDomains.filter(d => !domainNames.includes(d))
        const isNoop = domainNames.length === 0
          ? currentDomains.length === 0
          : remain.length === currentDomains.length
        const auditAction = domainNames.length === 0 ? 'close-all' : 'close:' + domainNames.join('+')
        face = isNoop
          ? tools.schemas()
          : applyMode('domain', undefined, auditAction, remain)
      } else if (action !== 'status') {
        face = tools.schemas()
        return {
          ok: false,
          mode,
          openDomains: [...currentDomains],
          domains: knownDomains,
          applied,
          deniedCount: denied.length,
          globalTools: face.length,
          savedChars: 0,
          savedTokens: 0,
          unmatched,
          reason: '未知 action "' + action + '"：只接受 status / lean / full / domain / open / close',
        }
      } else {
        face = tools.schemas()
      }

      const cost = faceCost(face, denied)
      // 域成本与地板只在 domain 档有意义（lean/full 下域不参与决策，算了也是浪费）。
      const costs = mode === 'domain' ? computeDomainCosts(face, config.domains) : undefined
      const coverage = mode === 'domain' ? domainCoverage(face, config.domains) : undefined
      return {
        ok: true,
        mode,
        // `domain` 保留为「第一个已开域」以兼容旧读者；完整列表在 `openDomains`。
        ...(currentDomains.length === 0 ? {} : { domain: currentDomains[0] }),
        openDomains: [...currentDomains],
        domains: knownDomains,
        ...(costs === undefined ? {} : { domainCosts: costs }),
        ...(coverage === undefined
          ? {}
          : { outside: { tools: coverage.outside, tokens: coverage.outsideTokens } }),
        applied,
        deniedCount: denied.length,
        globalTools: face.length,
        savedChars: cost.chars,
        savedTokens: cost.tokens,
        unmatched,
        ...(reason === undefined ? {} : { reason }),
      }
    },
  }))
}

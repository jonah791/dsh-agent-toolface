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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  auditLine,
  denyFor,
  domainCosts as computeDomainCosts,
  domainCoverage,
  expandPatterns,
  faceCost,
  indexLine,
  parseMode,
  planDomain,
} from './logic.ts'
import type { ToolSchemaLike, ToolfaceMode } from './logic.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'agent-toolface'

/** 工具域索引注入行的 source kind（模型可见 ⟺ 已记录）。 */
export const INDEX_SOURCE_KIND = 'toolface-index'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'toolface-index': { kind: 'toolface-index' }
  }
}

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
  /**
   * 恒定 schema（v0.4，2026-11-09 主人定调「只注入变更」）。
   *
   * true = 运行时**从不**调用 `tools.restrict()`：可见工具集在会话内恒定，
   * 开关改为「执行前门禁 + 工具返回值里的变更说明」，两者都不进请求前缀。
   * false（默认）= 旧行为（每次开关都重挂收窄，会让缓存前缀整条作废）。
   *
   * 为什么需要它：`tools` 数组位于缓存前缀最前面，改一个字节 ⇒ 整条前缀重算。
   * 2026-11-09 实测（会话 3e786db2 / 474 次请求）：短间隔 ≤120 秒里命中率 <50% 的
   * 16 条，16/16 都紧跟在工具面变化之后；单次代价 8 万–38 万 tokens。
   *
   * ⚠ 默认 false 是**兼容决定**：其他挂载本插件的预设不该被静默换掉收窄语义。
   * 要用恒定 schema 的预设显式写 `sticky: true`。
   */
  sticky: boolean
  /**
   * 恒定工具面（v0.6，2026-11-09）：`mode=domain` 时**不收窄**——工具清单一个字节都不动，
   * 开域只把「这批可用」记进状态。域内工具以 `deferLoading` 声明常驻，因此清单恒定、
   * 请求前缀稳定，开/关域都不再触发整段重算。
   *
   * ⚠ 默认 false 是**兼容决定**：其他挂载本插件的预设仍走「收窄」语义。
   */
  constantFace: boolean
  /**
   * 每步注入一行「工具域索引」（v0.7，2026-11-12 事故驱动）。
   *
   * 事故：我对主人断言「库里没有删除工具」，而 `memory_merge` 一直在档案里——
   * 记忆工具按 `deferLoading` 声明成「按名调用、不占 schema」，于是**不在手边**
   * 被我读成了**不存在**（指路牌 `tool_find` 当天还因整串匹配回了「无命中」）。
   *
   * 取舍：一行索引 ≈ 一百多 token/步，覆盖全部工具；把同样这些工具常驻要两三万
   * token/步，而且仍只是子集。**常驻目录，不常驻工具。**
   *
   * ⚠ 默认 false 是**兼容决定**：注入会进请求前缀，不该由本插件替其他预设决定。
   */
  indexLine: boolean
  /** 索引里最多列几个域（其余折成「还有 N 域」，缺省 12）。 */
  indexLineMax: number
}

export const Config = z.object({
  mode: z.string().default('lean'),
  deny: z.array(z.string()).default([]),
  domains: z.dict(z.array(z.string())).default({}),
  resident: z.array(z.string()).default([]),
  sticky: z.boolean().default(false),
  constantFace: z.boolean().default(false),
  indexLine: z.boolean().default(false),
  indexLineMax: z.number().default(12),
})

interface ToolDefinitionLike {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

interface ToolsLike {
  schemas(scope?: unknown): ToolSchemaLike[]
  restrict(filter: { deny?: string[]; allow?: string[] }): () => void
  /** 执行前门禁：返回原因即拒调。不参与请求前缀（宿主 `notify: false`）。 */
  guard?(guard: (execution: { name?: unknown }) => string | undefined): () => void
  /**
   * 按名取工具定义。**省略 scope 即全局视图**（宿主 JSDoc：「omitted = the global view」），
   * 因此 agent 作用域 restrict 掉的工具在这里依然取得到——这是按需执行通道的依据
   * （收窄只过滤 agent 视图，不注销注册；2026-11-09 读 tools/src/index.ts:1186-1226 确认）。
   */
  get?(name: string, scope?: unknown): ToolDefinitionLike | undefined
}

/** 技能库根目录：道具声明住在技能里，这是它的真源。 */
function skillRoots(): string[] {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  return [join(home, '.agents', 'skills'), join(process.env['DSH_HOME'] ?? '', 'skills')]
}

/**
 * 读技能目录里的 `tools.yml`：每个技能声明它拥有哪些工具模式。
 *
 * 为什么搬到这里（2026-11-09 主人定调「工具和技能密不可分」）：域配置原先住在
 * cordis.yml，技能住在另一个目录，两边各说各话 —— 于是「读一个技能」不会带来它的道具，
 * 还得手工 open 一个名字未必对得上的域。道具搬进技能目录后，读技能 = 拿到手脚，
 * 知识、道具、用法在同一处。cordis.yml 的 domains 保留为兜底（未搬的域照旧生效）。
 * @param roots - 技能库根目录，按顺序读，先读到的技能优先。
 * @returns 技能 id → 工具模式数组；没有 tools.yml 的技能不出现在结果里。
 */
function loadSkillToolDomains(roots: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const root of roots) {
    if (root === '') continue
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || out[entry.name] !== undefined) continue
      let raw: string
      try { raw = readFileSync(join(root, entry.name, 'tools.yml'), 'utf8') } catch { continue }
      const patterns: string[] = []
      let inTools = false
      for (const line of raw.split(String.fromCharCode(10)).map(l => l.trimEnd())) {
        if (/^tools:\s*$/.test(line)) { inTools = true; continue }
        if (!inTools) continue
        const hit = /^\s*-\s*(.+?)\s*$/.exec(line)
        if (hit === null) { if (/^\S/.test(line)) inTools = false; continue }
        patterns.push((hit[1] ?? '').replace(/^['"]|['"]$/g, ''))
      }
      if (patterns.length > 0) out[entry.name] = patterns
    }
  }
  return out
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('agent-toolface')
  const tools = ctx.tools as unknown as ToolsLike
  // 技能目录优先：技能自带的 tools.yml 覆盖同名的 cordis.yml 域，未搬的域继续走配置。
  const domains: Record<string, string[]> = { ...config.domains, ...loadSkillToolDomains(skillRoots()) }

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
  /**
   * 单独放行的具体工具名（会话级，不落盘）。
   *
   * 主人 2026-11-09 定调：**按需取用某个具体的工具，而不是开一整个域**。
   * 开一个域是 30–45 个 schema 全进来，实际往往只用其中 1–2 个。
   * 实现是把这些名字从 deny 里剔除（deny 是「不可见清单」，拿掉谁谁就可见），
   * 所以 pick 的粒度就是 1 个工具，代价也就是那 1 个工具。
   */
  const pinned = new Set<string>()
  /** 上次 applyMode 时的全局工具数。 */
  // 2026-11-04（主人批准）：补挂的**第二个正当理由**是「工具数变多」。
  // 线上实测 load 瞬间 tools.schemas() 只有 329 个（插件没注册完）、稳定后 440 个，
  // 而 deny 是按快照算的 ⇒ 19 个该收窄的工具一直可见（白占 2,554 tok/轮）。
  // 旧守卫 `unmatched.length === 0` 在域模式下恒成立 ⇒ 永不重挂 ⇒ 缺口永久存在。
  // ⚠ 声明必须在 applyMode 之前：load 会立即调用它（否则撞 TDZ）。
  let lastToolCount = 0
  /**
   * 历史见过的全部工具名。
   *
   * ⚠ 为什么 deny 的基础不能只用 `tools.schemas()` 的当次结果（2026-11-09 实测）：
   * 收窄会缩小 visible ⇒ 下一次重算拿到的快照更小 ⇒ deny 随之萎缩（越算越松）。
   * 症状：重启后常驻集从 116 涨到 169（新注册的 eac_/remote_ 等永远进不了 deny），
   * 手动切一次档才回落到 116。
   * `restrict()` 的 known 检查走 restrictableNames（含已被收窄的名字），
   * 所以累积下来的旧名字仍然可以被 deny。
   */
  const seenNames = new Set<string>()
  /** 重入闸：applyMode 内部的 restrict() 会触发 tools/change，不设闸就是自激的引信。 */
  let applying = false
  /** 上一行审计的关键字段指纹（除时间戳外）——同状态不重复落盘。 */
  let lastAuditKey = ''
  /**
   * 工具域索引一行：只在工具名集合变化后重算，其余每步复用缓存。
   *
   * 为什么缓存：`domainCosts` 那条路要读 schema（对每个工具深克隆 parameters，274 工具 ≈ 8s），
   * 而索引只需要名字——名字集合 `seenNames` 已经是累积的，重算只是几十次子串匹配。
   */
  let indexCached = ''
  let indexDirty = true

  // ── v0.4 恒定 schema 的门禁状态 ─────────────────────────────────────────────
  // 开关不再改「可见工具集」（那会改请求头的 tools 数组 ⇒ 整条前缀作废），
  // 改为维护一个「被门禁拒绝」的集合；门禁在工具体之前求值，不进请求前缀。
  /** 当前被门禁拒绝的工具名。 */
  let gatedSet = new Set<string>()
  /** 上一轮门禁集——用来算「本次变更」。 */
  let previousGated = new Set<string>()
  /** 本次调用的变更增量（写进工具返回值，不新建任何注入）。 */
  let nowAvailable: string[] = []
  let nowGated: string[] = []
  /** 工具 → 覆盖它的域（门禁报错时说清「该开哪个域」）。 */
  let owningDomains = new Map<string, string[]>()
  let gateLift: (() => void) | undefined
  /** 永不被门禁：本工具自身是逃生门，`tool_call` 是按需执行通道，`run_code` 是宿主保留的呈现层传输名。 */
  const GATE_EXEMPT = new Set(['toolface', 'tool_call', 'run_code'])

  const buildOwningDomains = (allNames: readonly string[]): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    for (const [id, patterns] of Object.entries(domains)) {
      for (const hit of expandPatterns(patterns, allNames).matched) {
        const prev = map.get(hit)
        if (prev === undefined) map.set(hit, [id])
        else if (!prev.includes(id)) prev.push(id)
      }
    }
    return map
  }

  /**
   * 重挂执行前门禁。
   *
   * 宿主在 `tools/pre-execute` 瀑布之后、工具体之前求值它，返回原因即拒；注册时
   * `notify: false`（`tools/src/index.ts:1144`）⇒ **不触发 tools/change、不进请求前缀**。
   * 这是「开关」唯一不付缓存代价的挂点：拒调发生在请求已经发完之后。
   */
  const applyGate = (): void => {
    if (gateLift !== undefined) {
      try {
        gateLift()
      } catch (err) {
        logger.warn(`撤销旧门禁失败: ${(err as Error).message}`)
      }
      gateLift = undefined
    }
    const guard = tools.guard
    if (guard === undefined) {
      if (gatedSet.size > 0) {
        logger.warn('宿主无 tools.guard()：sticky 下门禁不可用，被门禁的工具实际仍可调用')
      }
      return
    }
    if (gatedSet.size === 0) return
    gateLift = guard((execution) => {
      const n = execution.name
      // 门禁热路径：先查集合，再做任何字符串工作。
      if (typeof n !== 'string' || GATE_EXEMPT.has(n) || !gatedSet.has(n)) return undefined
      const owned = owningDomains.get(n)
      const where = owned === undefined || owned.length === 0 ? '未归类域' : owned.join(' / ')
      const openCmd = owned === undefined || owned.length === 0
        ? ''
        : `需要时先调 toolface({action:"open", name:"${owned[0]}"})；`
      return `工具 "${n}" 属域 [${where}]，本会话当前未开启。${openCmd}`
        + `当前已开域：${currentDomains.length === 0 ? '（仅常驻）' : currentDomains.join(', ')}。`
        + `（这是门禁拒绝，不是能力缺失——工具定义始终在上下文里，开关不会破坏缓存。）`
    })
  }

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
    applying = true
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
    for (const name of allNames) seenNames.add(name)
    indexDirty = true
    /** deny 的作用域：累积名（只增不减），而不是当次快照——见 seenNames 的注释。 */
    const denyable = [...seenNames]

    if (mode === 'domain') {
      // 按域（v0.3 起可多域）：只 deny「被域覆盖 ∧ 非常驻 ∧ 非任一目标域」的工具。
      // 不在任何域里的工具永不被 deny ⇒ 官方基础工具与未归类插件自动常驻（fail-safe）。
      //
      // 失败时**保留原已开域**：在 A 域里误传一个拼错的域名，不该把 A 也弄丢。
      // 这与 planDomain 的「不做半开」是同一取向——宁可维持原状并响亮报错，
      // 也不让状态悄悄变成「什么都没开 / 只开了一半」。
      const previous = currentDomains
      const requested = [...(domainTargets ?? [])]
      const plan = planDomain(denyable, domains, config.resident, requested)
      unmatched = plan.unmatched
      if (!plan.known) {
        currentDomains = previous
        const known = Object.keys(domains).sort().join(', ')
        const bad = plan.unknownDomains.join(', ')
        reason = `未知域 ${bad}；已配置域：${known === '' ? '（无）' : known}`
        logger.warn(`工具面按域跳过：${reason}`)
      } else {
        currentDomains = requested
        // 恒定工具面：清单一个字节都不动（域内工具以 deferLoading 声明常驻）⇒ 前缀稳定。
        denied = config.constantFace === true ? [] : plan.deny
      }
    } else {
      currentDomains = []
      const patterns = denyFor(mode, config.deny, override)
      if (patterns.length > 0) {
        const plan = expandPatterns(patterns, denyable)
        unmatched = plan.unmatched
        denied = plan.matched
        if (plan.matched.length === 0) {
          reason = 'deny 模式全部未命中已知工具'
          logger.warn(`工具面收窄跳过：${reason}（未命中 ${unmatched.join(', ')}）`)
        }
      }
    }

    // 单工具放行：被 pick 的名字从 deny 里剔除 ⇒ 在本档位下可见。
    // 放在 sticky 判断之前，两条路径（restrict / 门禁）都吃到同一份 denied。
    if (pinned.size > 0 && denied.length > 0) {
      denied = denied.filter(name => !pinned.has(name))
    }

    if (config.sticky) {
      // 恒定 schema（v0.4）：**这里不调 restrict**。工具面一变，请求头的 tools 数组就变，
      // 而 tools 位于缓存前缀最前面 ⇒ 整条前缀作废（2026-11-09 实测：单次 8 万–38 万 tokens，
      // 短间隔 16/16 整轮未命中全跟在工具面变化之后）。开关改走 applyGate()。
      applied = false
      owningDomains = buildOwningDomains(allNames)
      gatedSet = new Set(denied.filter(n => !GATE_EXEMPT.has(n)))
      applyGate()
    } else if (denied.length > 0) {
      gatedSet = new Set()
      try {
        lift = tools.restrict({ deny: denied })
        applied = true
      } catch (err) {
        // 累积集里的名字可能已被卸载（插件卸载会注销工具）。剔掉再试一次——
        // 否则这一条错误会让收窄**永久**失效（每轮都失败），失效形态是静默降级到全量可见。
        const message = (err as Error).message
        const stale = [...message.matchAll(/"([^"]+)"/g)]
          .map(hit => hit[1] ?? '')
          .filter(name => seenNames.has(name))
        if (stale.length > 0) {
          for (const name of stale) seenNames.delete(name)
          const keep = new Set(denied.filter(name => !stale.includes(name)))
          logger.warn(`剔除已卸载的工具名 ${stale.length} 个后重试收窄: ${stale.join(', ')}`)
          try {
            lift = tools.restrict({ deny: [...keep] })
            applied = true
          } catch (retryErr) {
            reason = (retryErr as Error).message
            logger.error(`工具面收窄失败（本会话保持全量可见）: ${reason}`)
          }
        } else {
          reason = message
          logger.error(`工具面收窄失败（本会话保持全量可见）: ${reason}`)
        }
      }
    }

    // 变更增量：写进工具返回值（追加，不进前缀），不新建任何注入通道。
    nowAvailable = [...previousGated].filter(n => !gatedSet.has(n)).sort()
    nowGated = [...gatedSet].filter(n => !previousGated.has(n)).sort()
    previousGated = new Set(gatedSet)

    const cost = faceCost(face, denied)
    const domainLabel = currentDomains.length === 0 ? '' : '(' + currentDomains.join(',') + ')'
    logger.info(
      config.sticky
        ? `工具面档位 ${mode}${domainLabel}：schema 恒定（${face.length} 个工具始终可见），`
          + `门禁 ${gatedSet.size} 项，本次变更 +${nowAvailable.length}/-${nowGated.length}`
        : `工具面档位 ${mode}${domainLabel}：`
          + `收窄 ${denied.length} 项（全局面 ${face.length} 个工具），`
          + `applied=${applied}，省约 ${cost.tokens} tok`,
    )
    void writeAudit(action, face)
    lastToolCount = face.length
    applying = false
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
  const MAX_REAPPLY = 12
  /** 连续「无进展」几次才关闸。2 是给启动期**分批注册**留的容错轮次（见下方关闸注释）。 */
  const MAX_EMPTY_REAPPLY = 2
  let reapplyTimer: ReturnType<typeof setTimeout> | undefined
  let reapplyCount = 0
  let emptyReapply = 0
  let lastUnmatchedCount = unmatched.length
  ctx.on('tools/change', () => {
    // 旧判据只有「unmatched 变少」，它挡掉了 legit 的工具增长场景；新判据把
    // 「工具数是否变多」也纳入，但**必须在重算后才知道**（schemas() 很贵且是唯一真源），
    // 所以这里改成「先重算一次，再用结果决定要不要继续」——关闸条件见下。
    if (applying || mode === 'full') return
    // lean 档保持 2026-10-03 的原判据不变：它的「启动期快照不全」缺陷今天**没有被
    // 实测证明**（实测的是 domain 档的 329 vs 440），不动没被证明有问题的地方。
    // 这条分支也是那条自激回归测试的锚点，别顺手合并掉。
    if (mode === 'lean') {
      if (unmatched.length === 0) return
      if (unmatched.length >= lastUnmatchedCount) return
    }
    if (reapplyCount >= MAX_REAPPLY) return             // 封顶，防提供方持续抖动
    if (reapplyTimer !== undefined) clearTimeout(reapplyTimer)
    reapplyTimer = setTimeout(() => {
      reapplyTimer = undefined
      if (applying || mode === 'full') return
      if (reapplyCount >= MAX_REAPPLY) return
      const beforeToolCount = lastToolCount
      const beforeUnmatched = lastUnmatchedCount
      reapplyCount += 1
      applyMode(mode, undefined, 'reapply', currentDomains)
      // 「有进展」= 工具数涨了 **或** 未命中数变少了。有进展就重置空转计数、继续跟；
      // 连续 MAX_EMPTY_REAPPLY 次无进展才关闸。
      // ⚠ 为什么不是「一次无进展就关闸」（v0.3.0 初版实测踩到）：启动期工具是**分批**
      // 注册的——第一次补挂时工具数只涨了 2 个（实测 deny 280→282，而正确值是 299），
      // 紧接着那次 restrict 自身触发的 change 被判「无进展」⇒ 立刻关闸 ⇒ 后面 158 个
      // 工具的注册全被忽略。给一轮容错，分批注册才跟得完。
      // ⚠ 防自激仍有界：restrict→change→reapply 的自激每轮都「无进展」，
      // 连续 2 次即关闸 ⇒ 最坏多算 2 次（远好过 2026-10-03 的每 ~275ms 一轮）。
      const progressed = lastToolCount > beforeToolCount || unmatched.length < beforeUnmatched
      emptyReapply = progressed ? 0 : emptyReapply + 1
      lastUnmatchedCount = unmatched.length
      if (emptyReapply >= MAX_EMPTY_REAPPLY) reapplyCount = MAX_REAPPLY
    }, 250)
  })

  // ── 按需取用（v0.4 · 2026-11-09 主人定调）────────────────────────────────────
  // 「技能域才是身体，常驻工具是条件反射，其余是道具。」——道具不该绑在身上，但也不该
  // 靠「我记得先 open」来取（那是纪律，不是机制）。域 id 与技能 id 对齐是既有口径，
  // 所以「加载技能 X」与「开启域 X」本是同一件事：技能内容进尾部（回忆），道具进手边。
  // 这里把两者耦合：调 skill 时解析技能 id，若存在同名域且未开启 ⇒ 自动 open。
  // 代价与手动 open 相同（一次全量 schema 重算），但从此只发生在**有意识的动作**之后。
  // ⚠ 不递归：applyMode 内部的 applying 闸已挡掉 restrict→tools/change 自激。
  ctx.on('session/event', (_session, event) => {
    const ev = event as unknown as {
      type?: string
      data?: { name?: string; arguments?: unknown }
    }
    if (ev.type !== 'tool/call' || ev.data?.name !== 'skill') return
    const raw = ev.data?.arguments
    if (typeof raw !== 'string') return
    let skillId: string | undefined
    try {
      const parsed = JSON.parse(raw) as { name?: unknown }
      if (typeof parsed.name === 'string') skillId = parsed.name.trim()
    } catch {
      return   // 参数不是 JSON（正常路径也偶发流式半截）⇒ 静默跳过，取用不成就走手动 open
    }
    if (skillId === undefined || skillId === '') return
    if (mode !== 'domain' || currentDomains.includes(skillId)) return
    if (domains[skillId] === undefined) return   // 技能在身体里但没配道具 ⇒ 什么都不做
    const merged = [...currentDomains, skillId]
    setImmediate(() => {
      try {
        applyMode('domain', undefined, 'auto-skill:' + skillId, merged)
        logger.info(`按需取用：加载技能 ${skillId} ⇒ 自动开启同名域`)
      } catch (err) {
        logger.warn(`技能自动取用失败（${skillId}）: ${(err as Error).message}`)
      }
    })
  })

  ctx.tools.register(defineTool({
    name: 'toolface',
    description:
      '工具面分档：查看或切换本会话可见工具的收窄档位，并报告每一档的代价。'
      + 'lean=按 deny 列表收窄；full=全量可见；domain=按域（只留常驻集 + 指定域，不指定则只留常驻）。'
      + 'domain 是**替换**（只开给到的域）；open 是**累加**（并入已开集合，用于一类跨域活要同时用到两类工具时）；'
      + 'close 是移除（不给 name = 清空回只常驻）。'
      + '**pick / unpick 是单工具粒度**：只放行「具体某一个工具」（name=工具名，逗号分隔），不动整个域——'
      + '开一个域是 30–45 个 schema 全进来，实际往往只用 1–2 个；pick 的代价就是那 1–2 个。'
      + '⚠ full 会被直接拒绝，除非带 reason——除特殊情况不要开 full，优先 pick 具体工具、其次 open 必要的域。'
      + 'status 会报每个域的工具数与 token（切之前先看代价）以及「域外地板」——不在任何域里的工具永不被收窄，'
      + '它决定收窄最多能省多少。'
      + '收窄只作用于本会话（agent 作用域），不影响其他会话或子代理；档位不持久化，重启回到预设默认。'
      + '⚠ sticky 档（恒定 schema）：工具定义始终可见，但**未开启域的工具调用会被门禁拒绝**——'
      + '被拒时不要以为能力缺失，按报错提示 open 对应域即可；开关不破坏缓存，随时可切。'
      + '当某个族的工具报「未开启域」时，先用 open 开启它，再执行任务。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'status=查看当前档位/已开域/各域成本；lean=按 deny 列表收窄；'
          + 'pick=按需放行具体工具（推荐，name 填工具名）；unpick=收回；'
          + 'domain=替换为给定域（不给 name 则只留常驻集）；'
          + 'open=累加开启（保留已开域）；close=关闭给定域（不给 name 则全部关闭）；'
          + 'full=恢复全量可见（必须带 reason，除特殊情况禁用）',
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
          + 'domain 省略=只留常驻集、close 省略=全部关闭。各域成本见 status 的 domainCosts。'
          + 'pick/unpick 时这里是**具体工具名**（逗号分隔，如 "comfy_submit,comfy_status"）',
      },
      reason: {
        type: 'string',
        description: 'action=full 时**必填**：为什么必须全量可见（主人 2026-11-09：除特殊情况禁止开 full）。'
          + '缺这个字段的 full 请求会被直接拒绝，不执行。',
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
              // ⚠ 每个字段都必须在这里声明：宿主按 `additionalProperties: false` 校验返回值，
              // 多返回一个未声明字段会让**整个工具调用失败**（不是被裁剪）。
              // 2026-11-04 实测踩到：返回了 chars 但没声明 ⇒ `"value.domainCosts[0].chars"
              // is not a declared property`，status 直接不可用。测试当时只断言字段类型，
              // 没跑 output schema 校验 ⇒ 测试绿而线上红。已补 schema-parity 用例。
              properties: {
                id: { type: 'string', required: true },
                tools: { type: 'number', required: true },
                chars: { type: 'number', required: true },
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
          /** v0.4：true = schema 恒定、开关走门禁（不破坏缓存前缀）。 */
          sticky: { type: 'boolean' },
          /** v0.4：当前被门禁拒绝的工具数（不进上下文，只是调用被拒）。 */
          gatedCount: { type: 'number' },
          /** 本次调用新增可用的工具名（追加在返回值里，不进前缀）。 */
          nowAvailable: { type: 'array', items: { type: 'string' } },
          /** 本次调用转为门禁的工具名。 */
          nowGated: { type: 'array', items: { type: 'string' } },
          deniedCount: { type: 'number', required: true },
          globalTools: { type: 'number', required: true },
          savedChars: { type: 'number', required: true },
          savedTokens: { type: 'number', required: true },
          unmatched: { type: 'array', items: { type: 'string' }, required: true },
          reason: { type: 'string' },
          /** v0.5：当前被单独放行的具体工具名（单工具粒度，见 pick/unpick）。 */
          picked: { type: 'array', items: { type: 'string' } },
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
          sticky?: boolean
          gatedCount?: number
          nowAvailable?: string[]
          nowGated?: string[]
          deniedCount?: number
          globalTools?: number
          savedChars?: number
          savedTokens?: number
          unmatched?: string[]
          reason?: string
          ok?: boolean
          picked?: string[]
        }
        const total = r.globalTools ?? 0
        const openList = Array.isArray(r.openDomains)
          ? r.openDomains
          : (r.domain === undefined ? [] : [r.domain])
        const lines: string[] = []
        // ⚠ ok=false 时第一行必须是拒绝原因：否则 render 只印档位行，
        // 我会把一次「没执行」读成「执行了」（2026-11-09 实测：full 被拒后只显示档位行，
        // 看不出拒绝，还以为切了）。
        if (r.ok === false) {
          lines.push('✖ 未执行：' + (r.reason ?? '（无原因）'))
        }
        if (r.mode === 'full') {
          lines.push(`工具面 [full] 全局面 ${total} 个工具可见（收窄已解除）`)
        } else if (r.sticky === true) {
          const tag = r.mode === 'domain'
            ? (openList.length === 0 ? 'domain·仅常驻' : 'domain: ' + openList.join('+'))
            : 'lean'
          lines.push(`工具面 [${tag}] schema 恒定：${total} 个工具始终可见（开关不改前缀）`)
          lines.push(
            `· 门禁 ${r.gatedCount ?? r.deniedCount ?? 0} 个工具当前不可调用`
            + `（它们仍在上下文里，只是调用会被拒——省掉的是每次切换的全量重算）`,
          )
          if (r.reason !== undefined) lines.push(`· 注意：${r.reason}`)
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
        // v0.4 变更增量：这是「只注入变更」的落点——它就是工具返回值的一部分，
        // 天然追加进历史、不进请求前缀，不需要任何新的注入通道。
        const added = Array.isArray(r.nowAvailable) ? r.nowAvailable : []
        const gatedNow = Array.isArray(r.nowGated) ? r.nowGated : []
        if (added.length > 0 || gatedNow.length > 0) {
          const brief = (list: string[]): string =>
            list.slice(0, 10).join(', ') + (list.length > 10 ? ` …共 ${list.length} 个` : '')
          const parts: string[] = []
          if (added.length > 0) parts.push(`新增可用 ${added.length} 个：${brief(added)}`)
          if (gatedNow.length > 0) parts.push(`转为门禁 ${gatedNow.length} 个：${brief(gatedNow)}`)
          lines.push('· 本次变更：' + parts.join('；'))
        }
        // 域外地板：收窄能省多少的上限由它决定（域外工具永不被 deny，见 I9 ③）。
        if (r.mode === 'domain' && r.outside !== undefined) {
          lines.push(
            `· 域外地板：${r.outside.tools ?? 0} 个工具 / ${r.outside.tokens ?? 0} tok（永不被收窄）`,
          )
        }
        const pickedList = Array.isArray(r.picked) ? r.picked : []
        if (pickedList.length > 0) {
          lines.push(
            `· 单独放行 ${pickedList.length} 个（pick 单工具粒度，不占整域）：${pickedList.join(', ')}`,
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
      const knownDomains = Object.keys(domains).sort()

      // 同一请求只取一份 schema 快照（宿主每次调用都对全部工具深克隆，见 applyMode 注释）。
      let face: ToolSchemaLike[]
      if (action === 'lean' || action === 'full') {
        // 主人 2026-11-09：**除特殊情况禁止开 full**。
        // 做成机制而不是记性：没有 reason 的 full 直接拒绝，不给「顺手开一下」留路径。
        const fullWhy = typeof (args as { reason?: unknown } | undefined)?.reason === 'string'
          ? ((args as { reason?: string }).reason ?? '').trim()
          : ''
        if (action === 'full' && fullWhy === '') {
          face = tools.schemas()
          return {
            ok: false,
            mode,
            openDomains: [...currentDomains],
            domains: knownDomains,
            applied,
            deniedCount: config.sticky ? gatedSet.size : denied.length,
            globalTools: face.length,
            savedChars: 0,
            savedTokens: 0,
            unmatched,
            picked: [...pinned].sort(),
            reason: 'action=full 被拒绝：必须带 reason 说明为什么需要全量可见。'
              + '绝大多数场景应改用 action=pick name="工具名"（只要那一个工具的代价），'
              + '或 action=open name="域id"（要一整套时）。',
          }
        }
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
      } else if (action === 'pick' || action === 'unpick') {
        // 单工具粒度（主人 2026-11-09）：只放行/收回这几个具体工具，不动域。
        if (domainNames.length === 0) {
          face = tools.schemas()
          return {
            ok: false,
            mode,
            openDomains: [...currentDomains],
            domains: knownDomains,
            applied,
            deniedCount: config.sticky ? gatedSet.size : denied.length,
            globalTools: face.length,
            savedChars: 0,
            savedTokens: 0,
            unmatched,
            picked: [...pinned].sort(),
            reason: `action=${action} 需要 name（具体的工具名，多个用逗号分隔）`,
          }
        }
        // 精确名不匹配时绝不静默无效：拼错一个字母就让整个 pick 失效，用户还以为成了。
        // 给相近候选（按子串双向匹配），因为我经常记不住工具全名。
        const unknown = domainNames.filter(n => !seenNames.has(n))
        if (action === 'pick' && unknown.length > 0) {
          const near = [...seenNames]
            .filter(name => domainNames.some(d => {
              const q = d.toLowerCase()
              return name.toLowerCase().includes(q) || q.includes(name.toLowerCase())
            }))
            .sort()
            .slice(0, 15)
          return {
            ok: false,
            mode,
            openDomains: [...currentDomains],
            domains: knownDomains,
            applied,
            deniedCount: config.sticky ? gatedSet.size : denied.length,
            globalTools: tools.schemas().length,
            savedChars: 0,
            savedTokens: 0,
            unmatched,
            picked: [...pinned].sort(),
            reason: `未知工具名：${unknown.join(', ')}`
              + (near.length > 0
                ? `；相近候选：${near.join(', ')}`
                : '；没有相近的工具名（用 tool_find 查「我要做 X 该用哪个工具」）'),
          }
        }
        if (action === 'pick') {
          for (const n of domainNames) pinned.add(n)
        } else {
          for (const n of domainNames) pinned.delete(n)
        }
        // 用当前档位重算一遍：pinned 在 applyMode 内部从 deny 剔除，随即生效。
        // ⚠ 传 currentDomains 而不是空数组——pick 不该把已开的域清掉。
        face = applyMode(mode, undefined, action + ':' + domainNames.join('+'), currentDomains)
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
          picked: [...pinned].sort(),
          reason: '未知 action "' + action + '"：只接受 status / lean / full / domain / open / close / pick / unpick',
        }
      } else {
        face = tools.schemas()
      }

      const cost = faceCost(face, denied)
      // 域成本与地板只在 domain 档有意义（lean/full 下域不参与决策，算了也是浪费）。
      const costs = mode === 'domain' ? computeDomainCosts(face, domains) : undefined
      const coverage = mode === 'domain' ? domainCoverage(face, domains) : undefined
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
        // v0.4：sticky 下 deniedCount 报的是「门禁数」而不是「从上下文移除数」，
        // savedChars/savedTokens 恒为 0——因为确实一个字符都没从上下文里去掉。
        // ⚠ 必须恒为布尔：宿主按 output schema 严格校验，值为 undefined 的键会让整条返回值作废
        // （2026-11-09 实测：裸 config 未经 Schemastery 填默认值时 config.sticky 是 undefined，
        //  schema-parity 用例当场报 `$.sticky 应为 boolean`）。
        sticky: config.sticky === true,
        gatedCount: gatedSet.size,
        nowAvailable: [...nowAvailable],
        nowGated: [...nowGated],
        deniedCount: config.sticky ? gatedSet.size : denied.length,
        globalTools: face.length,
        savedChars: config.sticky ? 0 : cost.chars,
        savedTokens: config.sticky ? 0 : cost.tokens,
        unmatched,
        picked: [...pinned].sort(),
        ...(reason === undefined ? {} : { reason }),
      }
    },
  }))

  // ── 按需执行通道（v0.6）─────────────────────────────────────────────────────
  // 域内工具不进工具面（省掉的正是它们占的那部分上下文），但能力必须可达。
  // 收窄只过滤 agent 视图、不注销注册；本工具用**全局视图**按名取定义再执行，
  // 因此被收窄的工具在这里依然调得到（宿主机理见 ToolsLike.get 的注释）。
  // ⚠ 它自己必须永不被收窄或门禁——通道一关，域内工具就再没有取用路径了。
  ctx.tools.register(defineTool({
    name: 'tool_call',
    description: '按需执行当前未常驻的工具。'
      + '域内工具不占上下文，用本工具按名调用：tool=工具名，args=该工具的参数对象（原样转交）。'
      + '工具名与各域明细用 toolface({action:"status"}) 查，或查对应技能文档。'
      + '参数不合法时返回该工具的报错原文，按提示修正后重试即可。'
      + '已经直接可见的常驻工具请直接调用，不必经过本工具。',
    parameters: {
      tool: { type: 'string', required: true, description: '要执行的工具名（如 manor_find）' },
      args: { type: 'object', additionalProperties: true, description: '传给该工具的参数对象；省略视为空对象' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const r = value as Record<string, unknown>
        if (r['ok'] === true) {
          const body = r['result']
          return [{ type: 'text', text: body === undefined ? '（无返回值）' : JSON.stringify(body, null, 2) }]
        }
        const error = String(r['error'] ?? '执行失败')
        const hint = r['hint'] === undefined ? '' : `\n${String(r['hint'])}`
        return [{ type: 'text', text: `✗ ${error}${hint}` }]
      },
    },
    async execute(args, exec) {
      const input = (args ?? {}) as { tool?: unknown; args?: unknown }
      const target = typeof input.tool === 'string' ? input.tool.trim() : ''
      if (target === '') return { ok: false, tool: null, error: 'tool 不能为空：给要执行的工具名', hint: null, result: null }
      const definition = tools.get?.(target)
      if (definition === undefined) {
        return {
          ok: false,
          tool: target,
          error: `未知工具：${target}`,
          hint: '用 toolface({action:"status"}) 查各域工具明细；它在某个域里时也可以直接 toolface({action:"open", name:"域"}) 常驻它',
          result: null,
        }
      }
      const forwarded = input.args !== null && typeof input.args === 'object' ? input.args : {}
      try {
        const value = await definition.execute(forwarded, exec)
        return { ok: true, tool: target, result: (value ?? null) as never, error: null, hint: null }
      } catch (err) {
        return { ok: false, tool: target, error: (err as Error).message, hint: null, result: null }
      }
    },
  }))

  // ── 每步一行「工具域索引」（config.indexLine） ───────────────────────────────
  // 只在 domain 档注入：域是收窄的单位，也只有在收窄时「存在但看不见」才会发生。
  //
  // ⚠ 重注入判据是**压缩**，不是时钟（2026-11-12 主人纠正）：
  // 第一版按「会话 + 小时 + 内容」去重，那是拿现实时间当自身状态的标尺——
  // 一小时内压缩两次，第二次丢了这行也要等下一个整点；一小时不压缩，却白白重注一遍。
  // 真正的信号是上下文**被替换**这件事本身：`compaction/summary` 只在摘要落盘成功时追加
  // （失败走 `compaction/end{error}`，上下文没换，不该触发）。
  if (config.indexLine) {
    /** 已注入过的「会话 + 内容」键 —— 内容变了（域集合变了）就配得上再注一次。 */
    const seenIndex = new Set<string>()
    /** 刚压缩过、索引已从可见上下文里消失的会话。用一次就清。 */
    const compactedSessions = new Set<string>()
    ctx.on('session/event', ((session: { readonly id?: unknown }, event: { readonly type?: string }) => {
      if (event?.type !== 'compaction/summary') return
      const id = String(session?.id ?? '')
      if (id !== '') compactedSessions.add(id)
    }) as any)
    ctx.on('agent/pre-step', (async (payload: any, next: any) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      if (mode !== 'domain') return decision
      if (indexDirty) {
        indexCached = indexLine([...seenNames], domains, config.indexLineMax)
        indexDirty = false
      }
      if (indexCached === '') return decision
      const sid = String(payload.agent?.session?.id ?? '')
      const afterCompaction = compactedSessions.delete(sid)
      const key = `${sid}|${indexCached}`
      if (seenIndex.has(key) && !afterCompaction) return decision
      if (seenIndex.size >= 500) seenIndex.clear()
      seenIndex.add(key)
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: indexCached }],
          source: { kind: INDEX_SOURCE_KIND },
        })],
      }
    }) as any, { prepend: true })
  }
}

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
import { auditLine, denyFor, expandPatterns, faceCost, parseMode } from './logic.ts'
import type { ToolSchemaLike, ToolfaceMode } from './logic.ts'

export const name = 'agent-toolface'

/** 宿主 `tools` 服务的可见面（宽松声明：跨包不 import，避免版本耦合）。 */
export const inject = ['tools'] as const

export interface Config {
  /** 默认档位：lean = 按 deny 收窄；full = 全量可见（非法值加载即抛错）。 */
  mode: string
  /** lean 档的 deny 模式：精确工具名或尾随 `*` 的前缀。 */
  deny: string[]
}

export const Config = z.object({
  mode: z.string().default('lean'),
  deny: z.array(z.string()).default([]),
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

  const writeAudit = async (action: string): Promise<void> => {
    try {
      await mkdir(dshHome, { recursive: true })
      const cost = faceCost(tools.schemas(), denied)
      await appendFile(
        auditPath,
        auditLine({
          at: new Date().toISOString(),
          action,
          mode,
          applied,
          deniedCount: denied.length,
          globalTools: tools.schemas().length,
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
  const applyMode = (next: ToolfaceMode, override: readonly string[] | undefined, action: string): void => {
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

    const patterns = denyFor(mode, config.deny, override)
    if (patterns.length > 0) {
      const plan = expandPatterns(patterns, tools.schemas().map(s => s.name))
      unmatched = plan.unmatched
      denied = plan.matched
      if (plan.matched.length > 0) {
        try {
          lift = tools.restrict({ deny: plan.matched })
          applied = true
        } catch (err) {
          reason = (err as Error).message
          logger.error(`工具面收窄失败（本会话保持全量可见）: ${reason}`)
        }
      } else {
        reason = 'deny 模式全部未命中已知工具'
        logger.warn(`工具面收窄跳过：${reason}（未命中 ${unmatched.join(', ')}）`)
      }
    }

    const cost = faceCost(tools.schemas(), denied)
    logger.info(
      `工具面档位 ${mode}：收窄 ${denied.length} 项（全局面 ${tools.schemas().length} 个工具），`
      + `applied=${applied}，省约 ${cost.tokens} tok`,
    )
    void writeAudit(action)
  }

  applyMode(mode, undefined, 'load')

  // 补挂：仅当仍有未命中的模式（工具提供方后注册/热挂载时才会发生）。
  ctx.on('tools/change', () => {
    if (mode === 'full' || unmatched.length === 0) return
    applyMode(mode, undefined, 'reapply')
  })

  ctx.tools.register(defineTool({
    name: 'toolface',
    description:
      '工具面分档：查看或切换本会话可见工具的收窄档位（lean=按 deny 收窄，full=全量可见）。'
      + '收窄只作用于本会话（agent 作用域），不影响其他会话或子代理；档位不持久化，重启回到预设默认。'
      + '当某个族的工具在当前会话不可见时，先用它恢复，再执行任务。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'status=查看当前档位与省下的体量；lean=按 deny 收窄；full=恢复全量可见',
      },
      deny: {
        type: 'array',
        items: { type: 'string' },
        description: 'lean 时覆盖配置的 deny 模式（精确工具名或尾随 * 的前缀），仅本次会话有效',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
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
          applied?: boolean
          deniedCount?: number
          globalTools?: number
          savedChars?: number
          savedTokens?: number
          unmatched?: string[]
          reason?: string
        }
        const total = r.globalTools ?? 0
        const lines: string[] = []
        if (r.mode === 'full') {
          lines.push(`工具面 [full] 全局面 ${total} 个工具可见（收窄已解除）`)
        } else {
          lines.push(
            `工具面 [lean] 收窄 ${r.deniedCount ?? 0} 个工具（全局面 ${total} 个），`
            + `省约 ${r.savedTokens ?? 0} tok（${r.savedChars ?? 0} 字符）`,
          )
          if (r.applied === false) lines.push(`· 收窄未生效：${r.reason ?? '未知原因'}`)
        }
        if (Array.isArray(r.unmatched) && r.unmatched.length > 0) {
          lines.push(`· 未匹配模式：${r.unmatched.join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { action?: unknown; deny?: unknown }
      const action = typeof input.action === 'string' ? input.action : 'status'
      const override = Array.isArray(input.deny)
        ? input.deny.filter((v): v is string => typeof v === 'string')
        : undefined

      if (action === 'lean' || action === 'full') {
        applyMode(action, override, action)
      } else if (action !== 'status') {
        return {
          ok: false,
          mode,
          applied,
          deniedCount: denied.length,
          globalTools: tools.schemas().length,
          savedChars: 0,
          savedTokens: 0,
          unmatched,
          reason: `未知 action "${action}"：只接受 status / lean / full`,
        }
      }

      const schemas = tools.schemas()
      const cost = faceCost(schemas, denied)
      return {
        ok: true,
        mode,
        applied,
        deniedCount: denied.length,
        globalTools: schemas.length,
        savedChars: cost.chars,
        savedTokens: cost.tokens,
        unmatched,
        ...(reason === undefined ? {} : { reason }),
      }
    },
  }))
}

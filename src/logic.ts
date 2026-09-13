/**
 * dsh-agent-toolface 纯逻辑：无 IO、无宿主依赖，可离线单测。
 *
 * 口径对齐宿主 `@deepseek-ai/dsh-token-meter/estimate`：模型面字符数 / 4 = 估算 token。
 * 语义见 `docs/semantic.md`（§4 不变量、§5 契约）。
 */

/** 工具 schema 的最小可见面（与宿主 `tools.schemas()` 的投影字段一致）。 */
export interface ToolSchemaLike {
  name: string
  description?: string
  parameters?: unknown
}

/** 档位：lean = 按 deny 收窄；full = 全量可见。 */
export type ToolfaceMode = 'lean' | 'full'

/** 模式列表解析结果：命中的工具名 + 未命中的模式明文。 */
export interface PatternPlan {
  matched: string[]
  unmatched: string[]
}

/** 一组工具的模型面体量。 */
export interface FaceCost {
  count: number
  chars: number
  tokens: number
}

/**
 * 解析 deny 模式：精确工具名，或尾随 `*` 的前缀（如 `sec_*`）。
 * @param patterns - 配置或调用方给出的模式列表；空串与空白项被忽略。
 * @param known - 当前已注册的全局工具名（唯一真源：宿主 `tools.schemas()`）。
 * @returns 命中的工具名（去重升序）与未命中的模式明文（保持输入顺序）。
 */
export function expandPatterns(patterns: readonly string[], known: readonly string[]): PatternPlan {
  const matched = new Set<string>()
  const unmatched: string[] = []
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (pattern === '') continue
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      const hits = known.filter(name => name.startsWith(prefix))
      if (hits.length === 0) unmatched.push(raw)
      for (const hit of hits) matched.add(hit)
    } else if (known.includes(pattern)) {
      matched.add(pattern)
    } else {
      unmatched.push(raw)
    }
  }
  return { matched: [...matched].sort(), unmatched }
}

/**
 * 计算一组工具的模型面体量：只统计显式列名的工具。
 * @param schemas - 当前可见 schema 列表。
 * @param names - 目标工具名集合。
 * @returns 命中的工具数、JSON 字符数、估算 token（ceil(chars / 4)）。
 */
export function faceCost(schemas: readonly ToolSchemaLike[], names: Iterable<string>): FaceCost {
  const wanted = new Set(names)
  let chars = 0
  let count = 0
  for (const schema of schemas) {
    if (!wanted.has(schema.name)) continue
    count += 1
    chars += JSON.stringify({
      name: schema.name,
      description: schema.description ?? '',
      parameters: schema.parameters ?? {},
    }).length
  }
  return { count, chars, tokens: Math.ceil(chars / 4) }
}

/**
 * 决定本次应下发的 deny 模式列表。
 * @param mode - 目标档位。
 * @param configDeny - 配置里的 deny 模式。
 * @param override - 调用方本次覆盖的模式（缺省用配置）。
 * @returns full 一律空列表（撤销全部收窄）；lean 返回覆盖或配置的模式。
 */
export function denyFor(
  mode: ToolfaceMode,
  configDeny: readonly string[],
  override: readonly string[] | undefined,
): string[] {
  if (mode === 'full') return []
  return [...(override ?? configDeny)]
}

/**
 * 解析档位字符串。
 * @param value - 待解析值。
 * @returns 合法档位，或 undefined（调用方须 fail-loud 或回退）。
 */
export function parseMode(value: unknown): ToolfaceMode | undefined {
  return value === 'lean' || value === 'full' ? value : undefined
}

/** 审计行入参。 */
export interface AuditEntry {
  at: string
  action: string
  mode: ToolfaceMode
  applied: boolean
  deniedCount: number
  totalTools: number
  savedTokens: number
  unmatched: readonly string[]
  reason?: string
}

/**
 * 生成一行审计记录（单行 JSON，便于 grep 与机器解析）。
 * @param entry - 审计字段。
 * @returns 以换行结尾的单行 JSON。
 */
export function auditLine(entry: AuditEntry): string {
  const payload: Record<string, unknown> = {
    at: entry.at,
    action: entry.action,
    mode: entry.mode,
    applied: entry.applied,
    deniedCount: entry.deniedCount,
    totalTools: entry.totalTools,
    savedTokens: entry.savedTokens,
    unmatched: [...entry.unmatched],
  }
  if (entry.reason !== undefined) payload['reason'] = entry.reason
  return JSON.stringify(payload) + '\n'
}

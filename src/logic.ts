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

/** 档位：lean = 按 deny 收窄；full = 全量可见；domain = 按域（只留常驻 + 当前域）。 */
export type ToolfaceMode = 'lean' | 'full' | 'domain'

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
 * 决定本次应下发的 deny 模式列表（**只服务 lean / full 两档**）。
 * @param mode - 目标档位；`domain` 档不经过本函数（它由 `planDomain` 决定），
 *   故签名收窄为 `'lean' | 'full'`——调用方必须先分支，漏分支会被类型检查拦下。
 * @param configDeny - 配置里的 deny 模式。
 * @param override - 调用方本次覆盖的模式（缺省用配置）。
 * @returns full 一律空列表（撤销全部收窄）；lean 返回覆盖或配置的模式。
 */
export function denyFor(
  mode: 'lean' | 'full',
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
  return value === 'lean' || value === 'full' || value === 'domain' ? value : undefined
}

/** 域定义：域 id → 工具模式（语法与 deny 相同：精确名，或尾随 `*` 的前缀）。 */
export type DomainMap = Readonly<Record<string, readonly string[]>>

/** 一次「按域开启」的解析结果。 */
export interface DomainPlan {
  /** 本次要 deny 的工具名（升序去重）。 */
  deny: string[]
  /** 目标域解析出的工具名（升序）。 */
  domainTools: string[]
  /** 常驻集解析出的工具名（升序）。 */
  residentTools: string[]
  /** 目标域里未命中已知工具的模式明文。 */
  unmatched: string[]
  /** 目标域是否存在——false 时调用方须 fail-loud，不许静默当「没东西可开」。 */
  known: boolean
  /** 不存在的目标域 id（多域时逐个列出；`known=false` 时非空）。 */
  unknownDomains: string[]
}

/** 单个域的体量读数（`status` 用它回答「开这个域要花多少」）。 */
export interface DomainCost {
  id: string
  tools: number
  chars: number
  tokens: number
}

/** 域覆盖读数：被某个域覆盖的工具数 vs 域外工具（后者是收窄的永久地板）。 */
export interface DomainCoverage {
  /** 被任一域显式覆盖的工具数——只有这些才可能被 deny。 */
  covered: number
  /** 域外工具数：永远可见，构成收窄的地板。 */
  outside: number
  /** 域外工具的模型面体量（token 估算）。 */
  outsideTokens: number
}

/**
 * 按域解析 deny：**只 deny「被某个域覆盖」的工具中，既非常驻、也不属目标域的那部分**。
 *
 * 关键设计（为什么不是「全部工具减去 keep」）：不在任何域里的工具**永不被 deny**——
 * 官方基础工具（read/write/bash/grep…）与尚未归类的新插件因此自动常驻。
 * 这让「漏归类」的失败方向是**多可见**而不是**看不见**（fail-safe：宁可多占上下文，
 * 不可让 agent 在需要时发现工具消失）。想 deny 就必须显式归类，归错也只影响那一族。
 *
 * @param allTools - 当前已注册的全局工具名（唯一真源：宿主 `tools.schemas()`）。
 * @param domains - 域定义表。
 * @param resident - 常驻模式（跨域通用，任何域下都可见）。
 * @param target - 目标域 id。
 * @returns deny 计划；`known=false` 表示该域不存在。
 */
export function planDomain(
  allTools: readonly string[],
  domains: DomainMap,
  resident: readonly string[],
  target: readonly string[] | string | undefined,
): DomainPlan {
  // 归一化：单字符串 / 数组 / undefined 一律收成有序去重数组。
  // 保留单字符串形态是**向后兼容**（既有调用点与测试传 'quant'）；
  // 数组形态是 v0.3 的多域：一次开多个域，`deny` 只留这些域 ∩ 常驻。
  const targets: string[] = target === undefined
    ? []
    : (typeof target === 'string' ? [target] : [...new Set(target)])
  const names = [...allTools]
  const residentTools = expandPatterns(resident, names).matched

  // 域覆盖集 = 所有域的工具并集。只有这些工具才可能被 deny。
  const coveredTools = (): string[] => {
    const covered = new Set<string>()
    for (const list of Object.values(domains)) {
      for (const hit of expandPatterns(list, names).matched) covered.add(hit)
    }
    return [...covered].sort()
  }

  // targets 为空 ⇒「只常驻」：不额外开任何域。
  // 这不是错误态（它是 mode=domain 的默认状态），故 known=true、unmatched 为空。
  if (targets.length === 0) {
    const keep = new Set(residentTools)
    return {
      deny: coveredTools().filter(n => !keep.has(n)),
      domainTools: [],
      residentTools,
      unmatched: [],
      known: true,
      unknownDomains: [],
    }
  }

  // 多域（v0.3）：逐个解析后取并集。**任一目标域不存在 ⇒ 整体 fail-loud 且零 deny**，
  // 不做「开一半」——半开会让「我以为开了 A+B、实际只有 A」变成一个沉默的假读数，
  // 而失败方向必须是「多可见」（见 I9 ③）。
  const unknownDomains: string[] = []
  const domainTools = new Set<string>()
  const unmatched: string[] = []
  for (const one of targets) {
    const patterns = domains[one]
    if (patterns === undefined) {
      unknownDomains.push(one)
      continue
    }
    const plan = expandPatterns(patterns, names)
    for (const hit of plan.matched) domainTools.add(hit)
    for (const miss of plan.unmatched) unmatched.push(miss)
  }
  if (unknownDomains.length > 0) {
    return {
      deny: [],
      domainTools: [],
      residentTools,
      unmatched: [...unknownDomains, ...unmatched],
      known: false,
      unknownDomains,
    }
  }

  const keptDomainTools = [...domainTools].sort()
  const keep = new Set<string>([...residentTools, ...keptDomainTools])
  const deny = coveredTools().filter(n => !keep.has(n))
  return {
    deny,
    domainTools: keptDomainTools,
    residentTools,
    unmatched,
    known: true,
    unknownDomains: [],
  }
}

/**
 * 逐域体量：每个域展开后占多少工具 / 多少模型面 token（降序）。
 *
 * 存在理由（2026-11-04）：`status` 原先只报「有哪些域」，不报「开它要花多少」——
 * 于是切域是盲选。实测 18 个域里 7 个从未使用过，而它们的成本一直不可见
 * （不可见的代价不会被清理，只会被遗忘）。
 *
 * @param schemas - 当前可见 schema 列表（唯一体量真源）。
 * @param domains - 域定义表。
 * @returns 每域一行，按 token 降序；未命中任何工具的域仍列出（tools=0，暴露拼写错误）。
 */
export function domainCosts(
  schemas: readonly ToolSchemaLike[],
  domains: DomainMap,
): DomainCost[] {
  const names = schemas.map(s => s.name)
  const rows: DomainCost[] = []
  for (const [id, patterns] of Object.entries(domains)) {
    const matched = expandPatterns(patterns, names).matched
    const cost = faceCost(schemas, matched)
    rows.push({ id, tools: cost.count, chars: cost.chars, tokens: cost.tokens })
  }
  rows.sort((a, b) => (b.tokens - a.tokens) || a.id.localeCompare(b.id))
  return rows
}

/**
 * 域覆盖读数：被域覆盖的工具（可被 deny 的候选）vs 域外工具（永久地板）。
 *
 * 为什么需要它：域外工具**永不被 deny**（I9 ③ fail-safe），它们构成收窄的下限。
 * 不报这个数，就无法回答「收窄最多能省多少」——省下的量与地板高度是同一件事的两面。
 *
 * @param schemas - 当前可见 schema 列表。
 * @param domains - 域定义表。
 * @returns 覆盖数 / 域外数 / 域外体量。
 */
export function domainCoverage(
  schemas: readonly ToolSchemaLike[],
  domains: DomainMap,
): DomainCoverage {
  const names = schemas.map(s => s.name)
  const covered = new Set<string>()
  for (const patterns of Object.values(domains)) {
    for (const hit of expandPatterns(patterns, names).matched) covered.add(hit)
  }
  const outsideNames = names.filter(n => !covered.has(n))
  const cost = faceCost(schemas, outsideNames)
  return { covered: covered.size, outside: outsideNames.length, outsideTokens: cost.tokens }
}

/** 一个域的体量读数（工具数；不算 token —— 这里刻意不碰 schema，见 indexLine 的注释）。 */
export interface DomainSize {
  id: string
  tools: number
}

/**
 * 各域的工具数（降序）。
 * @param names - 已知工具名（累积集，不是当次可见面）。
 * @param domains - 域定义表。
 * @returns 按工具数降序、同数按 id 升序的域体量表。
 */
export function domainSizes(names: readonly string[], domains: DomainMap): DomainSize[] {
  const rows: DomainSize[] = []
  for (const [id, patterns] of Object.entries(domains)) {
    rows.push({ id, tools: expandPatterns(patterns, names).matched.length })
  }
  return rows.sort((a, b) => (b.tools - a.tools) || a.id.localeCompare(b.id))
}

/**
 * 每步注入的「工具域索引」一行。
 *
 * 存在理由（2026-11-12 事故）：我对着主人断言「库里没有删除工具」，而 `memory_merge`
 * 一直在档案里——记忆工具按 `deferLoading` 声明成「按名调用、不占 schema」，于是
 * **不在手边**被我读成了**不存在**。指路牌（`tool_find`）那天还因为整串匹配撒了谎。
 *
 * 判据取舍（实测 2026-11-12：本机 23 域索引单行 344 字符 ≈ 215 token，**每小时最多注入一次**，
 * 不是每步）：215 token/小时覆盖全部工具；把同样这些工具**常驻**要两三万 token/次请求，
 * 而且仍只是子集。**常驻目录，不常驻工具。**
 *
 * 刻意只数名字、不算 token：`domainCosts` 要读 schema（对每个工具深克隆 parameters，
 * 274 工具 ≈ 8s）——那是用户主动查时才付的代价，不能挂在每步路径上。
 * @param names - 已知工具名（累积集）。
 * @param domains - 域定义表。
 * @param max - 最多列几个域（其余折成「还有 N 域」）。
 * @param catchAllRatio - 兜底域判据（语义常数，不是部署选择）：覆盖 ≥ 此比例的域是兜底域
 *   （本机 `everything: ['*']`，它把所有工具包起来好让它们默认不可见），**不是路由单位**——
 *   「打开 everything」等于「全开」，列在索引第一位只会挤掉真正的域。
 * @returns 一行索引；域表为空时返回空串（调用方据此跳过注入）。
 */
export function indexLine(
  names: readonly string[],
  domains: DomainMap,
  max = 12,
  catchAllRatio = 0.9,
): string {
  const total = names.length
  const sizes = domainSizes(names, domains)
    .filter(size => size.tools > 0)
    .filter(size => total === 0 || size.tools < total * catchAllRatio)
  if (sizes.length === 0) return ''
  const shown = sizes.slice(0, max).map(size => `${size.id} ${String(size.tools)}`).join(' · ')
  const rest = sizes.length > max ? ` · …还有 ${String(sizes.length - max)} 域` : ''
  return `工具域索引（${String(sizes.length)} 域 / ${String(total)} 工具；`
    + '收窄≠不存在——按名调用不需要 schema，用 toolface(action="open", name=域) 或 tool_call）：'
    + shown + rest
}

/** 审计行入参。 */
export interface AuditEntry {
  at: string
  action: string
  mode: ToolfaceMode
  applied: boolean
  deniedCount: number
  /** 全局面可见工具数（preset 作用域读到的 schemas() 是全局视图，非本会话可见数）。 */
  globalTools: number
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
    globalTools: entry.globalTools,
    savedTokens: entry.savedTokens,
    unmatched: [...entry.unmatched],
  }
  if (entry.reason !== undefined) payload['reason'] = entry.reason
  return JSON.stringify(payload) + '\n'
}

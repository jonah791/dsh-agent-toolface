# dsh-agent-toolface · 语义文档

> 版本 v0.1.1 · 2026-09-13 · 作者：爱丽丝 · 状态：**已验收（验收 6/6：4 条单测已实测 + 2 条线上实测，见 §7）**
> 实现落点：`src/index.ts`（收窄加载/切换/审计）+ `src/logic.ts`（纯逻辑）

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | `dsh-agent-toolface`（工具面分档） |
| 主副本 | 本文件（`self-plugins/dsh-agent-toolface/docs/semantic.md`） |
| 载体 | 插件（agent preset 行）；工具 `toolface` |
| 相关 | 规则 §5.20；任务 `t-b3fc4d7e`；宿主契约 `packages/core/tools` 的 `restrict` / `schemas` |

## 2 · 定位与反定位

**定位**：决定「一场会话的模型能看到哪些工具」，并在运行期提供一键切换。

- 依据是**测量**而非直觉：工具面体量 = Σ 每个工具 `{name, description, parameters}` 的 JSON 字符数；14 天调用证据决定谁进 deny 集（零调用且占体量大的族）。
- 收窄**只发生在 agent 作用域**，因此只影响挂了该预设的会话（并列实例、子代理、其他预设不受影响）。

**反定位（不做什么）**：

- 不是「删除能力」：被 deny 的工具仍在注册表中，`full` 一键恢复；插件的挂载/卸载与它无关。
- 不是进程级开关：**不做**全局收窄（宿主的 `restrict` 明确拒绝全局调用，理由是会掩蔽所有 agent）。
- 不是工具瘦身（改写第三方 schema 文本）：不改动任何工具的描述/参数——那属于各插件自身，且宿主内置工具的描述被快照钉死。
- 不是 PTC 模式：不改变工具的呈现形态（原生 JSON schema ↔ 代码绑定），只改变可见集合。

## 3 · 术语

| 术语 | 含义 |
|------|------|
| 工具面（tool face） | 一次请求里模型可见的工具 schema 集合；宿主口径 `toolsTokens = ceil(len(JSON.stringify(header.tools))/4) + 4` |
| 档位（mode） | `lean` = 按 deny 收窄；`full` = 全量可见 |
| deny 模式（pattern） | 精确工具名，或尾随 `*` 的前缀（如 `sec_*`） |
| 命中/未命中 | 模式是否解析到当前已注册的全局工具名；未命中不得静默丢弃 |
| 收窄（restrict） | 宿主 `ctx.tools.restrict({deny})` —— 在调用者作用域内掩蔽这些工具；多个 restriction **取交集** |

## 4 · 概念模型与不变量

模型：**预设配置的默认档** → 加载时解析 → 作用域内 restriction → 运行期由 `toolface` 切换（先撤销、再按新档重挂）。

- **I1 作用域**：收窄只能发生在有作用域的 ctx；全局收窄被宿主拒绝，本插件也不尝试。收窄失败必须响亮落盘（fail-soft 但不静默）。
- **I2 幂等**：切换前一律先撤销已有 restriction；`lean` 重复调用不叠加，`full` 重复调用不新增 effect。
- **I3 未命中不静默**：模式未解析到任何工具时记入 `unmatched` 并写审计，且不调用 `restrict`（宿主对未知工具名抛错）。
- **I4 审计**：每次「加载 / 切换 / 补挂」都追加一行 JSON 到 `${DSH_HOME}/toolface-events.log`（时间、动作、档位、生效与否、收窄数、总量、省下 token、未命中、原因）。
- **I5 不持久化放宽**：档位是会话运行期状态；**重启回到预设配置的默认档**（放宽不会被写进磁盘，避免一次临时放开变成长期默认）。
- **I6 报告如实**：`status` 报告的是**实测**（当前 `tools.schemas()` 的数量与体量），不是配置意图。

## 5 · 契约（含调用点清单）

**配置（preset 行的 config）**

```yaml
- id: toolface
  name: dsh-agent-toolface
  config:
    mode: lean          # lean | full（其他值加载即抛错，fail-loud）
    deny: ['sec_*', ...]  # 精确名或尾随 * 前缀
```

**工具 `toolface`**

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string（必填） | `status` 查看 / `lean` 收窄 / `full` 全量 |
| `deny` | string[] | 可选，`lean` 时覆盖配置的 deny 模式（本次会话内有效） |

返回：`{ ok, mode, applied, deniedCount, globalTools, savedChars, savedTokens, unmatched[], reason? }`。

`globalTools` 是**全局面**计数（preset 作用域的 `schemas()` 是全局视图）；**本会话模型可见数**由请求头实测，不由本工具报告（见 §9 实践修订 ①）。

**宿主契约（调用点清单）**

| 宿主接口 | 调用点 | 语义依赖 |
|----------|--------|----------|
| `ctx.tools.schemas(scope?)` | 加载、切换、`tools/change` 回调 | 返回当前可见 schema（含 `name`/`description`/`parameters`）——唯一的名称与体量真源 |
| `ctx.tools.restrict({deny})` | 加载、切换、补挂 | 需有作用域 ctx；未知工具名抛错；返回撤销用的 disposer；多条 restriction 取交集 |
| `tools/change` 事件 | 补挂判定 | 工具注册/注销或作用域 restriction 变化时触发（无参数） |
| `defineTool` | `toolface` 注册 | 参数/输出 schema 与 render |

**挂载点**：`${DSH_HOME}/.agent-presets/alice-v2/agent.cordis.yml`（以及 `alice`）——**必须放在所有工具行之后**（否则先注册后出现的工具名解析不到，会落到 `unmatched` 并在 `tools/change` 时补挂）。

## 6 · 边界与信任

- **信任边界**：插件信任宿主 `restrict` 的校验（未知名抛错）；它**不**信任配置正确性——`mode` 非枚举值加载即抛错，模式未命中记入审计。
- **不做沙箱声明**：收窄是**可见性**而非安全边界（§宿主：能力 ≠ 沙箱）；被 deny 的工具对模型不可见，但进程仍有该能力。
- **并行实例**：同一预设的多个会话共享该预设的 standing mount，因此档位对它们是**共享**的（一处切换，处处一致）；这是宿主「让过滤在呈现/查找/执行三处保持一致」的设计取向，本插件遵循它，并把切换写进审计以便追溯。
- **副作用**：仅追加审计文件；不写别的状态。

## 7 · 可证伪验收

| # | 验收（一次测量可判真假） | 状态 |
|---|--------------------------|------|
| 1 | 加载后模型可见工具数从 274 降到 ≤211，可由会话日志 `request/header` 实测 | ✅ 已实测（2026-09-13 08:55 重启后：274 → **208** = 274 − 67 + 1 个 toolface；122,076 → 91,682 字符 ≈ 30,519 → 22,925 tok） |
| 2 | `toolface action=full` 后重新请求的工具数为 274 + 1 | ✅ 已实测（同日 08:56：**275** 个 / 122,579 字符 ≈ 30,649 tok），随后已切回 lean |
| 3 | 未命中模式（配置含 `zzz_*`）不导致插件加载失败，且出现在 `status.unmatched` | ✔ 已实测（`tests/apply.test.mjs` 装载路径 7 项之一：fake ctx 断言未命中不进入 deny） |
| 4 | deny 为空时**不调用** `restrict`（避免宿主 `restrict({})` 抛错） | ✔ 已实测（`tests/apply.test.mjs`：full 档与全未命中两种情形断言 `restrictCalls.length === 0`） |
| 5 | `restrict` 抛错时插件仍加载，`status.applied=false` 且 `reason` 非空 | ✔ 已实测（`tests/apply.test.mjs`：注入 fake tools 使 restrict 抛错，断言工具仍注册 + 错误落 logger） |
| 6 | 每次切换都追加一行审计（含 mode/applied/deniedCount/savedTokens） | ✔ 已实测（单测写临时目录回读；线上 `.dsh/toolface-events.log` 已有 load/full/lean 三行真实记录） |

测量工具：`scripts/face-weight.py`（本仓库自带，从会话日志 `request/header` 复算工具面体量、从 `tool/call` 复算族级使用频率，口径同宿主 `estimate.ts`）。

## 8 · 与实现的关系

| 语义要素 | 实现落点 |
|----------|----------|
| 模式解析（含非法值） | `src/index.ts` 加载期校验 + `src/logic.ts` `parseMode` |
| 模式列表 → 命中/未命中 | `src/logic.ts` `expandPatterns` |
| 体量估算 | `src/logic.ts` `faceCost`（口径同宿主 `estimate.ts`：4 字符/token） |
| 收窄与撤销 | `src/index.ts` `applyMode`（撤销 disposer → 重新 restrict） |
| 审计 | `src/index.ts` `writeAudit` → `toolface-events.log` |
| 补挂 | `ctx.on('tools/change')`：仅当存在未命中模式时重解析 |

## 9 · 实践修订记录

| 日期 | 修订 | 触发 |
|------|------|------|
| 2026-09-13 | 初稿 + 实现 | 任务 `t-b3fc4d7e`；测量发现「工具面 30,519 tok、其中 67 个极少调用工具占 25%」，据此确定 lean 档 deny 集 |
| 2026-09-13 | **① 报告口径被实践修正** | 首次上线后 `status` 报「收窄 67/240」，而请求头实测本会话只有 208 个工具——差异 32 个。根因：preset 作用域的 `schemas()` 返回的是**全局视图**（含其他预设挂载的工具），不是本会话可见集。修法：字段改名 `totalTools → globalTools` 并在文档/README 明确标注「全局面」，本会话可见数一律以请求头实测为准（v0.1.1） |
| 2026-09-13 | ② 验收 1/2 转为**已线上验证** | 重启后实测 274 → 208、full → 275，两条一次性测量的判据均落地 |
| 2026-09-13 | ③ 挂载点判据被宿主源码确认 | `tools.restrict()` 源码明确拒绝无作用域调用（"a context-global restriction would mask every agent"）——印证「挂 preset 而非 host 组合」是唯一正确落点 |

## 10 · 未决问题

1. **lean 默认是否含 `wq_`（30 工具 / 1,922 tok）**：14 天内有 485 次调用（挖掘轮集中使用），暂留可见；若改为 deny，需接受「挖掘前先切档」的仪式。
2. **跨实例共享档位是否需要每会话隔离**：当前跟随预设 standing mount 语义（共享）；若并行实例频繁互相干扰，再评估按 `agent.ctx` 逐 agent 挂载。
3. **`savedTokens` 的口径**：按 4 字符/token 估算单工具，而宿主对整份 header 计价含包装开销——两者存在 ±数个百分点差异，报告已标注为估算。
4. **是否需要「按任务类型预设档位」**（如 mining/security 档）：当前只有 lean/full 两档，先观察真实使用频率再决定。

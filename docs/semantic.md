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
| 档位（mode） | `lean` = 按 deny 收窄；`full` = 全量可见；**`domain` = 只留常驻集 + 指定域**（2026-10-31 新增，主人定调「按需开启，只有少数插件常驻」） |
| 域（domain） | 域 id → 一组工具模式；**域 id 对齐技能 id**。`domain`＝替换为给定域；`open`／`close`＝累加／移除；多域用 `name: "a,b"`（英文逗号分隔，v0.3 起） |
| 常驻集（resident） | 任何域下都可见的工具模式。判据两条：① 不带它无法**工作** ② 不带它无法**恢复**（重启链路 `preflight_*`/`daemon_*` 属后者，2026-10-31 实测踩过死锁） |
| deny 模式（pattern） | 精确工具名，或尾随 `*` 的前缀（如 `sec_*`） |
| 命中/未命中 | 模式是否解析到当前已注册的全局工具名；未命中不得静默丢弃 |
| 收窄（restrict） | 宿主 `ctx.tools.restrict({deny})` —— 在调用者作用域内掩蔽这些工具；多个 restriction **取交集** |

## 4 · 概念模型与不变量

模型：**预设配置的默认档** → 加载时解析 → 作用域内 restriction → 运行期由 `toolface` 切换（先撤销、再按新档重挂）。

- **I1 作用域**：收窄只能发生在有作用域的 ctx；全局收窄被宿主拒绝，本插件也不尝试。收窄失败必须响亮落盘（fail-soft 但不静默）。
- **I2 幂等**：切换前一律先撤销已有 restriction；`lean`/`domain` 重复调用不叠加，`full` 重复调用不新增 effect。
- **I3 未命中不静默**：模式未解析到任何工具时记入 `unmatched` 并写审计，且不调用 `restrict`（宿主对未知工具名抛错）。
- **I4 审计**：每次「加载 / 切换 / 补挂」都追加一行 JSON 到 `${DSH_HOME}/toolface-events.log`（时间、动作、档位、生效与否、收窄数、总量、省下 token、未命中、原因）。
- **I5 不持久化放宽**：档位是会话运行期状态；**重启回到预设配置的默认档**（放宽不会被写进磁盘，避免一次临时放开变成长期默认）。
- **I6 报告如实**：`status` 报告的是**实测**（当前 `tools.schemas()` 的数量与体量），不是配置意图。
- **I7 补挂幂等收敛（不可自激）**：补挂重解析的触发条件必须**可满足且会收敛**——判据是「未命中数相比上次**变少**」（确有新工具被解析到），且总次数封顶。⚠ 反例（2026-10-03 事故，见 §9 ④）：原判据「存在未命中模式」在配置含**永不命中**的模式时恒为真，而补挂内的 `restrict()/lift()` 又触发 `tools/change` ⇒ 每 ~275 ms 自激一轮。
- **I8 审计体量有界**：审计按**状态变化**去重（除时间戳外的关键字段一致则不落盘）——审计记录的是状态变迁，不是心跳。⚠ 反例（同事故）：原「每次加载/切换/补挂都追加一行」在自激下写出 231 万行 / 439 MB。
- **I9 域的三条不变量**（`mode=domain`，2026-10-31 新增）：
  - **① 常驻集必含「恢复链路」**：`resident` 的判据有两条——不带它无法**工作**，或不带它无法**恢复**。后者极易漏：`preflight_*`/`daemon_*` 曾只放在 `plugin-admin` 域里 ⇒ 「仅常驻」档下预检→重启闭环直接断掉（实测 `unknown tool`），而切域的结果又会被重启重置 ⇒ 死锁。补进 resident 后收窄数 266→264（正好少 deny 这 2 个）。
  - **② 域 id 对齐技能 id**：一个域 = 一组「只在做那一类活时才需要」的工具。
  - **③ 域外工具永不被 deny**（fail-safe）：不在任何域里的工具（官方基础工具、尚未归类的新插件）自动常驻。**失败方向是「多可见」而不是「突然消失」**——想 deny 就必须显式归类，归错也只影响那一族。判据实现在 `planDomain`：`deny = coveredTools().filter(n => !keep.has(n))`，`keep = resident ∪ 目标域`，`covered` 只含被某个域显式覆盖的工具。
  - **④ 多域要么全开、要么不开**（v0.3，2026-11-04）：`planDomain` 接受域 id 数组，取并集；**任一目标域不存在 ⇒ `known=false`、零 deny、`unknownDomains` 逐个列出**。不做「开一半」——半开会让「我以为开了 A+B、实际只有 A」变成一个沉默的假读数，而失败方向必须是多可见（同 ③）。**切换失败时保留原已开域**：在 A 域里误传一个拼错的域名，不许把 A 也清空。
  - **⑤ 档位切换的四种语义必须互不混淆**（v0.3）：`domain`＝**替换**（只开给到的域，v0.2 行为不变）；`open`＝**累加**（并入已开集合，用于一类跨域活要同时用到两类工具）；`close`＝**移除**（不给 name = 清空回只常驻）；`full`＝**撤销全部收窄**。⚠ 累加存在的前提是**单域曾造成真实的往复成本**：33 天审计 2,205 行里真实切换 156 次（约 4.7 次/天），而每次切换都要付一次全量 schema 快照（`tools.schemas()` 对每个工具深克隆 parameters，274 工具 ≈ 8s，2026-09-26 剖面）。

## 5 · 契约（含调用点清单）

**配置（preset 行的 config）**

```yaml
- id: toolface
  name: dsh-agent-toolface
  config:
    mode: domain        # lean | full | domain（其他值加载即抛错，fail-loud）
    deny: ['sec_*', ...]  # lean 档用：精确名或尾随 * 前缀（domain 档下被忽略，保留便于一行回退）
    domains:              # domain 档用：域 id → 工具模式（域 id 对齐技能 id）
      quant-research: ['wq_*', 'quant_*']
      media-generation: ['comfy_*', 'reze_*', 'video_*', 'anima_*']
      evidence-retrieval: ['search_*', 'fetch_*', 'archive_*']
    resident:             # domain 档用：任何域下都可见（跨域通用 + **恢复链路**，见 I9 ①）
      - 'remember'
      - 'toolface'
      - 'tool_find'
      - 'preflight_*'     # 恢复链路：没有它连预检都做不了
      - 'daemon_*'        # 恢复链路：没有它连重启都做不了
```

**工具 `toolface`**

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string（必填） | `status` 查看 / `lean` 收窄 / `full` 全量 / **`domain` 替换为给定域** / **`open` 累加开启** / **`close` 关闭给定域** |
| `deny` | string[] | 可选，`lean` 时覆盖配置的 deny 模式（本次会话内有效） |
| `name` | string | 可选，`domain`/`open`/`close` 要操作的域 id；**多个用英文逗号分隔**（`"cleanup,security"`）。`domain` 省略 = 只留常驻集（`mode=domain` 的默认态，不是错误态）；`close` 省略 = 全部关闭。⚠ **刻意保持 `type: string` 而非 array**：宿主按 parameters schema 严格校验（2026-11-04 实测 `"name" must be an array`），改类型会让既有调用直接 INVALID_ARGS——那是破坏兼容，不是新能力 |

返回：`{ ok, mode, domain?, openDomains[], domains[], domainCosts?, outside?, applied, deniedCount, globalTools, savedChars, savedTokens, unmatched[], reason? }`。

v0.3 增补三个字段，回答「切之前先知道代价」：

- `openDomains[]`：**已开域列表**（`domain` 保留为「第一个已开域」，兼容旧读者）。
- `domainCosts[]`：**每个域的工具数与 token**（降序，仅 `mode=domain` 时给）。让空域与贵域都可见——18 个域里曾有 7 个从未被用过，而它们的成本一直不可见（**不可见的代价不会被清理，只会被遗忘**）。
- `outside{ tools, tokens }`：**域外地板**——不在任何域里的工具数与其体量。它们永不被收窄（I9 ③），所以这个数决定了「收窄最多能省多少」。

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
| 7 | **补挂不自激**：`unmatched` 未变少时反复触发 `tools/change`，`restrict` 调用数不得增加（对应 I7） | ✅ 已实测（`tests/apply.test.mjs` 新增用例；**变异测试**证明判据有区分力——移除守卫后该用例转红，恢复后 21/21 绿） |
| 8 | 审计按状态变化去重：同一状态重复写只落一行（对应 I8） | ✔ 已实测（`writeAudit` 以「除时间戳外的关键字段」为指纹去重） |

测量工具：`scripts/face-weight.py`（本仓库自带，从会话日志 `request/header` 复算工具面体量、从 `tool/call` 复算族级使用频率，口径同宿主 `estimate.ts`）。

## 8 · 与实现的关系

| 语义要素 | 实现落点 |
|----------|----------|
| 模式解析（含非法值） | `src/index.ts` 加载期校验 + `src/logic.ts` `parseMode` |
| 模式列表 → 命中/未命中 | `src/logic.ts` `expandPatterns` |
| 体量估算 | `src/logic.ts` `faceCost`（口径同宿主 `estimate.ts`：4 字符/token） |
| 收窄与撤销 | `src/index.ts` `applyMode`（撤销 disposer → 重新 restrict） |
| 审计 | `src/index.ts` `writeAudit` → `toolface-events.log`（按「除时间戳外的关键字段」指纹去重，见 I8） |
| 补挂 | `ctx.on('tools/change')`：**仅当未命中数相比上次变少**（确有新工具注册）时重解析，且累计次数 ≤ `MAX_REAPPLY`（见 I7；2026-10-03 前的旧判据「存在未命中模式」会自激） |

## 9 · 实践修订记录

| 日期 | 修订 | 触发 |
|------|------|------|
| 2026-09-13 | 初稿 + 实现 | 任务 `t-b3fc4d7e`；测量发现「工具面 30,519 tok、其中 67 个极少调用工具占 25%」，据此确定 lean 档 deny 集 |
| 2026-09-13 | **① 报告口径被实践修正** | 首次上线后 `status` 报「收窄 67/240」，而请求头实测本会话只有 208 个工具——差异 32 个。根因：preset 作用域的 `schemas()` 返回的是**全局视图**（含其他预设挂载的工具），不是本会话可见集。修法：字段改名 `totalTools → globalTools` 并在文档/README 明确标注「全局面」，本会话可见数一律以请求头实测为准（v0.1.1） |
| 2026-09-13 | ② 验收 1/2 转为**已线上验证** | 重启后实测 274 → 208、full → 275，两条一次性测量的判据均落地 |
| 2026-09-13 | ③ 挂载点判据被宿主源码确认 | `tools.restrict()` 源码明确拒绝无作用域调用（"a context-global restriction would mask every agent"）——印证「挂 preset 而非 host 组合」是唯一正确落点 |
| 2026-10-03 | **④ 补挂自激循环 → 新增 I7/I8 + 验收 7/8** | 现象：web 进程 **34% 单核持续占用**（15 秒烧 5.13 CPU 秒；进程累计 39,027 CPU 秒 ≈ 10.8 小时）、`toolface-events.log` 涨到 **2,311,441 行 / 439 MB**（每 ~275 ms 一行、内容完全相同）、主人从会话轨迹观察到「命令 263 ms 就完成了，之后近 1 分钟主模型请求无响应且未进入思考状态」。根因：原补挂判据「存在未命中模式」在配置含 `sec_*/red_*/blue_*/otw_*/xp_*`（**永不命中**）时恒为真，而补挂内的 `restrict()/lift()` 又触发 `tools/change` ⇒ 自激。修法：判据改为「未命中数变少」+ 次数封顶 + 审计按状态去重。**★ 语义缺口就在本文档本身**：原 §8 把错误判据当作规格写下（「仅当存在未命中模式时重解析」），而 §4 无不变量、§7 无对应验收 ⇒ **文档写了机制、没写它必须满足的约束**。教训：语义文档的不变量必须包含**收敛性**（触发条件可满足且会终止），而不只是"做了什么"。 |

| 2026-11-04 | **⑤ 单域 → 多域（v0.3）：新增 `open`/`close`，`status` 报域成本与域外地板** | 33 天审计读数（2,205 行 / 真实切换 156 次 ≈ 4.7 次/天）＋全局面工具从 **247 涨到 451（+82%）** 而域映射靠手写维护。原先 `currentDomain: string` 只存一个域 ⇒ 跨域活（改插件→查情报→出素材）必须来回切，每次付一次全量 schema 快照（274 工具 ≈ 8s）。修法：域状态改数组 + 新增 `open`（累加）/`close`（移除），`domain` 保持**替换**语义不变（零破坏）；`status` 增报 `domainCosts`（每域工具数/token）与 `outside`（域外地板 = 收窄能省多少的上限）。⚠ **不碰 I5**：仍是运行期状态、不落盘、重启回预设默认。⚠ 途中被宿主拦下一次：把 `name` 的 schema 从 string 改成 array 会让既有调用直接 INVALID_ARGS（实测 `"name" must be an array`）⇒ 多域改用**英文逗号分隔**，schema 保持 string。 |

## 10 · 未决问题

1. **lean 默认是否含 `wq_`（30 工具 / 1,922 tok）**：14 天内有 485 次调用（挖掘轮集中使用），暂留可见；若改为 deny，需接受「挖掘前先切档」的仪式。
2. **跨实例共享档位是否需要每会话隔离**：当前跟随预设 standing mount 语义（共享）；若并行实例频繁互相干扰，再评估按 `agent.ctx` 逐 agent 挂载。
3. **`savedTokens` 的口径**：按 4 字符/token 估算单工具，而宿主对整份 header 计价含包装开销——两者存在 ±数个百分点差异，报告已标注为估算。
4. **多域已落地，「按任务类型预设档位」仍未做**：v0.3（2026-11-04）给了 `open`/`close` 与域成本读数，让「跨域活不必来回切」成立；但没有做「任务类型 → 域集合」的预设（如 mining = quant-research + evidence-retrieval）。判据：若日志里反复出现**同样的域组合**（同一批 id 在一次会话里被连续 open），再做预设——先等真实形状出现，不先造名词。

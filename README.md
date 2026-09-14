<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 工具面分档：在 agent 作用域内按证据化的 deny 集收窄模型可见工具（lean/full 一键切换 + 审计留痕），降低工具 schema 的固定上下文成本与选择稀释
  inject: 'tools'
  tools: toolface
  runtime: host-only（必须挂 agent preset，不能挂宿主组合——宿主 ctx.tools.restrict 拒绝进程级收窄）
  envDeps: 无（纯宿主工具面 API）
  boundary: 收窄是「可见性」不是安全边界（能力 ≠ 沙箱）：被 deny 的工具对模型不可见，但进程仍有该能力
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-toolface

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-toolface"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-20%20passed-brightgreen" alt="tests">
</p>

**一句话**：把「模型可见的工具集合」按**证据化的 deny 集**收窄，并提供一键恢复——`toolface(action="lean"|"full")`。

**为什么值得用**：一次请求的工具 schema 是**固定上下文成本**——压缩回收不掉，且工具越多、选择越被稀释。实测（2026-09-13，本机）：

| 指标 | 值 |
|------|-----|
| 工具面总量 | 274 个工具 / 122,076 字符 ≈ **30,519 tok** |
| 其中被默认收窄 | 67 个工具 / 30,830 字符 ≈ **7,708 tok（25.3%）** |
| 这 67 个工具近 14 天调用 | **29 次**（同期总调用 11,600 次 = 0.25%） |

**它不删除能力**：被收窄的工具仍在注册表中，`toolface(action="full")` 一行恢复。

## 能力

| 工具 | 用途 |
|------|------|
| `toolface` | 工具面分档：查看或切换本会话可见工具的收窄档位（`lean`=按 deny 收窄，`full`=全量可见）。收窄只作用于本会话（agent 作用域），不影响其他会话或子代理；档位不持久化，重启回到预设默认。返回 `{ ok, mode, applied, deniedCount, globalTools, savedChars, savedTokens, unmatched[], reason? }` |

| 参数 | 说明 |
|------|------|
| `action` | `status`=查看当前档位与省下的体量；`lean`=按 deny 收窄；`full`=恢复全量可见 |
| `deny` | 可选，`lean` 时覆盖配置的 deny 模式（精确工具名或尾随 `*` 的前缀），仅本次会话有效 |

默认 deny 族：`sec_*` `red_*` `blue_*` `otw_*` `xp_*` `clyan_*` `video_*` `download_*`。

> `globalTools` 是**全局面**工具数（preset 作用域读到的 `schemas()` 是全局视图，含其他预设挂载的工具），不是本会话的模型可见数——后者由请求头 `tools` 实测（本机：收窄前 274 → 收窄后 208）。

## 快速开始

**1) 装依赖**（profile 的 `node_modules` 里需能解析到本插件，与其它自研插件同款 link）：

```jsonc
"dsh-agent-toolface": "link:<工作区>/self-plugins/dsh-agent-toolface"
```

**2) 挂组合**——挂在 **agent preset**（不是宿主组合）：宿主 `ctx.tools.restrict()` 只接受有作用域的 ctx（拒绝进程级收窄，理由是会掩蔽所有 agent），而 preset 行天然是 agent 作用域。放在**所有工具行之后**：

```yaml
# .agent-presets/<id>/agent.cordis.yml —— 放在所有工具行之后
- id: toolface
  name: dsh-agent-toolface
  config:
    mode: lean            # lean | full（非法值加载即抛错）
    deny:
      - 'sec_*'
      - 'red_*'
```

**3) 30 秒验证**：调 `toolface { action: "status" }` → 应返回 `mode:"lean"`、`applied:true`、`deniedCount>0`、`savedTokens>0`；再调 `action: "full"` → `deniedCount: 0`，工具面恢复全量。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `mode` | `lean` | 启动档位；**非法值（非 `lean`/`full`）加载即抛错**（不静默降级） |
| `deny` | `[]` | 收窄模式列表：精确工具名，或尾随 `*` 的前缀通配（如 `sec_*`） |

## 落盘与自证（出问题时先看这里）

每次「加载 / 切换 / 补挂」追加一行 JSON 到 **`<DSH_HOME>/toolface-events.log`**（单行 JSON，无阶段枚举——一个动作一行）：

| 字段 | 含义 |
|------|------|
| `at` | ISO 时间戳 |
| `action` | `load`（预设默认档生效）/ `lean` / `full` |
| `mode` | 切换后的档位 |
| `applied` | 是否真的调用了 `restrict`（`false` = 未命中或 `restrict` 抛错，配合 `reason` 看） |
| `deniedCount` | 被 deny 的工具数 |
| `globalTools` | 全局面工具数（收窄前基线） |
| `savedTokens` | 按宿主口径（4 字符/token）估算省下的 token |
| `unmatched` | 未命中任何工具的 deny 模式（**不静默**：全未命中时不调用 `restrict`） |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/toolface-events.log"
# ① 跑的是哪个构建   → 本插件轨迹不含 build 戳（见「生效判据」用 plugin_boot_status / lib mtime 判定）
# ② 谁发起           → action（load 即插件装载时的默认档）
# ③ 断在哪一段       → applied + reason（false 且 reason 非空 = 收窄没落地）
# ④ 结果质量         → deniedCount / globalTools / savedTokens
# ⑤ 耗时与预算       → 本插件不含 durationMs（收窄是同步内存操作，无预算概念）
```

写盘失败不影响收窄本身（审计是旁路）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. `toolface { action: "status" }` 返回 `applied:true` + `deniedCount>0` ⇒ 收窄已落地（行为级，最快）；
2. `tail -1 "$DSH_HOME/toolface-events.log"` 最新一行的 `mode`/`deniedCount` 与你的切换一致 ⇒ 审计层确认；
3. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件 ⇒ 当前进程跑的是当前构建。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。本插件的收窄是 preset 装载期动作，**改代码后必须重启或重挂 preset 才生效**。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-agent-toolface revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：preset 里给 `toolface` 行加 `disabled: true`（或把 `mode` 改回 `full`）→ 哨兵重启；
- 运行期：`toolface { action: "full" }` 立即恢复全量（本会话），**不持久化**——重启即回预设默认档，一次临时放开不会变成长期默认。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**20 例离线测试**（跑 `tests/`，纯逻辑层，不依赖宿主运行时）：
- `tests/logic.test.mjs` — 模式解析（`expandPatterns`）、体量估算（`faceCost`）、档位决策（`denyFor`）、审计行（`auditLine`，含「`reason` 存在时才写该字段」）
- `tests/apply.test.mjs` — apply 路径：非法 `mode` 抛错、全未命中时不调用 `restrict`、`restrict` 抛错时插件仍加载并报 `applied=false`

无网络、无外部依赖（`ctx.tools` 以桩替代）。

## 设计要点

- **必须挂 agent preset，不能挂宿主组合**：`ctx.tools.restrict()` 拒绝进程级收窄（会掩蔽所有 agent）；preset 行天然 agent 作用域，收窄只影响挂载该预设的会话。
- **不静默**：模式全部未命中时**不调用** `restrict`（宿主对未知工具名抛错）并记入 `unmatched`；`restrict` 抛错时插件仍加载，`status` 报 `applied=false` + 原因。
- **可见性而非安全边界**：被 deny 的工具对模型不可见，但进程仍有该能力——需要真隔离请用沙箱，不要用 deny 当防线。
- **同预设多会话共享档位**：宿主把过滤在「呈现/查找/执行」三处保持一致，同一 preset 的多个会话共享 standing mount，一处切换处处一致。
- **`savedTokens` 是估算**：宿主口径 4 字符/token 的单工具之和，与整份 header 计价存在数个百分点差异。
- **零副本**：本插件 `node_modules` 以 junction 指向宿主 store，避免 `@deepseek-ai/*` 本地副本造成的版本滞后与运行期 class 漂移。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `context-stewardship` | 上下文管理：把工具 schema 固定成本纳入「主动管理」的判据 |
| 技能 `plugin-maintainability` | 插件可维护性工程（审计留痕 / 五问可取 / 观测不反噬） |
| 技能 `dsh-plugin-pitfalls` | scoped 包名键名、模块双实例、schema 严格校验等踩坑规避 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。

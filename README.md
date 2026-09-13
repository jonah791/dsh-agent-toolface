# dsh-agent-toolface

工具面分档插件：把「模型可见的工具集合」按**证据化的 deny 集**收窄，并提供一键恢复。

## 定位

一次请求的工具 schema 是**固定上下文成本**——压缩回收不掉，且工具越多、模型的选择越被稀释。实测（2026-09-13，本机）：

| 指标 | 值 |
|------|-----|
| 工具面总量 | 274 个工具 / 122,076 字符 ≈ **30,519 tok** |
| 其中被本插件默认收窄 | 67 个工具 / 30,830 字符 ≈ **7,708 tok（25.3%）** |
| 这 67 个工具近 14 天的调用 | **29 次**（同期总调用 11,600 次 = 0.25%） |

被收窄的族：`sec_*` `red_*` `blue_*` `otw_*` `xp_*` `clyan_*` `video_*` `download_*`。

**它不删除能力**：被收窄的工具仍在注册表中，`toolface(action="full")` 一行恢复。

## 安装与挂载

本插件应挂在 **agent preset**（不是宿主组合）——宿主 `ctx.tools.restrict()` 只接受有作用域的 ctx（拒绝进程级收窄，理由是会掩蔽所有 agent），而 preset 行天然是 agent 作用域：收窄只影响挂载该预设的会话。

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

前置：profile 的 `node_modules` 里能解析到 `dsh-agent-toolface`（与其它自研插件同款链接）。

## 工具 `toolface`

| 参数 | 说明 |
|------|------|
| `action` | `status` 查看 / `lean` 收窄 / `full` 恢复全量 |
| `deny` | 可选，`lean` 时覆盖配置的模式（精确名或尾随 `*` 前缀） |

返回：`{ ok, mode, applied, deniedCount, globalTools, savedChars, savedTokens, unmatched[], reason? }`。

> `globalTools` 是**全局面**工具数（preset 作用域读到的 `schemas()` 是全局视图，含其他预设挂载的工具），不是本会话的模型可见数——后者由请求头 `tools` 实测（本机：收窄前 274 → 收窄后 208）。

## 技术要点

- **纯逻辑可测**：模式解析（`expandPatterns`）、体量估算（`faceCost`）、档位决策（`denyFor`）、审计行（`auditLine`）全在 `src/logic.ts`，离线单测 13 项。
- **不静默**：模式全部未命中时**不调用** `restrict`（宿主对未知工具名抛错）并记入 `unmatched`；`restrict` 抛错时插件仍加载，`status` 报 `applied=false` + 原因。
- **审计留痕**：每次「加载/切换/补挂」追加一行 JSON 到 `${DSH_HOME}/toolface-events.log`。
- **不持久化放宽**：档位是会话运行期状态，重启回到 preset 配置的默认档——一次临时放开不会变成长期默认。
- **零副本**：本插件的 `node_modules` 以 junction 指向宿主 store，避免 `@deepseek-ai/*` 插件本地副本造成的版本滞后与运行期 class 漂移。

## 限制与未决

- 收窄是**可见性**而非安全边界（能力 ≠ 沙箱）：被 deny 的工具对模型不可见，但进程仍有该能力。
- 同一预设的多个会话共享该预设的 standing mount，因此档位对它们共享（一处切换处处一致）——这是宿主「过滤在呈现/查找/执行三处一致」的设计取向。
- `savedTokens` 是按宿主口径（4 字符/token）估算的单工具之和，与整份 header 计价存在数个百分点差异。
- 语义文档（判据/不变量/验收）见 `docs/semantic.md`。

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT

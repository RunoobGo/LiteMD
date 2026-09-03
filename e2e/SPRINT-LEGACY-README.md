# e2e/sprint1-3,5 — 历史脚本（已降级，**不在有效集中**）

> 状态：2026-09-03 v0.2.9 全面测试时复核为「断言失效」，未修复。

## 失效原因
- 这些脚本写成时前端通过 `window.go` 桩注入到 dev.html（pre-`__litemd__bindings` 体系）。
- 现有效集 sprint4~11 已统一改为读取 `window.__litemd__bindings`（Wails v2.14 标准导出的绑定对象），sprint1-3/5 内的 `window.go.xxx` 引用全部 null/undefined。
- 此外 sprint5 原「自动更新」检查项在 v0.2.0 后已删除（CHANGELOG 勘误）——该项断言永远失败。

## 覆盖内容（参考价值）
| 脚本 | 原覆盖 | 现有效集补充 |
|---|---|---|
| sprint1 | 启动屏 + tabs + 标签新建/关闭 | sprint7（标签/视图）+ sprint4（启动） |
| sprint2 | CodeMirror + 实时预览 + 分屏 + XSS + 视图切换 | sprint8（XSS）+ sprint9（导航） |
| sprint3 | Obsidian 双链/Callout/YAML/图片资产 | sprint10（Obsidian）+ sprint11（Mermaid 之外的媒体） |
| sprint5 | 启动屏 + 主题 + LaTeX | sprint7（主题）+ sprint11（LaTeX） |

## 后续路径（**已记录到 ROADMAP R9**）
R9 优先级已与 TECHNICAL §8.2 对齐为 P1，纳入未来 sprint 12 计划：把 sprint1-3/5 改为
`__litemd__bindings` 注入 + 移除自动更新项，或者删除。

> 修改纪律：本文档属"历史快照"，按 archive 冻结原则，本文件不可被现有 E2E 引用。

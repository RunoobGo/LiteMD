# LiteMD 第二轮审计总结（2026-09-03）

> **一页版结论**：第一轮审计（[AUDIT-2026-09-03.md](./AUDIT-2026-09-03.md)）7 项 P1 全部修复并发布 v0.2.9 后，本轮对 R1-R8 新增代码（macOS OnFileOpen、字号持久化、LaTeX 闸门、CI、E2E 降级等）做**第二轮**静态审计 + 文档对齐 + 测试补强。

---

## 结论先行

| 项 | 数 | 状态 |
|---|---|---|
| **P0（数据丢失/安全）** | **0** | 无新增 |
| **P1（正确性/UX）** | **9 后端 + 11 前端 = 20** | **全部修复** |
| **P2（清理/UX）** | **18** | **全部修复** |
| **新增测试** | **Go 12 + 前端 6 套件（96+ 断言）** | **全绿** |

---

## 修复分布

### 错误码体系 F1（最关键）
- Go 15 个 Code 常量 + 哨兵加 `[code]` 前缀
- [errcode.go](../../errcode.go) `CodeOf(err)` 辅助（穿透 wrap 链）
- 前端 [errcode.ts](../../frontend/src/errcode.ts)：`errCode` / `hasCode` / `EC` 常量 / `ErrorCode` 类型
- main.ts 6 处 `e.message.includes("...")` 切到 `errCode(e) === EC.xxx`
- 测试：`TestErrorTextContractForFrontend` 扩 3→6 哨兵 + `TestErrorCodeOf_Wrapped` + `errcode.test.ts` 33 例

### 后端 G1-G11（健壮性 + 安全）
- **G1** fileio 错误文案只露 basename（`publicPath` helper）
- **G2** `AllowSVG` 改 `atomic.Bool` + `TestAllowSVG_ConcurrentReadWrite` 4写8读×200轮
- **G3** `extractStartupFiles` 加 `links.CheckEditable` 过滤 + 真实 .exe 落盘测试
- **G5** `SaveFile` stat 错误不再静默 fallthrough
- **G6** `ErrMalformedPath` 新增（百分号编码损坏）
- **G7** `CopyImageAsset` 0 测试 → 5 用例（[app_asset_test.go](../../app_asset_test.go)）
- **G8** `SaveFile` expectMtime 冲突测试（[app_save_conflict_test.go](../../app_save_conflict_test.go) 3 例）
- **G9** 6 处散落 `errors.New(...)` 提为 package-level 哨兵
- **G10** OpenDialog/SaveDialog 移除 All Files 过滤
- **G11** 空 `shutdown` 钩子从 main.go 解挂
- **G14/G15** `MaxRecentFiles` / `MaxAssetNameLen` 提 const

### 前端 F2-F17（健壮性 + 性能 + 清理）
- **F2** `formulaCache` 改 LRU（thundering herd 修复）
- **F3** mermaid SVG 注入前过 `DOMPurify.sanitize(svg, { USE_PROFILES: { svg, svgFilters } })`
- **F4** `scheduleSync` 加代际序号防 stale
- **F5** `manualChunks` 改前缀正则
- **F7** `__litemd__bindings` 守 `import.meta.env.DEV`
- **F8** mermaid `renderChain` 周期重置
- **F9** mocks.ts 自替死代码删除
- **F10** `HUGE_LENGTH_RE` 正则去重
- **F11** LaTeX `errorColor` 走 CSS 变量
- **F12** 主题首启读 `prefers-color-scheme`
- **F13** CALLOUT_RE 改字符串源 + 局部实例
- **F14** UX 时长字面量集中常量
- **F15** pushRecent 静默失败加注释
- **F16** font-size 防抖 + `flushFontSizePersist`
- **F17** `tabs.findByPath` + onImageDrop 改 path 反查

### 测试补强（6 新套件）
- [tabs.test.ts](../../frontend/src/tabs.test.ts) `findByPath` 7 例
- [file-ops.test.ts](../../frontend/src/file-ops.test.ts) bind fallback chain 7 例
- [sidebar.test.ts](../../frontend/src/sidebar.test.ts) clamp + 状态机 + 持久化 21 例
- [splitpane.test.ts](../../frontend/src/splitpane.test.ts) 键盘 + 拖拽 + 边界 28 例
- [errcode.test.ts](../../frontend/src/errcode.test.ts) 33 例
- Go：`TestPublicPath_AuditG1` (5) + `TestReadText_ErrorMessage_BasenameOnly` + `TestResolveMalformedPath`

---

## 文档同步

- [README.md](../../README.md) 扩展名关联 5 个（md/markdown/mdown/mkd/mkdn）
- [README.md](../../README.md) 快捷键 `Ctrl+Shift+F` → `Ctrl+H` 修正
- [TECHNICAL.md](../TECHNICAL.md) §5.3 macOS OnFileOpen 状态更新
- [TEST-MATRIX.md](../test/TEST-MATRIX.md) 11 套件 → 15 套件 + Go 69 → 73 Test
- [AUDIT-2026-09-03.md](./AUDIT-2026-09-03.md) macOS Finder 🟢 + 11 套件 → 11 套件
- [PRINCIPLES.md](../design/PRINCIPLES.md) 新增约定 #16-#22（7 条）
- [CHANGELOG.md](../../CHANGELOG.md)「[未发布]」段补 R2 完整记录
- [README.md](../README.md) 导航门户更新（AUDIT-R2 进入生命周期矩阵）

---

## 验证

```
go test ./... -race -count=1                  → 4 packages OK
LITEMD_TEST=all 前端                          → 15/15 套件全绿
npx tsc --noEmit                              → 无错误
npx vite build                                → 主 chunk 61KB / gzip 22KB
```

---

## 未修复（按约束"无瓶颈不重构"延后）

- S6 navGuard 缓冲（无实测瓶颈）
- editor undo 隔离（依赖 CodeMirror 完整 setup，单测成本高，靠 E2E）
- preview renderGen 旧结果丢弃（E2E 已覆盖，缺单测）

---

*维护：R3 批次发起时，把 R1/R2 标记为"✅ 完成"并归档本摘要。*

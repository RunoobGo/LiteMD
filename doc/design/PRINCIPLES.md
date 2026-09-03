# LiteMD 设计原则与工程约定

> 本文件是跨模块的**设计契约**：所有新代码必须遵循。用于约束 Vibe Coding 风格下的长期一致性，避免原则散落各处。
> 原则 #1-10 源自历史文档 `archive/CODE_WIKI.md` §11（v0.2.0），已针对 v0.2.9 校正；工程约定补充自审计记忆。

---

## 一、设计原则

| # | 原则 | 说明 | 当前代码锚点 |
|---|---|---|---|
| 1 | **绑定统一返回 `(T, error)`** | 前端用 `try/catch` 处理；错误用 `errors.Is` 分类（`ErrNotFound` / `ErrIsBinary`） | `app.go` 各绑定方法 |
| 2 | **原子写** | 所有文件写入（配置、文档、图片）走「同目录临时文件 + fsync + `os.Rename`」，防崩溃半写 | `internal/fileio/fileio.go` |
| 3 | **配置降级** | 配置文件损坏时回退默认值（`ErrCorrupted`），永不阻塞用户使用 | `internal/config/config.go` |
| 4 | **dirty 与磁盘解耦** | `liveContent !== baseline` 即脏，与是否落盘无关；切 tab 不丢内容 | `frontend/src/tabs.ts` |
| 5 | **双模式前端** | 同一份 `src/`：`window.go` 存在用真实绑定，否则用 mock；`bind()` 统一 fallback | `frontend/src/file-ops.ts`（`bind()`） |
| 6 | **XSS 多层防护** | DOMPurify 严格白名单 → link 强制 rel/target → DOM 兜底 scrub 剥离 `on*`/`script`/`javascript:` | `frontend/src/preview.ts`（DOMPurify 配置） |
| 7 | **预览 debounce** | 16ms（约一帧）节流，连打字不全量重解析；切 tab/初始化走立即渲染；大文档按大小分档 | `frontend/src/main.ts`（防抖分档） |
| 8 | **性能优先** | 不引入 language-data 全量语言（省 ~200KB）；`OpenFile` 用 `stat.ModTime` 而非 `time.Now`；UPX 压缩二进制；大文档分块缓存 + 共享 `DOMParser` | `frontend/src/preview.ts`（BLOCK_CACHE） |
| 9 | ~~**更新节流**~~ | ~~`CheckForUpdate` 24h 节流~~ —— ⚠️ **已随自动更新模块移除**（2026-08-31），原则废止，见 CHANGELOG 勘误 | — |
| 10 | **测试钩子** | `window.__litemd__{split,cm,tm,preview,bindings,mockfs,unsavedCount}` 供 E2E 注入与断言 | `frontend/src/main.ts` / `file-ops.ts` |

**新增约定（v0.2.9，源自审计）**：

| # | 约定 | 说明 | 锚点 |
|---|---|---|---|
| 11 | **跨语言错误文案契约** | 前端对 Go 错误 message 做子串匹配（Wails 无法 `errors.Is`）。`ErrExternalModified` / `ErrNoBase` / `ErrNotLocal` 三个 sentinel 文案被 `TestErrorTextContractForFrontend` 钉死，**不得改动** | `app_test.go` + `main.ts` branches |
| 12 | **主题选择器必须限定作用域** | 样式修改一律针对 `:root[data-theme]` 选择器，避免明暗两套主题互相冲突 | `frontend/src/style.css` |
| 13 | **同步滚动锁分向** | `lockPreviewUntil` / `lockEditorUntil` 双向锁（120ms 时间戳），防事件 ping-pong | `frontend/src/sync-scroll`（预览管线） |
| 14 | **任务列表占位符还原** | GFM 复选框：先用占位符替换 `<input>`，DOMPurify 清洗后再还原，避免 input 标签被 strip | `frontend/src/preview.ts` |
| 15 | **IPC 路径只接受受控输入** | 前端传入的 path 一律后端二次校验：类型白名单、凭据黑名单、可执行扩展黑名单、资产写入由后端推导目录 | `internal/links/`、`internal/fileio/safepath.go` |

---

## 二、主题配色方案

> 源自 `archive/CODE_WIKI.md` §13。CSS 变量驱动双主题，所有组件只引用变量不写死色值（正文按 WCAG AA ≥4.5:1）。通过 `<html data-theme="dark|light">` 切换，持久化到 `localStorage("litemd:theme")`，默认暗色。

### 暗色主题（默认）— GitHub Dark 风格

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--bg-0 / --bg-1 / --bg-2 / --bg-3` | `#0D1117 / #161B22 / #21262D / #30363D` | 背景梯度 |
| `--fg-0 / --fg-1 / --fg-2` | `#F0F6FC / #C9D1D9 / #8B949E` | 文字层级 |
| `--accent` | `#58A6FF`（蓝） | 强调色 |
| `--brand-a / --brand-b` | `#58A6FF / #A5D6FF` | 品牌渐变 |
| `--danger / --warn / --ok` | `#F85149 / #D29922 / #3FB950` | 状态色 |

### 亮色主题 — 浅护眼配色（豆沙绿 / 米杏）

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--bg-0` | `#FBF8F1`（米杏） | 主背景 |
| `--bg-1` | `#F2EEE0` | 顶栏 / 标签栏 / 状态栏 |
| `--bg-2 / --bg-3` | `#E8E2D0 / #D8D2BE` | 悬停 / 弹层 |
| `--border / --border-strong` | `#D9D2BD / #B9B29C` | 米褐边框 |
| `--fg-0 / --fg-1 / --fg-2` | `#2A2722 / #3D3A33 / #6B6759` | 深褐文字 |
| `--accent / --accent-fg` | `#5B7A5B / #FBF8F1` | 豆沙绿强调色（对比 4.9:1） |
| `--danger / --warn / --ok` | `#B54848 / #A87B2A / #4F8050` | 降饱和状态色 |

**要点**：`--md-*` 文案元素随亮色重校（标题深豆沙/暖褐、链接豆沙绿、行内代码棕橙、引用米褐）；顶栏用双变量渐变 `var(--bg-1)→var(--bg-0)` 不引用硬编码暗色；分屏把手中央竖线默认隐藏、仅悬停/拖动按需淡出。

---

*维护：新增跨模块约定时追加到「新增约定」表，并同步更新 `doc/README.md` 维护纪律。*
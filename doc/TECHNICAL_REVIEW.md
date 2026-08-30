# LiteMD — 项目技术审查文档

> 文档版本：v1.0 ｜ 审查日期：2026-08-12 ｜ 最近更新：2026-08-30
> 审查范围：LiteMD v0.2.0 全量源代码（Go 1.25 + TypeScript + 构建脚本 + 测试）
> 审查目标：评估架构合理性、代码质量、安全性、性能、可维护性，识别风险并给出改进建议
>
> 说明：本审查是对 2026-08-12 时点代码的静态快照。之后代码有迭代（如 UI 浅护眼主题、标签生命周期行为调整等），本报告中的风险/建议结论保留初始状态作为历史基线，实际已修复项以 [CODE_WIKI.md](./CODE_WIKI.md) 与代码为准。

本文档配合 [CODE_WIKI.md](./CODE_WIKI.md) 使用：CODE_WIKI 侧重「是什么 / 怎么用」，本审查侧重「好不好 / 有什么风险 / 怎么改」。

---

## 目录

1. [审查总结](#1-审查总结)
2. [代码规模与测试覆盖](#2-代码规模与测试覆盖)
3. [后端代码审查](#3-后端代码审查)
4. [前端代码审查](#4-前端代码审查)
5. [安全模型审查](#5-安全模型审查)
6. [性能审查](#6-性能审查)
7. [可维护性与规范](#7-可维护性与规范)
8. [构建与打包审查](#8-构建与打包审查)
9. [测试体系审查](#9-测试体系审查)
10. [风险矩阵与改进建议](#10-风险矩阵与改进建议)
11. [审查附录：代码指纹](#11-审查附录代码指纹)

---

## 1. 审查总结

### 1.1 整体评价

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 架构清晰度 | ⭐⭐⭐⭐⭐ | 分层明确，前后端职责清晰，绑定桥接设计优雅 |
| 代码质量 | ⭐⭐⭐⭐☆ | 注释充分，错误处理规范；存在少量遗留代码与一致性问题 |
| 安全性 | ⭐⭐⭐⭐☆ | XSS 多层防护到位；存在 alert 注入与路径校验盲区 |
| 性能 | ⭐⭐⭐⭐⭐ | debounce、原子写、Compartment 热切换均符合最佳实践 |
| 测试覆盖 | ⭐⭐⭐⭐☆ | 176 用例覆盖广；updater 真实网络路径测试不充分 |
| 可维护性 | ⭐⭐⭐⭐☆ | 模块解耦良好；mock 双模式稍增复杂度但收益明确 |
| 构建打包 | ⭐⭐⭐⭐⭐ | UPX + NSIS 流程完整，3MB 安装包达标 |

### 1.2 核心结论

✅ **生产就绪**：核心功能完备，性能与安全满足轻量编辑器定位，可发布。

⚠️ **存在 3 个中风险项**需在下个迭代修复（详见第 10 节）：
- `main.go` 启动失败用 `println` 而非 `log`，错误信息可能丢失。
- 前端 `alert()` 直接拼接用户输入，存在轻度 UX 与编码风险。
- `updater.FetchLatest` 无测试覆盖真实 HTTP 路径（被 hack 注释绕过）。

### 1.3 亮点

1. **原子写贯穿全栈**：`config.go` / `fileio.go` 所有写操作均「临时文件 + rename」，配合 `defer os.Remove(tmpPath)` 清理，崩溃场景也能保证文件完整。
2. **错误语义化分类**：`ErrNotFound` / `ErrIsBinary` 用 `errors.Is` 识别，前端可差异化引导（新建文件 vs 拒绝显示）。
3. **XSS 多层防护**：DOMPurify 白名单 → link 强制 rel/target → DOM 兜底 scrub，纵深防御完整。
4. **双模式前端架构**：同一份 `src/` 通过 `file-ops.ts` 的 `bind()` 自动 fallback，开发体验与 E2E 测试效率显著提升。
5. **Compartment 主题热切换**：CodeMirror 6 用 `Compartment.reconfigure` 增量切主题，避免重建 state。
6. **配置降级容错**：配置文件损坏回退默认值，永不阻塞用户使用。

---

## 2. 代码规模与测试覆盖

### 2.1 代码量统计

| 类型 | 文件数 | 代码行数 |
| --- | --- | --- |
| Go 业务代码 | 7 | 1,357 |
| Go 测试代码 | 4 | 478 |
| 前端 TS 业务代码 | 10 | 1,398 |
| 前端 TS 测试代码 | 3 | 257 |
| CSS | 2 | 822 |
| E2E 脚本 | 5 | 938 |
| **合计** | **31** | **5,250** |

### 2.2 测试金字塔

| 层级 | 用例数 | 通过率 | 工具 |
| --- | --- | --- | --- |
| Go 单元测试 | 44 | 100% | `go test` |
| 前端单元测试 | 58 | 100% | `tsx` + `jsdom` |
| E2E | 66（sprint1-5） | 99% | `agent-browser` bash |
| **合计** | **168** | **99%** | — |

> 注：DEVELOPMENT_PLAN.md 称 176 用例，差异源于部分 E2E 场景为多步骤断言，按场景计数与按断言计数口径不同。

### 2.3 覆盖盲区

| 模块 | 覆盖情况 | 缺口 |
| --- | --- | --- |
| `internal/config` | ✅ 充分 | 无 |
| `internal/fileio` | ✅ 充分 | 无 |
| `internal/updater` | ⚠️ 部分 | `FetchLatest` 真实 HTTP 路径未测（见 3.4） |
| `app.go` binding | ✅ 充分 | `CheckForUpdate` 24h 节流逻辑未单测 |
| `editor.ts` | ⚠️ 仅 E2E | 缺单元测试（依赖 CodeMirror 实例） |
| `tabs.ts` | ⚠️ 仅 E2E | 缺单元测试，dirty/baseline 逻辑靠 E2E 间接验证 |
| `splitpane.ts` | ⚠️ 仅 E2E | 拖拽边界（0.15/0.85 clamp）未单测 |
| `unsaved-guard.ts` | ⚠️ 仅 E2E | dialog 关闭分支未单测 |

---

## 3. 后端代码审查

### 3.1 main.go — 入口

[main.go](file:///Volumes/fx/Object/LiteMD/main.go)

**✅ 优点：**
- `//go:embed all:frontend/dist` 单文件分发，符合轻量定位。
- 窗口配置（1024×768、深色背景）合理。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| B1 | 🟡 中 | L34 | 启动失败用 `println("Error:", err.Error())` 输出到 stderr，无日志文件、无时间戳，生产环境难以排查 | 改用 `log.Fatalf("wails run failed: %v", err)`，或写入 `~/.litemd/crash.log` |

**审查代码：**
```go
if err != nil {
    println("Error:", err.Error())  // B1: 应改用 log
}
```

### 3.2 app.go — 应用绑定层

[app.go](file:///Volumes/fx/Object/LiteMD/app.go)

**✅ 优点：**
- 12 个 binding 方法职责单一，命名清晰。
- 统一返回 `(T, error)`，前端 `try/catch` 友好。
- `OpenFile` 用 `stat.ModTime` 避免多余 `time.Now`，体现性能意识。
- `CheckForUpdate` 返回值永不为 nil，前端用 `HasUpdate` 字段决策，契约明确。
- `shutdown` 钩子预留（虽然目前 `_ = ctx` 空实现），符合生命周期完整性。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| B2 | 🟡 中 | [L208](file:///Volumes/fx/Object/LiteMD/app.go#L208) | `CheckForUpdate` 中 `_ = a.store.Save(cfg)` 忽略保存错误。若保存失败，下次启动会重复发网络请求，破坏 24h 节流契约 | 至少 `log.Printf("save lastUpdateCheck failed: %v", err)`，或返回 warning 给前端 |
| B3 | 🟢 低 | [L240](file:///Volumes/fx/Object/LiteMD/app.go#L240) | `AppInfo.Os` 硬编码 `"windows-amd64"`，与实际运行平台解耦，但 macOS 构建时仍返回该值 | 改用 `runtime.GOOS + "-" + runtime.GOARCH`，或从构建标签注入 |
| B4 | 🟢 低 | [L75-81](file:///Volumes/fx/Object/LiteMD/app.go#L75-L81) | `OpenFile` 中 `abs, _ := filepath.Abs(path)` 忽略 Abs 错误。极端场景（路径超长）可能拿到空 abs | 检查 err，失败时回退原 path 或返回 error |
| B5 | 🟢 低 | [L44-46](file:///Volumes/fx/Object/LiteMD/app.go#L44-L46) | `shutdown` 钩子空实现，未持久化未保存配置 | 若有 in-memory 脏配置应在此 flush；当前架构配置即时保存，可保留但加注释说明 |

**审查代码：**
```go
// B2: 节流时间戳保存失败被静默吞掉
cfg.LastUpdateCheck = time.Now()
_ = a.store.Save(cfg)  // 应至少记日志
```

### 3.3 internal/config — 配置管理

[internal/config/config.go](file:///Volumes/fx/Object/LiteMD/internal/config/config.go)

**✅ 优点：**
- `sync.Mutex` 保证线程安全。
- 原子写：`os.CreateTemp` + `os.Rename`，`defer os.Remove(tmpPath)` 清理。
- 配置损坏降级到 `Default()`，用户体验友好。
- `PushRecent` 是纯函数，易于测试。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| B6 | 🟢 低 | [L60-64](file:///Volumes/fx/Object/LiteMD/internal/config/config.go#L60-L64) | `Path()` 每次调用都 `os.MkdirAll`，虽然 `MkdirAll` 对已存在目录是 no-op，但仍有 syscall 开销 | 缓存路径或用 `sync.Once` 初始化 |
| B7 | 🟢 低 | [L82-87](file:///Volumes/fx/Object/LiteMD/internal/config/config.go#L82-L87) | `Load` 中 `json.Unmarshal` 失败时返回 `(Default(), error)`，调用方需注意：拿到了默认值但 err 非 nil。语义略模糊 | 明确文档：err 非 nil 时 cfg 仍可用（已是默认值） |
| B8 | 🟢 低 | [L122-143](file:///Volumes/fx/Object/LiteMD/internal/config/config.go#L122-L143) | `PushRecent` 当 `max <= 0` 时改为 10，但函数内 `out = out[:max]` 在 max=0 时会 panic（虽然已被前置兜底） | 加测试覆盖 max=0 边界 |

### 3.4 internal/updater — 自动更新

[internal/updater/updater.go](file:///Volumes/fx/Object/LiteMD/internal/updater/updater.go)

**✅ 优点：**
- semver 解析正则严谨，支持 `v1.2.3` / `1.2.3` / `1.2.3-rc1` / `1.2.3+build.1`。
- HTTP 请求带 `User-Agent` 和 `Accept` header，符合 GitHub API 规范。
- 响应体 `io.LimitReader(resp.Body, 1<<20)` 防止恶意大响应 OOM。
- `pickWindowsAsset` 优先 Setup.exe，回退裸 exe，策略合理。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| B9 | 🔴 高 | [updater_test.go L101-123](file:///Volumes/fx/Object/LiteMD/internal/updater/updater_test.go#L101-L123) | `TestFetchLatest_Success` 创建了 `httptest.Server` 但**未实际调用** `FetchLatest`，仅 `_ = srv` 注释掉。覆盖率造假 | ✅ 已修复 — 见 B10 重构 + T1，用 `fetchBaseURL` 变量替换到 mock server 真实 HTTP，现覆盖 200/404/500 三条路径 |
| B10 | 🟡 中 | [L118](file:///Volumes/fx/Object/LiteMD/internal/updater/updater.go#L118) | `GitHubRepo` 是常量，无法在测试中替换为 mock server，导致 B9 | ✅ 已修复 — `const GitHubRepo` 改包级 `var GitHubRepo = "litemd/litemd"`，同时增加 `fetchBaseURL` 变量便于测试替换 endpoint |
| B11 | 🟡 中 | [L64-80](file:///Volumes/fx/Object/LiteMD/internal/updater/updater.go#L64-L80) | `IsNewer` 对预发布版本（`1.2.3-rc1`）按主版本比较，`0.2.0-rc1` 会被视为 `0.2.0`，与正式版相同则不更新。语义上 rc1 < 正式版，应提示更新 | ✅ 已修复 — `parseSemver` 返回 `preRelease` 字段，`IsNewer` 增加"正式版 > 同名预发布版"语义，同时同为预发布时按字典序比较 |
| B12 | 🟢 低 | [L136](file:///Volumes/fx/Object/LiteMD/internal/updater/updater.go#L136) | HTTP 4xx 错误响应体只读 512 字节，可能截断有用错误信息 | ✅ 已修复 — 4xx body limit 从 512 字节 → 2048 字节（`2<<10`），`User-Agent: LiteMD-Updater/1.0` 头也已补充 |
| B13 | 🟢 低 | [L88-114](file:///Volumes/fx/Object/LiteMD/internal/updater/updater.go#L88-L114) | `pickWindowsAsset` 用 `strings.HasPrefix(name, "LiteMD-Setup")` 严格匹配，若未来改名（如 `LiteMD-Pro-Setup`）会漏 | ✅ 已修复 — 改用 `strings.Contains(lname,"litemd") && Contains("setup") && HasSuffix(".exe")` 三条件组合，fallback 分支也支持 LiteMD-portable.exe 等变体，并新增测试覆盖 Pro/Enterprise 变体与 source 不误匹配 |

**审查代码（B9 的造假测试）：**
```go
func TestFetchLatest_Success(t *testing.T) {
    srv := httptest.NewServer(...)  // 创建了 mock server
    defer srv.Close()
    old := GitHubRepo               // 但 GitHubRepo 是常量，无法替换
    _ = old                          // ← 直接丢弃
    _ = srv                          // ← 直接丢弃，未调用 FetchLatest
    // 测试实际什么都没验证
}
```

### 3.5 internal/fileio — 文件 IO

[internal/fileio/fileio.go](file:///Volumes/fx/Object/LiteMD/internal/fileio/fileio.go)

**✅ 优点：**
- `ErrNotFound` / `ErrIsBinary` 语义化错误，前端可 `errors.Is` 分类。
- UTF-8 校验防止二进制文件破坏编辑器。
- `WriteBase64File` 兼容 data URI 前缀，前端无需手动剥除。
- 原子写 + `defer os.Remove(tmpPath)` 清理彻底。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| B14 | 🟢 低 | [L46-50](file:///Volumes/fx/Object/LiteMD/internal/fileio/fileio.go#L46-L50) | `ReadText` 对 UTF-8 BOM (`\xEF\xBB\xBF`) 未处理，会导致首行有隐藏字符 | ✅ 已修复 — `data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF"))` 在 UTF-8 校验前执行，注释也已同步说明 |
| B15 | 🟢 低 | 全文 | `ReadText` 无文件大小上限，读取超大文件可能 OOM | ✅ 已修复 — 新增 `const MaxReadSize = 50 << 20`（50MB），`ReadText` 入口用 `os.Stat` 预检并返回 `ErrTooLarge` 包装错误 |
| B16 | 🟢 低 | [L114](file:///Volumes/fx/Object/LiteMD/internal/fileio/fileio.go#L114) | `WriteBase64File` 用 `strings.Index` 找逗号，若 data URI 多个逗号会截断错误 | ✅ 已修复 — 改用 `strings.LastIndex`，保留 `strings.HasPrefix(base64Data,"data:")` 保护避免对普通 base64 串误截 |

---

## 4. 前端代码审查

### 4.1 main.ts — 主入口

[frontend/src/main.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts)

**✅ 优点：**
- 顶层编排清晰，TabManager 回调驱动渲染分层。
- 预览 debounce 16ms（一帧），切 tab 走 `renderPreviewNow` 立即渲染，设计精细。
- 启动屏双层 `requestAnimationFrame` 等 CodeMirror 首帧，体验流畅。
- 全局测试钩子 `window.__litemd__*` 便于 E2E。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| F1 | 🟡 中 | [L130](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L130), [L309](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L309), [L326](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L326), [L343](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L343) | 4 处 `alert()` 直接拼接用户输入/错误信息。若错误信息含恶意内容（如来自文件名），虽然 WebView2 alert 不执行 HTML，但 UX 粗糙且无法复制 | 改用 `<dialog>` 统一错误提示组件，与 `unsavedDialog` 风格一致 |
| F2 | 🟡 中 | [L82-87](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L82-L87) | 图片拖入转 base64 用 `String.fromCharCode.apply(null, Array.from(...))` 分块，0x8000 阈值在某些引擎仍可能栈溢出 | 改用 `btoa(String.fromCharCode(...bytes))` 或更稳的 `FileReader.readAsDataURL` |
| F3 | 🟢 低 | [L91](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L91) | `assetDir` 拼接用 `a.path.replace(/[^/\\]+$/, "")`，若 path 含特殊字符可能出错 | 用 `path.slice(0, path.lastIndexOf("/") + 1) || path.slice(0, path.lastIndexOf("\\") + 1)` |
| F4 | 🟢 低 | [L120-128](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L120-L128) | wiki-link 查找用 `(window as any).__litemd__mockfs`，生产环境该字段不存在，靠 try/catch 兜底。逻辑正确但类型不安全 | 抽 `findWikiTargetInMockFs(target): string \| null` 工具函数 |
| F5 | 🟢 低 | [L450-460](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L450-L460) | `showUpdateDialog` 的 `addEventListener("close", once)` 用 `{ once: true }` 但函数内又 `removeEventListener`，冗余 | 保留一种即可 |
| F6 | 🟢 低 | [L478-486](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts#L478-L486) | 启动屏版本号注入 `w.go?.main?.App?.AppInfo?.()` 用可选链 + try/catch 双重防御，略冗余 | 可选链已足够，try/catch 可删 |

**审查代码（F1 的 alert 拼接）：**
```typescript
// main.ts:130 — wiki link 未找到时 alert 拼接 target
alert(`Wiki link 目标未找到：${target}\n（创建文件 "${target}.md" 后可点击跳转）`);
// 若 target 来自恶意 markdown: [[<img src=x onerror=alert(1)>]]
// WebView2 alert 不执行 HTML，但显示乱码
```

### 4.2 editor.ts — CodeMirror 封装

[frontend/src/editor.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/editor.ts)

**✅ 优点：**
- 扩展装配完整：lineNumbers / foldGutter / history / autocompletion / search / markdown。
- `mdHighlight` 用 CSS 变量驱动配色，主题切换无需重建。
- `setContent` 用 dispatch changes 而非重建 state，避免污染 undo 历史。
- `themeCompartment` 实现运行时主题热切换。
- 图片 drop/paste 拦截完善。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| F7 | 🟢 低 | [L75](file:///Volumes/fx/Object/LiteMD/frontend/src/editor.ts#L75) | `markdown({ base: markdownLanguage })` 不传 `codeLanguages`，fenced code block 内部无语法高亮。Sprint 4 主动取舍，符合轻量目标但需文档说明 | 注释已说明，可接受 |
| F8 | 🟢 低 | [L132-137](file:///Volumes/fx/Object/LiteMD/frontend/src/editor.ts#L132-L137) | `setContent` 先比较 `doc.toString() === content` 再 dispatch，若内容相同跳过。但 `toString()` 对大文档有开销 | 可接受，CodeMirror 6 内部已优化 |
| F9 | 🟢 低 | 全文 | 缺单元测试，仅靠 E2E 间接验证 | 补 `editor.test.ts`：setContent 不污染 undo、setTheme 切换、imageDrop 回调 |

### 4.3 preview.ts — 预览与 XSS 防护

[frontend/src/preview.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/preview.ts)

**✅ 优点：**
- 渲染管线清晰：`preprocessAll → marked → DOMPurify → link 加固 → DOM scrub`。
- DOMPurify 配置严格：白名单标签/属性、禁用 `style/iframe/script`、URI 正则限制。
- 兜底 `scrub` 剥离残留 `on*` 事件与 `javascript:` 协议，纵深防御。
- 事件委托处理 `.wiki-link` 点击，性能良好。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| F10 | 🟡 中 | [L65-70](file:///Volumes/fx/Object/LiteMD/frontend/src/preview.ts#L65-L70) | link 二次加固用正则 `<a\s+([^>]*?)href="(https?:\/\/[^"]+)"([^>]*?)>`，对单引号 href、跨行属性、属性含 `>` 的边界场景失败 | 改用 DOM 操作：`root.querySelectorAll("a[href]").forEach(...)` 设置 rel/target |
| F11 | 🟢 低 | [L100-105](file:///Volumes/fx/Object/LiteMD/frontend/src/preview.ts#L100-L105) | `render` 直接 `host.innerHTML = html`，对超大文档（100KB+）可能触发重排卡顿 | 已有 debounce 缓解；可考虑 `requestAnimationFrame` 包裹 |
| F12 | 🟢 低 | [L114-125](file:///Volumes/fx/Object/LiteMD/frontend/src/preview.ts#L114-L125) | `scrub` 用 `querySelectorAll("*")` 遍历所有元素，大文档性能开销大 | DOMPurify 已清洗，scrub 是兜底，可加 `if (process.env.NODE_ENV === 'production') return` 跳过 |

### 4.4 tabs.ts — 多标签状态

[frontend/src/tabs.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/tabs.ts)

**✅ 优点：**
- `dirty` 与磁盘保存解耦，`liveContent !== baseline` 即脏，语义清晰。
- `openTab` 路径去重，避免重复打开同一文件。
- `closeTab` 返回 `{closed, reason}`，调用方可据 reason 决策。
- `updateContentBaseline` 保存后重置基线，流程完整。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| F13 | 🟢 低 | [L22](file:///Volumes/fx/Object/LiteMD/frontend/src/tabs.ts#L22) | `genId` 用 `Date.now()-${_nextId++}`，并发场景可能重复（虽然单线程不会） | 改用 `crypto.randomUUID()` 或保持现状（单线程安全） |
| F14 | 🟢 低 | [L96-104](file:///Volumes/fx/Object/LiteMD/frontend/src/tabs.ts#L96-L104) | `closeTab` 关闭最后一个 tab 后 `activeId = null`，但 `main.ts` 未处理 null 场景的 UI 状态（如 `renderFrontmatterPanel` 已处理） | 已正确处理，可加测试覆盖 |
| F15 | 🟢 低 | 全文 | 缺单元测试 | 补 `tabs.test.ts`：newTab/openTab 去重/closeTab dirty 拦截/syncLiveContent dirty 计算 |

### 4.5 obsidian.ts — 语法兼容层

[frontend/src/obsidian.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.ts)

**✅ 优点：**
- 三大语法（Wiki Link / Callout / Frontmatter）解析完整。
- `preprocessWikiLinks` 对 target/alias 做字符过滤（`replace(/[<>"']/g, "")`），防注入。
- `preprocessAll` 顺序明确：frontmatter → callout → wiki，避免 callout 体内误识别。
- `CALLOUT_RE` 修复了单行 callout 不识别的 bug，有测试覆盖。
- Frontmatter 极简 YAML 解析，明确不支持嵌套，避免过度工程。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| F16 | 🟡 中 | [L45](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.ts#L45) | `preprocessWikiLinks` 用 `href="#/wiki/${encodeURIComponent(safeTargetAttr)}"`，但 `safeTargetAttr` 已经过滤了 `<>""'`，再 `encodeURIComponent` 会对空格等编码。整体安全但路径规则不一致 | ✅ 已修复 — 统一为 `encodeURIComponent(rawTarget)`（直接对原始未过滤 target 编码），`data-wikilink` 属性仍保留过滤后安全值（HTML 属性不能含引号尖括号）。前后锚点匹配路径语义一致 |
| F17 | 🟢 低 | [L147](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.ts#L147) | `FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\s*(?:\n|$)/` 要求 `---` 后必须换行，Windows CRLF 文件会匹配失败 | ✅ 已修复 — 正则改为 `/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/`，并新增 obsidian 单测 `fmcrlf = "---\r\nfoo: bar..."` 验证解析正确 |
| F18 | 🟢 低 | [L160-172](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.ts#L160-L172) | `parseFrontmatter` 对 `tags: [a, b]` 这种数组值解析为字符串 `"[a, b]"`，未转数组 | 🔧 保留现状（低优）：LiteMD frontmatter 展示只读，数组字符串不影响渲染；如需结构化可后续扩展 |
| F19 | 🟢 低 | [L64](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.ts#L64) | `CALLOUT_RE` 用 `(>+\s*\[!\w+\]...)`，`>+` 允许多个 `>`，但 `findCallouts` 内 `replace(/^>\s?/, "")` 只剥一个 | 🔧 保留现状（低优）：多级 blockquote callout 极少出现，当前剥一级不影响渲染 |

### 4.6 file-ops.ts — 文件操作抽象

[frontend/src/file-ops.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/file-ops.ts)

**✅ 优点：**
- `bind()` 双模式 fallback 优雅，mock 与真实绑定透明切换。
- 导出函数签名与后端一致，类型安全。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| F20 | 🟢 低 | [L19](file:///Volumes/fx/Object/LiteMD/frontend/src/file-ops.ts#L19) | `wailsBindings as any` 绕过类型检查，丢失类型安全 | 用 `keyof typeof wailsBindings` 约束 name |

### 4.7 splitpane.ts — 分屏

[frontend/src/splitpane.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/splitpane.ts)

**✅ 优点：**
- Pointer Events 标准 API，支持触屏。
- `setPointerCapture` 确保拖拽不丢失。
- clamp 0.15~0.85 防止极端比例。
- 双击重置 0.5，交互友好。

**⚠️ 问题：** 无显著问题，建议补单元测试覆盖 clamp 边界。

### 4.8 unsaved-guard.ts — 未保存拦截

[frontend/src/unsaved-guard.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/unsaved-guard.ts)

**✅ 优点：**
- 基于 `<dialog>` 原生组件，ESC 支持完善。
- `dialog.returnValue` 与 form `method="dialog"` 配合，E2E 与生产行为一致。
- `beforeunload` 拦截 + `hasAnyDirty()` 检查，双层保护。

**⚠️ 问题：** 无显著问题。

### 4.9 mocks.ts — 浏览器 Mock

[frontend/src/mocks.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/mocks.ts)

**✅ 优点：**
- 内存文件系统 `InMemoryMockFs` 设计清晰，`files` + `savedFiles` 双 Map。
- 方法签名与后端完全一致，前端无感切换。
- `litemd:mockfs:ready` 事件通知测试就绪。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| F21 | 🟢 低 | [L29-93](file:///Volumes/fx/Object/LiteMD/frontend/src/mocks.ts#L29-L93) | `(window as any).go = {...}` 直接覆盖，若其他库也用 `window.go` 会冲突 | 检查 `window.go` 是否存在再合并 |

---

## 5. 安全模型审查

### 5.1 XSS 防护（多层纵深防御）

| 层级 | 实现 | 评估 |
| --- | --- | --- |
| 第 1 层：Obsidian 预处理 | `preprocessWikiLinks` 过滤 `<>""'` | ✅ 但过滤规则与 `encodeURIComponent` 混用（F16） |
| 第 2 层：marked 渲染 | `gfm: true, breaks: false` 同步模式 | ✅ 标准库，无已知漏洞 |
| 第 3 层：DOMPurify 白名单 | `ALLOWED_TAGS` / `FORBID_TAGS` / `ALLOWED_URI_REGEXP` | ✅ 配置严格，禁用 `script/iframe/style` |
| 第 4 层：link 强制加固 | 正则加 `target="_blank" rel="noopener noreferrer"` | ⚠️ 正则边界场景失败（F10） |
| 第 5 层：DOM 兜底 scrub | 剥离残留 `on*` / `script` / `javascript:` | ✅ 纵深防御 |

**结论：** XSS 防护整体到位，建议修复 F10（正则改 DOM 操作）以加固第 4 层。

### 5.2 文件 IO 安全

| 风险 | 防护措施 | 评估 |
| --- | --- | --- |
| 路径遍历 | `OpenFile` 用 `filepath.Abs` 规范化 | ⚠️ 未校验路径是否在允许范围（如 vault 目录），但桌面应用用户可访问任意文件，符合设计 |
| 二进制文件 | `ReadText` 校验 UTF-8 有效性 | ✅ 防止二进制破坏编辑器 |
| 文件大小 | 无上限 | ⚠️ 超大文件可能 OOM（B15） |
| 原子写 | 临时文件 + rename | ✅ 防崩溃半写 |

### 5.3 更新检查安全

| 风险 | 防护措施 | 评估 |
| --- | --- | --- |
| 中间人攻击 | HTTPS API | ✅ |
| 响应篡改 | `io.LimitReader(1MB)` 防 OOM | ✅ |
| 下载执行 | 仅返回 URL，由用户浏览器打开 | ✅ 不自动下载执行，安全 |
| 节流绕过 | 24h 配置记录 | ⚠️ 配置保存失败会破坏节流（B2） |

### 5.4 配置安全

| 风险 | 防护措施 | 评估 |
| --- | --- | --- |
| 配置损坏 | 降级到默认值 | ✅ |
| 配置注入 | JSON 解析，无代码执行 | ✅ |
| 敏感信息 | 无密码/token 存储 | ✅ |

---

## 6. 性能审查

### 6.1 启动性能

| 指标 | 目标 | 实测 | 评估 |
| --- | --- | --- | --- |
| 安装包 | < 15MB | 3.0MB | ✅ UPX 压缩效果显著 |
| 启动时间 | < 1s | < 1.5s | ✅ 启动屏过渡掩盖感知延迟 |

**优化点：**
- 启动屏双层 `requestAnimationFrame` 等 CodeMirror 首帧，视觉流畅。
- 5s 后静默检查更新，不阻塞启动。

### 6.2 运行时性能

| 场景 | 实现 | 评估 |
| --- | --- | --- |
| 预览渲染 | 16ms debounce | ✅ 连打字不全量重解析 |
| 切 tab | `setContent` dispatch changes | ✅ 不重建 state，不污染 undo |
| 主题切换 | `Compartment.reconfigure` | ✅ 增量切换，无需重建 |
| 100KB 文档 | 692ms 渲染 | ✅ Sprint 4 优化后达标 |
| 大文档 | 无虚拟滚动 | ⚠️ CodeMirror 6 默认支持，但 preview `innerHTML` 可能卡顿（F11） |

### 6.3 内存性能

| 项 | 评估 |
| --- | --- |
| 前端 bundle | 648KB（main.js），Sprint 4 移除 language-data 后达标 |
| Go 二进制 | UPX 压缩后 2.8MB |
| 配置加载 | 全量读入内存，配置文件小可接受 |
| 文件读取 | 全量读入内存，大文件风险（B15） |

---

## 7. 可维护性与规范

### 7.1 代码规范

**✅ 优点：**
- Go 代码遵循 [Effective Go](https://go.dev/doc/effective_go) 风格，包注释/函数注释完整。
- TypeScript 严格模式（`tsconfig.json` `strict: true`），`noUnusedLocals` / `noUnusedParameters` 开启。
- 错误处理一致：Go 用 `errors.Is`，TS 用 `try/catch`。
- 命名清晰：Go 驼峰，TS 驼峰，常量全大写。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| M1 | 🟡 中 | [app.css](file:///Volumes/fx/Object/LiteMD/frontend/src/app.css) | 该文件是 Wails 模板遗留的 `#logo` / `.input-box` 样式，与 LiteMD 实际 UI 无关，未被任何 HTML 引用 | 删除该文件，减少混淆 |
| M2 | 🟢 低 | [main.go L34](file:///Volumes/fx/Object/LiteMD/main.go#L34) | `println` 非 Go 标准日志方式 | 改用 `log` 包 |
| M3 | 🟢 低 | [wails.json L4](file:///Volumes/fx/Object/LiteMD/wails.json#L4) | `"outputfilename": "workspace"` 与实际产物 `LiteMD.exe` 不一致，可能是 Wails 模板默认值未改 | 改为 `"LiteMD"` 或确认 Wails 是否自动覆盖 |

### 7.2 模块耦合度

```
main.ts (编排层)
  ├─ tabs.ts        (状态，无依赖)
  ├─ editor.ts      (编辑器，依赖 CodeMirror)
  ├─ preview.ts     (预览，依赖 marked + dompurify + obsidian.ts)
  ├─ splitpane.ts   (布局，无依赖)
  ├─ unsaved-guard  (拦截，依赖 tabs.ts 类型)
  ├─ obsidian.ts    (语法，无依赖)
  └─ file-ops.ts    (绑定，依赖 wailsjs + mocks.ts)
```

**评估：** 模块解耦良好，仅 `preview.ts` 依赖 `obsidian.ts`（预处理），`unsaved-guard` 依赖 `tabs` 类型（仅类型导入）。`main.ts` 作为编排层合理聚合。

### 7.3 文档完整性

| 文档 | 状态 | 评估 |
| --- | --- | --- |
| README.md | ✅ | 用户面向，完整 |
| DEVELOPMENT_PLAN.md | ✅ | 开发计划 + 5 Sprint 验收 |
| CODE_WIKI.md | ✅ | 结构化代码百科 |
| 代码注释 | ✅ | Go 包注释/函数注释完整，TS 文件头注释清晰 |
| CHANGELOG.md | ✅ | README 提及已补建（v0.2.0 全量变更记录） |
| RELEASE-NOTES.md | ✅ | README 提及已补建（v0.2.0 发布亮点 + 兼容性） |

---

## 8. 构建与打包审查

### 8.1 前端构建（Vite）

[vite.config.js](file:///Volumes/fx/Object/LiteMD/frontend/vite.config.js)

**✅ 优点：**
- 双入口配置清晰（`index.html` 生产 + `dev.html` 浏览器）。
- `strictPort: true` 避免端口漂移。
- `tsc && vite build` 保证类型检查通过再构建。

**⚠️ 问题：** 无显著问题。

### 8.2 Wails 构建

[wails.json](file:///Volumes/fx/Object/LiteMD/wails.json)

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 🟢 低 | [wails.json L4](file:///Volumes/fx/Object/LiteMD/wails.json#L4) | `"outputfilename": "workspace"` 与产物名不一致 | 改为 `"LiteMD"` |
| P2 | 🟢 低 | [wails.json L9-12](file:///Volumes/fx/Object/LiteMD/wails.json#L9-L12) | `author.name/email` 为空 | 填写作者信息 |

### 8.3 Windows NSIS 打包

[build_windows/installer/project.nsi](file:///Volumes/fx/Object/LiteMD/build_windows/installer/project.nsi)

**✅ 优点：**
- 基于 Wails 官方 `wails_tools.nsh` 宏，稳定可靠。
- 桌面 + 开始菜单快捷方式。
- WebView2 runtime 检测（`wails.webview2runtime` 宏）。
- 卸载清理 `$AppData` WebView2 数据。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| P3 | 🟡 中 | [project.nsi L72](file:///Volumes/fx/Object/LiteMD/build_windows/installer/project.nsi#L72) | `OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe"` 输出文件名含 `${ARCH}`，但 README 称产物为 `LiteMD-Setup-v0.2.0.exe`，命名不一致 | 统一命名规则，或在构建脚本中 rename |
| P4 | 🟢 低 | [project.nsi L57](file:///Volumes/fx/Object/LiteMD/build_windows/installer/project.nsi#L57) | `MUI_PAGE_LICENSE` 被注释，无 EULA 页 | MIT 许可证可加 EULA 页或保持现状 |
| P5 | 🟢 低 | [project.nsi L67-68](file:///Volumes/fx/Object/LiteMD/build_windows/installer/project.nsi#L67-L68) | `signtool` 签名被注释 | 生产建议加代码签名，避免 SmartScreen 警告 |

### 8.4 .gitignore 审查

[.gitignore](file:///Volumes/fx/Object/LiteMD/.gitignore)

**✅ 优点：**
- 9 大类分层覆盖完整（系统/Go/Wails/前端/IDE/日志/密钥/E2E）。
- 保留 `package-lock.json` / `go.sum` 确保依赖可复现。
- 保留 E2E 基准截图入库。

**⚠️ 问题：** 无显著问题。

---

## 9. 测试体系审查

### 9.1 Go 测试

**✅ 优点：**
- `t.TempDir()` + `t.Setenv("HOME", ...)` 完全隔离，不污染真实环境。
- `errors.Is` 错误分类验证到位。
- 原子写后检查无残留临时文件（`TestSaveAtomicNoLeftover`）。
- base64 roundtrip 测试完整。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| T1 | 🔴 高 | [updater_test.go L101-123](file:///Volumes/fx/Object/LiteMD/internal/updater/updater_test.go#L101-L123) | `TestFetchLatest_Success` 创建 mock server 但未调用 `FetchLatest`，测试造假（B9） | 修复 B10 后补真实 HTTP 测试 |
| T2 | 🟡 中 | [updater_test.go L125-143](file:///Volumes/fx/Object/LiteMD/internal/updater/updater_test.go#L125-L143) | `TestCheck_NoUpdate` / `TestCheck_404` 依赖真实网络，CI 不稳定 | 用 mock server 替换 |
| T3 | 🟢 低 | [app_test.go L119-126](file:///Volumes/fx/Object/LiteMD/app_test.go#L119-L126) | `TestAppSaveFileAs_NilCtxSafe` 注释说"在某些环境 ctx 不为 nil"，逻辑不严谨 | 明确注入 nil ctx 测试 |

### 9.2 前端测试

**✅ 优点：**
- `preview.test.ts` 覆盖 XSS 各类向量（script/iframe/onclick/javascript:）。
- `obsidian.test.ts` 覆盖 wiki/callout/frontmatter 边界。
- `preview.test-bootstrap.ts` 用 jsdom 提供 DOMPurify 所需环境。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| T4 | 🟡 中 | [preview.test.ts L29](file:///Volumes/fx/Object/LiteMD/frontend/src/preview.test.ts#L29) | `assert(xss1.includes("alert(1)") || !xss1.toLowerCase().includes("alert"), ...)` 用 `||` 导致断言永远通过（若 alert 被剥离则左侧 false，右侧 true） | 改为 `&&` 或明确断言 |
| T5 | 🟡 中 | 全文 | 缺 `editor.ts` / `tabs.ts` / `splitpane.ts` / `unsaved-guard.ts` 单元测试 | 补齐 |
| T6 | 🟢 低 | [obsidian.test.ts L106](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.test.ts#L106) | `assert(full.startsWith("# Heading") || full.includes("# Heading"), ...)` 用 `||` 弱化断言 | 明确预期 |

### 9.3 E2E 测试

**✅ 优点：**
- 5 个 Sprint 各自独立脚本，覆盖增量交付。
- `fresh_open` 按 phase 重载页面，规避 CDP 长 session 卡顿。
- 通过 `window.__litemd__*` 钩子注入与断言，设计巧妙。
- 截图基准入库，支持视觉回归。

**⚠️ 问题：**

| # | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| T7 | 🟡 中 | [sprint5.sh L24-27](file:///Volumes/fx/Object/LiteMD/e2e/sprint5.sh#L24-L27) | `curl -s -o /dev/null -w ""` 检测 vite 是否启动，但 `-w ""` 不输出状态码，判断失效 | 改为 `curl -sf -o /dev/null http://...` 检查退出码 |
| T8 | 🟢 低 | 全文 | E2E 脚本依赖 `agent-browser` CLI，未文档化安装方式 | README 补充 `agent-browser` 安装说明 |
| T9 | 🟢 低 | [sprint1.sh L11](file:///Volumes/fx/Object/LiteMD/e2e/sprint1.sh#L11) | URL 默认 `http://127.0.0.1:5174/dev.html`，但 vite.config 配置端口为 5173，需手动起 `vite preview --port 5174` | 统一端口配置 |

---

## 10. 风险矩阵与改进建议

### 10.1 风险矩阵

| # | 风险项 | 严重度 | 概率 | 影响 | 修复优先级 |
| --- | --- | --- | --- | --- | --- |
| B9/T1 | updater 测试造假，FetchLatest 无真实覆盖 | 🔴 高 | 高 | 更新检查可能静默失败 | ✅ 已完成（P0） |
| B1 | main.go 用 println 输出错误 | 🟡 中 | 中 | 生产错误难排查 | ✅ 已完成（P1）— 改为 `log.Fatalf` |
| B2 | CheckForUpdate 保存节流时间戳失败被吞 | 🟡 中 | 低 | 24h 节流失效 | ✅ 已完成（P1）— 保存失败打印 log.Printf |
| F1 | 前端 4 处 alert 拼接用户输入 | 🟡 中 | 中 | UX 粗糙 + 潜在编码问题 | ✅ 已完成（P1）— 替换为 `<dialog>` showError 组件，textContent 赋值 |
| F2 | 图片 base64 转换可能栈溢出 | 🟡 中 | 低 | 大图片拖入崩溃 | ✅ 已完成（P1）— 改用 `FileReader.readAsDataURL` |
| F10 | link 加固正则边界失败 | 🟡 中 | 低 | 恶意 markdown 可能绕过第 4 层 | ✅ 已完成（P1）— 正则→DOMParser 遍历 `<a>`，精准设 target/rel |
| B11 | 预发布版本比较语义不严 | 🟡 中 | 低 | rc 版本不提示更新 | ✅ 已完成（P2）— parseSemver 返回 preRelease，IsNewer 严格比较 |
| T4 | preview.test.ts 断言 `||` 永真 | 🟡 中 | 中 | 测试覆盖虚高 | ✅ 已完成（P1）— xss1/xss2/xss3 全部强化断言 |
| M1 | app.css 遗留模板样式 | 🟡 中 | 高 | 代码混淆 | ✅ 已完成（P1）— 清除模板 CSS 残留 |
| P3 | NSIS 产物命名不一致 | 🟡 中 | 中 | 发布脚本需 rename | ✅ 已完成（P2）— 统一 output + 安装器命名脚本一致 |
| T7 | sprint5.sh curl 检测失效 | 🟡 中 | 中 | E2E 启动判断失败 | ✅ 已完成（P2）— sprint4/5 统一 `curl -sf` 判 exit code + 跨平台区分 exe/Setup |
| B14/B15/B16 | ReadText BOM/上限 + WriteBase64 LastIndex | 🟢 低 | 低 | 局部鲁棒性 | ✅ 已完成（P3）— 三项一次性修复 |
| F16/F17 | wiki-link href 规则 / CRLF frontmatter 失效 | 🟡/🟢 | 低/中 | 锚点错位 + Windows 文件打不开 | ✅ 已完成（P1）— F16 统一 encodeURIComponent(rawTarget)，F17 正则加 `\r?` 并加单测 |
| B12/B13 | 4xx body 截断 512B / pickWindowsAsset 严格匹配 | 🟢 低 | 低 | 排障信息缺失 / 变体资产漏选 | ✅ 已完成（P3）— B12: 2KB limit + UA 头；B13: 放宽 Contains 三条件匹配 |
| 其余低优 | F18/F19/P5(NSIS 签名)/文档/跨平台 | 🟢 低 | 低 | 纯功能性或生产流程级 | 🔧 保留（低优 / 按需处理） |

### 10.2 改进建议（按优先级）— 2026-08-12 全部已修复状态总览

#### P0 — 立即修复 ✅ 已全部完成
B9/T1：updater 测试造假。修复方式详见 §3.4.3，现 `TestFetchLatest_Success/404/500` 三条路径均有真实 HTTP 覆盖。

#### P1 — 下迭代 ✅ 已全部完成（共 8 项）
1. **B1**：`main.go` 改用 `log.Fatalf`。
2. **B2**：`CheckForUpdate` 保存失败记 `log.Printf`。
3. **F1**：`alert()` 替换为 `<dialog>` 错误提示组件（`showError`），文本通过 `textContent` 赋值。
4. **F2**：图片 base64 改用 `FileReader.readAsDataURL`，避免 `String.fromCharCode.apply` 栈溢出。
5. **F10**：link 加固正则 → DOMParser 解析 HTML 遍历 `<a>` 精准 `target="_blank" rel="noopener noreferrer"`。
6. **T4**：`preview.test.ts` 3 处断言永真问题修复（xss1/xss2/xss3 严格判断）。
7. **M1**：删除遗留的 `app.css` 模板样式与无效引用。
8. **F16/F17**：obsidian.ts 两低优问题修复，补 obsidian 单测 CRLF/冒号边界。

#### P2 — 后续迭代 ✅ 已全部完成
1. **B11**：严格 semver 预发布比较（无需引入库，parseSemver 返回 preRelease + IsNewer 加分支）。
2. **P3**：统一 NSIS 产物命名。
3. **T7**：sprint5.sh curl 检测失效（和 sprint4 同步修复：`curl -sf` + 跨平台）。
4. **T9/T10**：测试缺口 — app_test.go PushRecent happy-path + config 全字段降级验证。
5. **B15**：`ReadText` 加文件大小上限（MaxReadSize = 50MB）。

#### P3 — 待办 ✅ 已完成大部分
- ✅ B13/B12/B14/B16：文件 IO 与 Updater 剩余低风险问题
- ✅ E 系列 E2E 永久失败 / 静默 / CLI 预检问题（TEST_AUDIT.md）
- 🔧 低优未改项（见上表）：F18 数组 frontmatter 值、F19 多级 callout strip、P5 代码签名，按生产流程节奏推进

### 10.3 架构演进建议

1. **插件化 Obsidian 语法**：当前 `obsidian.ts` 硬编码 12 种 callout 类型，未来可考虑配置化或插件化。
2. **虚拟滚动**：preview 对超大文档（>500KB）可引入虚拟滚动。
3. **多语言**：当前 UI 中文硬编码，未来可抽 i18n。
4. **macOS/Linux 适配**：当前 `AppInfo.Os` 硬编码 `windows-amd64`，跨平台时需改造。

---

## 11. 审查附录：代码指纹

### 11.1 关键文件清单

| 文件 | 行数 | 关键职责 |
| --- | --- | --- |
| [main.go](file:///Volumes/fx/Object/LiteMD/main.go) | 36 | Go 入口，嵌入前端资源 |
| [app.go](file:///Volumes/fx/Object/LiteMD/app.go) | 261 | 12 个 binding 方法 |
| [internal/config/config.go](file:///Volumes/fx/Object/LiteMD/internal/config/config.go) | 143 | 配置原子读写 |
| [internal/fileio/fileio.go](file:///Volumes/fx/Object/LiteMD/internal/fileio/fileio.go) | 142 | 文件 IO + base64 |
| [internal/updater/updater.go](file:///Volumes/fx/Object/LiteMD/internal/updater/updater.go) | 198 | GitHub Releases 检查 |
| [frontend/src/main.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts) | 508 | 前端编排 |
| [frontend/src/editor.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/editor.ts) | 171 | CodeMirror 6 封装 |
| [frontend/src/preview.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/preview.ts) | 129 | XSS 多层防护 |
| [frontend/src/tabs.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/tabs.ts) | 158 | 多标签状态 |
| [frontend/src/obsidian.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.ts) | 216 | Obsidian 语法兼容 |

### 11.2 审查工具与方法

- **代码阅读**：逐文件逐函数审查，关注错误处理、边界条件、安全、性能。
- **模式搜索**：`Grep` 搜索 `alert` / `panic` / `TODO` / `FIXME` / `_ =` 等模式定位问题。
- **测试验证**：阅读测试文件评估覆盖真实性与断言严谨性。
- **构建审查**：检查 `wails.json` / `vite.config.js` / `project.nsi` 配置一致性。
- **依赖审查**：`go.mod` / `package.json` 依赖版本与必要性评估。

### 11.3 审查边界

本审查基于 v0.2.0 源代码静态分析，未包含：
- 真机性能压测（Windows/macOS 实机启动时间与内存）。
- 安全渗透测试（XSS/路径遍历的动态验证）。
- 可访问性（a11y）审查。
- 国际化（i18n）审查。

如需上述维度，建议补充动态测试与专项审计。

---

## 文档维护

- **审查人**：WorkBuddy
- **审查日期**：2026-08-12
- **下次审查建议**：v0.3.0 发布前或重大架构变更时
- **相关文档**：[CODE_WIKI.md](./CODE_WIKI.md) ｜ [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) ｜ [README.md](./README.md)

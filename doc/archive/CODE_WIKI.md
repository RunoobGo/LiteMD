# LiteMD — Code Wiki

> **归档声明**：本文件为 v0.2.0 历史快照，当前代码已迭代至 v0.2.9。其精华已提炼至
> [doc/design/PRINCIPLES.md](../design/PRINCIPLES.md)（§11 设计原则、§13 主题配色）。
> 架构与目录详情以 [doc/TECHNICAL.md](../TECHNICAL.md) 为准，仅作历史追溯参考。

> 极致轻量 Markdown 编辑器（Windows x64）
> 版本：v0.2.0 ｜ 文档生成日期：2026-08-12 ｜ 最近更新：2026-08-30
> 技术栈：Wails v2.14（Go 1.25）+ CodeMirror 6 + TypeScript + Vite + marked + DOMPurify

本文档为 LiteMD 项目的结构化代码百科，覆盖整体架构、模块职责、关键类与函数、依赖关系及运行方式，便于新成员快速上手与后续维护。

---

## 目录

1. [项目概览](#1-项目概览)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [后端模块（Go）](#4-后端模块go)
   - 4.1 [入口层 main.go](#41-入口层-maingo)
   - 4.2 [应用绑定层 app.go](#42-应用绑定层-appgo)
   - 4.3 [internal/config 配置管理](#43-internalconfig-配置管理)
   - 4.4 [internal/fileio 文件 IO](#44-internalfileio-文件-io)
   - 4.5 [internal/updater 自动更新](#45-internalupdater-自动更新)
5. [前端模块（TypeScript）](#5-前端模块typescript)
   - 5.1 [main.ts 主入口与编排](#51-maints-主入口与编排)
   - 5.2 [editor.ts 编辑器封装](#52-editorts-编辑器封装)
   - 5.3 [preview.ts 预览与 XSS 防护](#53-previewts-预览与-xss-防护)
   - 5.4 [tabs.ts 多标签状态](#54-tabsts-多标签状态)
   - 5.5 [obsidian.ts 语法兼容层](#55-obsidiants-语法兼容层)
   - 5.6 [file-ops.ts 文件操作抽象](#56-file-opsts-文件操作抽象)
   - 5.7 [splitpane.ts 分屏容器](#57-splitpanets-分屏容器)
   - 5.8 [unsaved-guard.ts 未保存拦截](#58-unsaved-guardts-未保存拦截)
   - 5.9 [mocks.ts / dev-bootstrap.ts 浏览器 Mock](#59-mocksts--dev-bootstrapts-浏览器-mock)
6. [前后端绑定桥接](#6-前后端绑定桥接)
7. [依赖关系](#7-依赖关系)
8. [构建与打包流程](#8-构建与打包流程)
9. [测试体系](#9-测试体系)
10. [项目运行方式](#10-项目运行方式)
11. [关键设计原则与约定](#11-关键设计原则与约定)
12. [数据目录与配置](#12-数据目录与配置)
13. [主题配色方案](#13-主题配色方案)

---

## 1. 项目概览

**LiteMD** 是一款面向 Windows x64 平台的轻量级 Markdown 编辑器，定位为 Obsidian「快速捕获 + 轻量编辑」的伴侣应用（不取代 Obsidian 全功能）。

**核心能力：**

- 多标签编辑（开/关/切换，关闭未保存拦截）
- CodeMirror 6 代码编辑器（行号、Markdown 高亮、搜索、命令面板）
- 实时预览 + 可拖拽分屏（both / left / right 三模式）
- Obsidian 语法兼容：`[[双链]]`、`> [!callout]`、`--- frontmatter ---`
- 图片拖入/粘贴 → 自动复制到 `assets/` 并插入引用
- 配置持久化（`~/.litemd/config.json`，原子写）
- GitHub Releases 自动更新检查（24h 节流）
- NSIS 安装器 + UPX 压缩（安装包 ~3.0 MB）

**性能指标：**

| 指标 | 目标 | 实测 |
| --- | --- | --- |
| 安装包大小 | < 15 MB | 3.0 MB |
| 启动时间 | < 1s | < 1.5s |
| 100KB 文档渲染 | — | 692ms |
| 测试用例 | — | 176 用例，99% 通过 |

---

## 2. 整体架构

LiteMD 采用 **Wails v2** 的「Go 后端 + WebView 前端」混合架构。Go 负责系统级能力（文件 IO、配置、更新、对话框），前端负责全部 UI 与编辑器逻辑，二者通过 Wails 自动生成的 JS 绑定通信。

```
┌─────────────────────────────────────────────────────┐
│  Frontend（TypeScript + CodeMirror 6 + Vite）        │
│  ─ main.ts 编排 / editor.ts 编辑器 / preview.ts 预览 │
│  ─ tabs.ts 状态 / obsidian.ts 语法 / splitpane.ts 布局│
│  ─ 通过 window.go.main.App.* 调用后端                │
├─────────────────────────────────────────────────────┤
│  Wails Bindings（自动生成 TS/JS API）                │
│  ─ wailsjs/go/main/App.{d.ts,js} + models.ts         │
│  ─ file-ops.ts 统一封装（mock / 真实双模式 fallback）│
├─────────────────────────────────────────────────────┤
│  Backend（Go）                                       │
│  ─ app.go：App struct + 全部 binding 方法            │
│  ─ internal/config：~/.litemd/config.json 读写       │
│  ─ internal/fileio：原子文件读写 + base64 图片        │
│  ─ internal/updater：GitHub Releases 版本检查         │
├─────────────────────────────────────────────────────┤
│  Windows OS / WebView2 Runtime                       │
└─────────────────────────────────────────────────────┘
```

**关键架构特征：**

- **资源内嵌**：前端 `dist/` 通过 `//go:embed all:frontend/dist` 嵌入二进制，单文件分发。
- **双入口前端**：`index.html`（生产，嵌入 Wails）+ `dev.html`（浏览器/E2E，注入 mock），同一份 `src/` 代码兼容两种环境。
- **双模式绑定**：`file-ops.ts` 运行时通过 `window.go.main.App` 是否存在自动 fallback 到真实绑定或 mock。
- **生命周期钩子**：Wails 的 `OnStartup` 注入 `context.Context`，binding 方法借此调用原生对话框/浏览器。

---

## 3. 目录结构

```
LiteMD/
├── main.go                    # Go 入口：嵌入前端资源 + 启动 Wails
├── app.go                     # App struct + 全部前端可调 binding 方法
├── app_test.go                # binding 层单元测试
├── go.mod / go.sum            # Go 依赖（wails v2.14.0）
├── wails.json                 # Wails 项目配置
├── internal/
│   ├── config/
│   │   ├── config.go          # 配置结构 + Store（线程安全原子读写）
│   │   └── config_test.go
│   ├── fileio/
│   │   ├── fileio.go          # 文件读写 + base64 图片 + 错误语义
│   │   └── fileio_test.go
│   └── updater/
│       ├── updater.go         # GitHub Releases 检查 + semver 比较
│       └── updater_test.go
├── frontend/
│   ├── index.html             # 生产入口（嵌入 Wails）
│   ├── dev.html               # 浏览器/E2E 入口（mock 注入）
│   ├── package.json           # 前端依赖（codemirror 6 / marked / dompurify）
│   ├── vite.config.js         # 双入口构建配置
│   ├── tsconfig.json
│   ├── dist/                  # 构建产物（被 //go:embed）
│   ├── src/
│   │   ├── main.ts            # 主入口：编排所有模块
│   │   ├── editor.ts          # CodeMirror 6 封装
│   │   ├── preview.ts         # marked + DOMPurify 预览
│   │   ├── tabs.ts            # 多标签状态管理
│   │   ├── obsidian.ts        # 双链/Callout/Frontmatter 解析
│   │   ├── file-ops.ts        # 后端绑定统一封装
│   │   ├── splitpane.ts       # 可拖拽分屏
│   │   ├── unsaved-guard.ts   # 关闭未保存拦截
│   │   ├── mocks.ts           # 浏览器 mock 实现
│   │   ├── dev-bootstrap.ts   # 浏览器开发模式入口
│   │   ├── style.css / app.css
│   │   └── *.test.ts          # 前端单元测试
│   └── wailsjs/               # Wails 自动生成的 TS 绑定
│       ├── go/main/App.{d.ts,js}
│       ├── go/models.ts       # 后端 struct 的 TS 镜像
│       └── runtime/           # Wails runtime API
├── build_windows/             # Windows 打包（NSIS / icon / manifest）
│   ├── installer/project.nsi  # NSIS 安装脚本
│   └── info.json              # 版本信息资源
├── build_darwin/              # macOS 打包配置（Info.plist）
├── build/                     # 构建产物输出
├── e2e/                       # E2E 自动化脚本（sprint1-5.sh）
├── README.md
└── DEVELOPMENT_PLAN.md        # 开发计划 + 5 Sprint 验收记录
```

---

## 4. 后端模块（Go）

### 4.1 入口层 main.go

[main.go](file:///Volumes/fx/Object/LiteMD/main.go)

职责：嵌入前端资源、创建 Wails 应用实例、注册生命周期钩子与绑定。

```go
//go:embed all:frontend/dist
var assets embed.FS

func main() {
    app := NewApp()
    err := wails.Run(&options.App{
        Title:  "LiteMD",
        Width:  1024, Height: 768,
        AssetServer:    &assetserver.Options{Assets: assets},
        BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
        OnStartup: app.startup,
        Bind: []interface{}{app},
    })
    ...
}
```

要点：
- `//go:embed all:frontend/dist` 将构建产物嵌入二进制，实现单文件分发。
- `Bind: []interface{}{app}` 把 `App` 的所有公开方法暴露给前端。
- 窗口默认 1024×768，深色背景。

### 4.2 应用绑定层 app.go

[app.go](file:///Volumes/fx/Object/LiteMD/app.go)

`App` 是 Wails 应用主体，前端通过自动生成的 `wailsjs/go/main/App` 访问其方法。这是前后端的唯一桥梁。

**核心结构：**

```go
type App struct {
    ctx   context.Context   // Wails 注入，供对话框/浏览器 API 使用
    store *config.Store     // 配置持久化（注入便于测试）
}

const AppVersion = "0.2.0"  // 编译时版本号
```

**绑定方法清单：**

| 方法 | 签名 | 职责 |
| --- | --- | --- |
| `OpenFile(path)` | `(FilePayload, error)` | 读取 .md 文件，返回内容 + 绝对路径 + mtime |
| `OpenDialog()` | `(string, error)` | 弹出打开文件对话框，用户取消返回空串 |
| `SaveDialog(name)` | `(string, error)` | 弹出另存为对话框 |
| `SaveFile(path, content)` | `error` | 原子写入文本到指定路径 |
| `SaveFileAs(name, content)` | `(string, error)` | 对话框 + 写入，返回最终绝对路径 |
| `GetConfig()` | `(Config, error)` | 返回当前完整配置 |
| `SetConfig(cfg)` | `error` | 整体替换配置并持久化 |
| `PushRecent(path)` | `(Config, error)` | 推入最近文件（去重，最多 10 条） |
| `CheckForUpdate(force)` | `(CheckResult, error)` | 检查 GitHub Releases，24h 节流（force 绕过） |
| `OpenReleasePage(url)` | `error` | 用系统浏览器打开 release 页 |
| `AppInfo()` | `AppInfo` | 返回应用元信息（名称/版本/OS） |
| `CopyImageAsset(path, base64)` | `(string, error)` | 把 base64 图片写入磁盘资产目录 |

**设计约定：**
- 方法统一返回 `(T, error)`，前端 `try/catch` 处理。
- 错误优先用 `errors.Is` 判断类型（如 `fileio.ErrNotFound`、`fileio.ErrIsBinary`），便于前端分类提示。
- 不在 binding 内做重活，所有 IO 即时返回。
- `CheckForUpdate` 返回值永不为 nil，前端用 `HasUpdate` 字段决定弹窗；网络失败降级为 `HasUpdate=false, Error="..."`。
- `OpenFile` 读取 `stat.ModTime` 作为 `Modified`，避免多余 `time.Now` 调用；stat 失败退回 `time.Now()`。

**数据结构：**

```go
type FilePayload struct {
    Path     string `json:"path"`
    Content  string `json:"content"`
    Modified int64  `json:"modified"`   // Unix 时间戳
}

type AppInfo struct {
    Name    string `json:"name"`
    Version string `json:"version"`
    Os      string `json:"os"`
}
```

### 4.3 internal/config 配置管理

[internal/config/config.go](file:///Volumes/fx/Object/LiteMD/internal/config/config.go)

职责：用户配置的线程安全加载/保存，存储于 `~/.litemd/config.json`。

**Config 结构（最小字段集，零值默认兼容增量字段）：**

```go
type Config struct {
    Theme           string   `json:"theme"`           // "auto"|"light"|"dark"
    FontFamily      string   `json:"fontFamily"`
    FontSize        int      `json:"fontSize"`
    RecentFiles     []string `json:"recentFiles"`     // 最多 10 条
    WindowWidth     int      `json:"windowWidth"`
    WindowHeight    int      `json:"windowHeight"`
    KeyMap          string   `json:"keyMap"`          // "default"|"vim"|"emacs"
    CustomCSSPath   string   `json:"customCssPath"`
    LastUpdateCheck time.Time `json:"lastUpdateCheck"` // 24h 节流
}
```

**关键类型与函数：**

| 标识 | 说明 |
| --- | --- |
| `Store` | 配置持久化器，内含 `sync.Mutex` 保证线程安全 |
| `NewStore()` | 创建 Store |
| `Store.Path()` | 返回配置文件完整路径，目录不存在自动 `MkdirAll` |
| `Store.Load()` | 读取解析配置；文件不存在返回 `Default()` 不报错；损坏降级到默认 |
| `Store.Save(cfg)` | 原子写：临时文件 + `os.Rename`，避免半写损坏 |
| `Default()` | 默认配置（theme=auto, fontSize=14, 1024×768...） |
| `PushRecent(cfg, path, max)` | 纯函数：推入路径去重并截断到 max 条 |

**容错策略：** 配置文件损坏时降级到默认值，不阻塞用户使用。

### 4.4 internal/fileio 文件 IO

[internal/fileio/fileio.go](file:///Volumes/fx/Object/LiteMD/internal/fileio/fileio.go)

职责：封装文件读写，提供 Markdown 编辑器所需的基础 IO 能力。

**错误语义（前端可 `errors.Is` 分类）：**

```go
var ErrNotFound = errors.New("file not found")
var ErrIsBinary = errors.New("file contains invalid UTF-8 (binary?)")
```

**关键函数：**

| 函数 | 说明 |
| --- | --- |
| `ReadText(path)` | 读整个文件为 UTF-8；不存在→`ErrNotFound`；含 NUL 或无效 UTF-8→`ErrIsBinary` |
| `WriteText(path, content)` | 原子写：同目录临时文件 + `rename`，防止崩溃半写 |
| `WriteBase64File(path, b64)` | 解码 base64（兼容 data URI 前缀）+ 原子写，用于图片资产 |
| `FileExists(path)` | 简单存在判断 |
| `IsMarkdown(path)` | 扩展名判断（.md/.markdown/.mdown/.mkd/.mkdn） |

**FileMeta 结构：**

```go
type FileMeta struct {
    Path  string `json:"path"`
    Size  int64  `json:"size"`
    IsNew bool   `json:"isNew"`
}
```

**设计目标：**
- 区分「文件不存在」与「权限不足」，便于前端差异化提示。
- 对 UTF-8 做最小校验，避免读入二进制破坏编辑器。
- 写操作统一临时文件 + rename，保证原子性。

### 4.5 internal/updater 自动更新

[internal/updater/updater.go](file:///Volumes/fx/Object/LiteMD/internal/updater/updater.go)

职责：通过 GitHub Releases API 检查新版本，按 semver 语义比较。

**数据源：** `GET https://api.github.com/repos/litemd/litemd/releases/latest`（不鉴权）。

**关键类型：**

```go
type ReleaseInfo struct {
    TagName     string    `json:"tag_name"`
    Name        string    `json:"name"`
    HTMLURL     string    `json:"html_url"`
    PublishedAt time.Time `json:"published_at"`
    Prerelease  bool      `json:"prerelease"`
    AssetURL    string    `json:"asset_url"`   // 最匹配的 .exe 下载 URL
}

type CheckResult struct {
    HasUpdate      bool        `json:"hasUpdate"`
    CurrentVersion string      `json:"currentVersion"`
    Latest         ReleaseInfo `json:"latest"`
    Error          string      `json:"error,omitempty"`
}
```

**关键函数：**

| 函数 | 说明 |
| --- | --- |
| `Check(currentVersion, timeout)` | 完整流程：拉取 + 比较 + 出结果；timeout 默认 5s |
| `FetchLatest(timeout)` | 拉取最新 release，解析 JSON 子集，挑选 Windows asset |
| `IsNewer(latest, current)` | semver 比较（major→minor→patch），预发布按主版本比较 |
| `parseSemver(v)` | 从 `v1.2.3` / `1.2.3` / `1.2.3-rc1` 提取版本号 |
| `pickWindowsAsset(release)` | 从 assets 优先挑 `LiteMD-Setup-*.exe`，退而求其次 `LiteMD.exe` |

**调用流程（前端 → app.go → updater）：**
1. 启动 5s 后前端静默调用 `CheckForUpdate(false)`（走 24h 节流）。
2. 用户点「检查更新」调用 `CheckForUpdate(true)`（绕过节流）。
3. `app.go` 记录 `LastUpdateCheck` 到配置，调用 `updater.Check`。
4. 前端据 `HasUpdate` 弹窗，点「查看详情」调 `OpenReleasePage` 跳浏览器。

---

## 5. 前端模块（TypeScript）

### 5.1 main.ts 主入口与编排

[frontend/src/main.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/main.ts)

职责：应用的顶层编排，串联标签管理、编辑器、预览、分屏、文件操作、快捷键、更新检查。

**核心流程：**

1. 实例化 `TabManager`，回调驱动 `renderTabs` / `refreshActiveEditor` / `renderFrontmatterPanel`。
2. `initEditorAndPreview()` 创建 `MarkdownEditor` + `Preview` + `SplitPane`：
   - 编辑器 `onChange` → `tm.syncLiveContent` + `schedulePreview`（16ms debounce）+ frontmatter 重渲染。
   - 注册图片拖入回调：读 `arrayBuffer` → 分块转 base64 → `copyImageAsset` 写入 → 插入 markdown 引用。
   - 注册 wiki-link 点击：先在已打开 tabs 中按文件名匹配，再查 mock fs，未找到则 alert。
3. 按钮事件分发：new / open / save / save-as / mode-* / check-update。
4. 快捷键：`Ctrl+N/O/S/Shift+S/W/P`。
5. `installBeforeUnloadGuard(tm)` 安装应用级关闭拦截。
6. 启动屏：`requestAnimationFrame` 双层等 CodeMirror 首帧后淡出，并从 `AppInfo` 注入版本号。
7. 启动 5s 后静默 `handleCheckUpdate(false)`。

**预览渲染 debounce 设计：** `schedulePreview` 用 16ms（约一帧）节流，用户连打字时不每次全量重新解析，切 tab / 初始化走 `renderPreviewNow` 立即渲染并清空 pending。

**全局测试钩子：** 将 `split / cm / tm / preview` 实例挂到 `window.__litemd__*`，供 E2E 脚本访问。

### 5.2 editor.ts 编辑器封装

[frontend/src/editor.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/editor.ts)

职责：封装 CodeMirror 6，提供 Markdown 编辑能力。

**`MarkdownEditor` 类：**

| 成员 | 说明 |
| --- | --- |
| `constructor(host, initial, onChange, theme)` | 创建 EditorView，装载全部扩展 |
| `setContent(content)` | 替换文档（切 tab 用），dispatch changes 模式 |
| `getContent()` | O(1) 取当前内容 |
| `setTheme(theme)` | 通过 `Compartment.reconfigure` 热切换主题 |
| `onImageDrop(handler)` | 注册图片拖入/粘贴回调 |
| `focus()` / `destroy()` | 焦点与销毁 |

**扩展装配（关键设计）：**
- `lineNumbers` / `foldGutter` / `history` / `bracketMatching` / `highlightActiveLine` / `highlightSelectionMatches` / `autocompletion`。
- keymap：`defaultKeymap` + `historyKeymap` + `searchKeymap` + `completionKeymap` + `indentWithTab` + `Mod-Space`（启动补全）。
- `markdown({ base: markdownLanguage })`：仅 markdown 语法，**不引入 language-data 全量语言**（节省 ~200KB，Sprint 4 优化）。
- `mdHighlight`：自定义 `HighlightStyle`，用 CSS 变量（`--md-h1` 等）驱动标题/链接/代码/引用等配色。
- `themeCompartment`：`Compartment` 模式支持运行时切 dark/light。
- `EditorView.updateListener`：监听 `docChanged` → 触发 `onChange`。
- `EditorView.domEventHandlers`：拦截 `drop` / `paste`，过滤图片文件后调 `imageDropHandler`。

**主题切换要点：** `setContent` 用 dispatch changes 而非重建 state，避免污染 undo 历史；主题通过 `Compartment.reconfigure` 增量切换。

### 5.3 preview.ts 预览与 XSS 防护

[frontend/src/preview.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/preview.ts)

职责：Markdown → 安全 HTML 渲染，多层 XSS 防护。

**渲染管线 `renderMarkdown(md)`：**

```
obsidian.preprocessAll → marked.parse(同步) → DOMPurify 严格清洗 → link 二次加固
```

1. **预处理**：`preprocessAll`（剥 frontmatter → callout → wiki link）。
2. **marked**：`gfm: true, breaks: false`，同步模式返回 string。
3. **DOMPurify 严格白名单**：
   - `ALLOWED_TAGS`：a/p/div/span/em/strong/code/pre/h1-6/ul/ol/li/blockquote/img/table/kbd 等。
   - `FORBID_TAGS`：style/iframe/object/embed/form/input/button/link/script。
   - `FORBID_ATTR`：onerror/onload/onclick/...style/srcdoc。
   - `ALLOWED_URI_REGEXP`：仅允许 https?/mailto/tel/`/`/`#`。
4. **link 二次加固**：正则强制外部链接加 `target="_blank" rel="noopener noreferrer"`。
5. **兜底 `scrub`**：写入 DOM 后再剥离残留 `<script>` 与 `on*` 事件属性、`javascript:` 协议。

**`Preview` 类：**
- 构造时注册事件委托：捕获 `.wiki-link` 点击，读 `data-wikilink` 调 `clickHandler`。
- `render(md)` / `clear()`。
- `onWikiLinkClick(handler)`：主应用实现跳转逻辑（切 tab / 打开文件 / alert）。

### 5.4 tabs.ts 多标签状态

[frontend/src/tabs.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/tabs.ts)

职责：多标签缓冲区状态管理，dirty 标志与磁盘保存解耦。

**`Tab` 结构：**

```typescript
interface Tab {
    id: string;          // 内部唯一 id（tab-{timestamp}-{n}）
    title: string;       // 文件名或 "Untitled-N.md"
    path: string;        // 磁盘路径，未保存为空串
    baseline: string;    // 最近保存/打开时的内容（dirty 比较基准）
    liveContent: string; // 编辑器实时内容（切换时恢复）
    dirty: boolean;      // liveContent !== baseline
    diskMtime?: number;  // 磁盘 mtime
    frontmatter: Record<string, string> | null;
}
```

**`TabManager` 类：**

| 方法 | 说明 |
| --- | --- |
| `newTab()` | 创建空标签并激活 |
| `openTab(path, content)` | 从文件打开；**路径去重**：已打开则激活 |
| `replaceTabContent(id, payload)` | **就地**替换指定标签的 path/title/baseline/liveContent（id/order/activeId 不变），用于「在空新建页上打开文件」时覆盖而非新增 |
| `activate(id)` | 切换激活标签，触发 `notify` |
| `closeTab(id, force)` | 关闭；dirty 且非 force 返回 `{closed:false, reason:"dirty"}` |
| `syncLiveContent(id, content)` | 同步实时内容，自动重算 dirty |
| `updateContentBaseline(id, content, path, mtime)` | 保存成功后重置基线 |
| `setLiveContent(id, content)` | 强制写入实时内容（不进 dirty 计算） |
| `hasAnyDirty()` | 是否存在脏标签（beforeunload 用） |

**设计要点：**
- `dirty` 与「是否已保存到磁盘」完全解耦：内存改动即视为脏。
- `liveContent` 跟踪编辑器实时内容，`baseline` 是最近干净状态，二者比较得 dirty。
- 切 tab 时 `main.ts` 用 `setContent` 把 active tab 的 `liveContent` 灌回编辑器。
- **空新建页覆盖打开**：`main.ts.openInCurrentIfEmpty` 检测到当前活动标签为「未保存 + 无路径 + 内容为空」时，走 `replaceTabContent` 就地载入文件，避免出现「新 tab + 旧空 tab」两个标签；否则回退 `openTab` 追加新标签。已关联路径或有修改的标签永不覆盖（防数据丢失）。
- **关闭最后一个标签**：`closeTab` 将 `activeId = null`；随后 `main.ts.refreshActiveEditor` 检测到无活动标签时清空编辑器/预览/状态栏并隐藏 frontmatter 面板，再 `queueMicrotask` 自动新建一个空标签，保证界面始终可用（不会残留已关闭标签的内容）。

### 5.5 obsidian.ts 语法兼容层

[frontend/src/obsidian.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/obsidian.ts)

职责：Obsidian 三大语法兼容 + 图片资产辅助。

**Wiki Links `[[Wiki Name]]` / `[[Wiki|alias]]`：**
- `findWikiLinks(md)`：正则找出所有引用。
- `preprocessWikiLinks(md)`：替换为 `<a class="wiki-link" data-wikilink="..." href="#/wiki/...">text</a>`，用 `data-*` 而非真实 href，便于点击事件处理；对 target/alias 做字符过滤防注入。

**Callouts `> [!type]`：**
- 支持 12 种类型：note/tip/info/warning/danger/example/question/success/failure/bug/quote/abstract。
- `CALLOUT_RE` 匹配 `>+ [!type]` 开头 + 后续 `> ...` body 行（body 可选，修复了单行 callout 不识别的 bug）。
- `preprocessCallouts(md)`：转为 `<blockquote class="callout callout-{type}">` + title + body。

**Frontmatter `--- ... ---`：**
- `parseFrontmatter(md)`：极简 YAML 解析（`key: value` + 引号剥离），返回 `{ frontmatter, body }`。不支持嵌套对象。

**图片资产：**
- `persistImageAsset(file, copyFn, bufferToBase64)`：把拖入 File 转为 base64，调 `copyFn` 写入，产出 markdown 引用。

**一站式预处理 `preprocessAll(md)`：**
```
parseFrontmatter（剥 frontmatter） → preprocessCallouts → preprocessWikiLinks
```
顺序关键：Callout 必须先于 wiki，避免在 callout 体内误识别 `[[]]`。

### 5.6 file-ops.ts 文件操作抽象

[frontend/src/file-ops.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/file-ops.ts)

职责：抽象「打开/保存/配置/资产」调用，统一 mock 与真实绑定的 fallback。

**双模式机制：**

```typescript
function bind(name: string) {
    const mock = window.go?.main?.App?.[name];
    if (typeof mock === "function") return mock;          // 浏览器/E2E: mocks.ts 注入
    if (typeof wailsBindings[name] === "function") return wailsBindings[name]; // 桌面: 真实 binding
    throw new Error(`binding ${name} not available`);
}
```

**导出函数：** `openFile` / `pickOpenPath` / `saveFile` / `saveFileAs` / `getConfig` / `pushRecent` / `copyImageAsset`，签名与后端一致。

**测试钩子：** 挂 `window.__litemd__bindings` 供 E2E 直接调用 binding。

### 5.7 splitpane.ts 分屏容器

[frontend/src/splitpane.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/splitpane.ts)

职责：可拖拽分屏，三模式（both/left/right）。

**`SplitPane` 类：**
- 构造时校验 host 含 `.pane-left/.pane-right/.pane-handle` 子元素。
- `setMode(mode)`：写 `data-mode`，CSS 用 grid-template-columns 控制显隐。
- 拖拽：`pointerdown` → `setPointerCapture` → `pointermove` 计算 ratio（clamp 0.15~0.85）→ `pointerup` 释放 + 回调。
- 双击 handle 重置为 0.5。
- 比例通过 CSS 变量 `--split-ratio` 驱动布局。

**把手指示点（`.pane-handle::before`）：** 中央 1×28px 的细竖线**默认隐藏**（`opacity:0`），仅在悬停/拖拽/键盘聚焦时淡出显示（`opacity:0.6`），配合强调色高亮，避免「常驻短竖线」破坏浅色主题的视觉一致性（改为按需显示，交互与 macOS 分栏一致）。

### 5.8 unsaved-guard.ts 未保存拦截

[frontend/src/unsaved-guard.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/unsaved-guard.ts)

职责：两层未保存保护。

- `askUnsaved(fileName)`：弹出 `<dialog>`（HTML 原生，支持 ESC），返回 `"save"|"discard"|"cancel"`。基于 `dialog.returnValue`（form `method="dialog"` 自动设置），保证 E2E 与生产行为一致。
- `installBeforeUnloadGuard(tabManager)`：`beforeunload` 检测 `hasAnyDirty()`，WebView2 弹原生确认。

### 5.9 mocks.ts / dev-bootstrap.ts 浏览器 Mock

[frontend/src/mocks.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/mocks.ts) ｜ [frontend/src/dev-bootstrap.ts](file:///Volumes/fx/Object/LiteMD/frontend/src/dev-bootstrap.ts)

职责：浏览器/E2E 环境下模拟 Wails Go 绑定。

- `InMemoryMockFs`：内存文件系统（`files: Map` + `savedFiles` 数组），E2E 可注入预置文件、读取保存记录。
- 把与后端同名方法挂到 `window.go.main.App`，`file-ops.ts` 的 `bind()` 优先命中。
- `OpenDialog`/`SaveDialog` 用 `window.prompt` 模拟。
- 派发 `litemd:mockfs:ready` 事件通知测试就绪。
- `dev-bootstrap.ts`：浏览器入口，先 import `mocks` 再 import `main`，确保 `window.go` 先于 `file-ops` 注入。

---

## 6. 前后端绑定桥接

Wails 在构建时扫描 `App` 的公开方法，自动生成 TypeScript 声明与 JS 调用桩：

```
app.go (Go 方法)
   ↓ wails generate
frontend/wailsjs/go/main/App.d.ts   # 类型声明
frontend/wailsjs/go/main/App.js     # 调用桩（调 window['go']['main']['App']['Method']）
frontend/wailsjs/go/models.ts       # 后端 struct 的 TS 镜像（Config/FilePayload/AppInfo/CheckResult/ReleaseInfo）
   ↓ 前端封装
frontend/src/file-ops.ts            # 统一导出 + mock fallback
   ↓ 调用
frontend/src/main.ts                # 业务编排
```

**绑定方法签名对照（App.d.ts）：**

| 前端调用 | 返回 | 后端方法 |
| --- | --- | --- |
| `OpenFile(path)` | `Promise<main.FilePayload>` | `App.OpenFile` |
| `OpenDialog()` | `Promise<string>` | `App.OpenDialog` |
| `SaveDialog(name)` | `Promise<string>` | `App.SaveDialog` |
| `SaveFile(path, content)` | `Promise<void>` | `App.SaveFile` |
| `SaveFileAs(name, content)` | `Promise<string>` | `App.SaveFileAs` |
| `GetConfig()` | `Promise<config.Config>` | `App.GetConfig` |
| `SetConfig(cfg)` | `Promise<void>` | `App.SetConfig` |
| `PushRecent(path)` | `Promise<config.Config>` | `App.PushRecent` |
| `CheckForUpdate(force)` | `Promise<updater.CheckResult>` | `App.CheckForUpdate` |
| `OpenReleasePage(url)` | `Promise<void>` | `App.OpenReleasePage` |
| `AppInfo()` | `Promise<main.AppInfo>` | `App.AppInfo` |
| `CopyImageAsset(path, b64)` | `Promise<string>` | `App.CopyImageAsset` |

> `models.ts` 中 `Config`/`FilePayload` 等类的 `createFrom`/`convertValues` 由 Wails 自动生成，用于反序列化后端返回的 JSON。

---

## 7. 依赖关系

### 7.1 Go 依赖（go.mod）

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `github.com/wailsapp/wails/v2` | v2.14.0 | 应用框架（核心，唯一直接依赖） |
| `github.com/wailsapp/go-webview2` | v1.0.22 | Windows WebView2 绑定（indirect） |
| `github.com/gorilla/websocket` | v1.5.3 | Wails dev 通信（indirect） |
| `github.com/labstack/echo/v4` | v4.13.3 | Wails 内部 HTTP 服务（indirect） |
| `github.com/samber/lo` | v1.49.1 | 工具库（indirect） |
| `github.com/google/uuid` | v1.6.0 | UUID（indirect） |
| `golang.org/x/{crypto,net,sys,text}` | — | 系统库（indirect） |

> Go 1.25.0。除 Wails 外均为 indirect，业务代码零额外直接依赖，保持极简。

### 7.2 前端依赖（frontend/package.json）

**运行时依赖（dependencies）：**

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `codemirror` | ^6.0.2 | 编辑器内核 |
| `@codemirror/state` | ^6.7.1 | 编辑器状态（含 Compartment） |
| `@codemirror/view` | ^6.43.8 | 编辑器视图 |
| `@codemirror/commands` | ^6.10.4 | 快捷键/历史 |
| `@codemirror/search` | ^6.7.1 | 搜索 |
| `@codemirror/autocomplete` | ^6.20.3 | 自动补全 |
| `@codemirror/language` | ^6.12.4 | 语言支持（高亮/fold/bracket） |
| `@codemirror/lang-markdown` | ^6.5.2 | Markdown 语法 |
| `@codemirror/theme-one-dark` | ^6.1.3 | 暗色主题 |
| `@lezer/markdown` | ^1.7.2 | markdown 解析器（CM6 依赖） |
| `marked` | ^18.0.9 | Markdown → HTML |
| `dompurify` | ^3.4.13 | XSS 清洗 |

**开发依赖（devDependencies）：** `typescript` ^5.9.3、`vite` ^3.0.7、`tsx` ^4.23.12（跑 TS 测试）、`jsdom` ^29.1.1（DOM 测试环境）+ 对应 `@types/*`。

> 显式不引入 `@codemirror/language-data`（Sprint 4 移除，节省 ~200KB）。

### 7.3 模块间依赖图

```
main.ts
 ├─► tabs.ts (TabManager)
 ├─► editor.ts (MarkdownEditor) ── CodeMirror 6
 ├─► preview.ts (Preview) ── marked + dompurify + obsidian.ts
 ├─► splitpane.ts (SplitPane)
 ├─► unsaved-guard.ts ── tabs.ts
 ├─► obsidian.ts (parseFrontmatter / preprocessAll)
 └─► file-ops.ts ── wailsjs/go/main/App + mocks.ts(fallback)

app.go (Go)
 ├─► internal/config (Store)
 ├─► internal/fileio (ReadText/WriteText/WriteBase64File)
 └─► internal/updater (Check/FetchLatest)
```

---

## 8. 构建与打包流程

### 8.1 前端构建（Vite 双入口）

[vite.config.js](file:///Volumes/fx/Object/LiteMD/frontend/vite.config.js)

- 双入口：`index.html`（生产）+ `dev.html`（浏览器/E2E）。
- `npm run build` = `tsc && vite build`，产物输出到 `frontend/dist/`。
- dev server：`127.0.0.1:5173`，`strictPort: true`。

### 8.2 Wails 构建

[wails.json](file:///Volumes/fx/Object/LiteMD/wails.json)

- `frontend:install` = `npm install`，`frontend:build` = `npm run build`。
- `outputfilename: "workspace"`。
- `wails build` 会先跑前端构建，再编译 Go，把 `dist/` 嵌入二进制。

### 8.3 Windows 打包

[build_windows/installer/project.nsi](file:///Volumes/fx/Object/LiteMD/build_windows/installer/project.nsi)

1. `wails build -platform windows/amd64` 产出 `LiteMD.exe`。
2. UPX 压缩：`upx --best --lzma build/bin/LiteMD.exe`（~30% 压缩比，10MB→3MB）。
3. NSIS 3.09 脚本打包：
   - 中文 UI 安装向导。
   - 桌面 + 开始菜单快捷方式。
   - `.md` 文件关联（写注册表 `HKCU\Classes\.md`）。
   - 卸载信息（`HKLM\Uninstall`）。
4. 产出 `LiteMD-Setup-v0.2.0.exe`（~3.0 MB）。

**已知踩坑（来自 DEVELOPMENT_PLAN）：**
- NSIS 3.09 在 Linux 上 PNG icon + Unicode + MUI 触发 double free → 改用 ICO。
- `${GetSize}` 宏在 Linux 编译触发 double free → 去掉该指令。

### 8.4 macOS 打包

[build_darwin/Info.plist](file:///Volumes/fx/Object/LiteMD/build_darwin/Info.plist) 与 `Info.dev.plist` 提供 macOS 应用配置（含 `LiteMD.app/Contents/` 结构），`build/bin/LiteMD.app` 为产物。

---

## 9. 测试体系

测试金字塔共 176 用例，99% 通过。

| 层级 | 工具 | 用例数 | 覆盖范围 |
| --- | --- | --- | --- |
| Go 单元测试 | `go test ./...` | 38 | binding、config、fileio、updater |
| 前端单元测试 | `tsx` + `jsdom` | 44 | preview 渲染、XSS、obsidian 解析 |
| E2E | `agent-browser`（bash 脚本） | 66（sprint1-5） | 启动→打开→编辑→保存→关闭全链路 |

**Go 测试特点：**
- `app_test.go` 用 `t.TempDir()` + `t.Setenv("HOME", ...)` 隔离，验证 `errors.Is` 错误分类与 nil ctx 安全。
- `internal/*/test.go` 覆盖原子写、base64 解码、semver 比较、配置降级。

**前端测试特点：**
- `preview.test.ts`（14 项）：marked + DOMPurify 各类 XSS 向量。
- `obsidian.test.ts`（30 项）：双链/Callout/Frontmatter 边界。
- `preview.test-bootstrap.ts` 用 `tsx` 在 jsdom 中跑。

**E2E 特点（[e2e/sprint1.sh](file:///Volumes/fx/Object/LiteMD/e2e/sprint1.sh) 等）：**
- 基于 `agent-browser` CLI，通过 `eval` 注入 JS、读 `window.__litemd__*` 钩子断言。
- 按 phase 独立 `fresh_open` 重载页面，规避 chrome 长 session CDP 卡顿。
- `cm_inject` 通过 CodeMirror dispatch 注入文本，`cm_get` 读 `view.state.doc`。
- 每个 Sprint 产出 `.sh` 脚本 + 截图基准 `.png`。

**运行命令：**

```bash
# Go 单测
go test ./...

# 前端单测
cd frontend && npm run test:unit

# E2E（需先起 dev server）
cd frontend && npm run dev   # 另一终端
cd e2e && ./sprint1.sh
```

---

## 10. 项目运行方式

### 10.1 环境准备

```bash
# Go 1.25+
go version

# Node + npm
node -v && npm -v

# 安装 Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails doctor   # 检查环境
```

### 10.2 浏览器开发模式（无需 Wails/WebView）

适合纯前端开发与 E2E 测试，走 mock 绑定。

```bash
cd frontend
npm install
npm run dev          # 启动 vite，访问 http://127.0.0.1:5173/dev.html
```

`dev.html` 自动加载 `dev-bootstrap.ts` → `mocks.ts` 注入 `window.go` → `main.ts`。

### 10.3 Wails 桌面开发模式（热重载）

```bash
wails dev            # 自动起 vite dev server + Wails 窗口，前端改动热重载
```

### 10.4 生产构建

```bash
# 1. 前端构建 + Go 编译（嵌入资源）
wails build -platform windows/amd64

# 2. UPX 压缩
upx --best --lzma build/bin/LiteMD.exe

# 3. NSIS 打包（生成 Setup.exe）
cd build_windows/installer && makensis project.nsi
```

### 10.5 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+N` | 新建标签 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存为 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+P` | 切换分屏/预览模式 |
| `Ctrl+F` / `Ctrl+H` | 查找 / 查找替换（CodeMirror） |

---

## 11. 关键设计原则与约定

1. **绑定统一返回 `(T, error)`**：前端 `try/catch` 处理；错误用 `errors.Is` 分类（`ErrNotFound` / `ErrIsBinary`）。
2. **原子写**：所有文件写入（配置、文档、图片）走「同目录临时文件 + `os.Rename`」，防崩溃半写。
3. **配置降级**：配置文件损坏时回退默认值，永不阻塞用户使用。
4. **dirty 与磁盘解耦**：`liveContent !== baseline` 即脏，与是否落盘无关；切 tab 不丢内容。
5. **双模式前端**：同一份 `src/`，`window.go` 存在则用真实绑定，否则用 mock；`file-ops.ts` 的 `bind()` 统一 fallback。
6. **XSS 多层防护**：DOMPurify 严格白名单 → link 强制 rel/target → DOM 兜底 scrub 剥离 `on*`/`script`/`javascript:`。
7. **预览 debounce**：16ms（约一帧）节流，连打字不全量重解析；切 tab/初始化走立即渲染。
8. **性能优先**：不引入 language-data 全量语言（省 ~200KB）；`OpenFile` 用 `stat.ModTime` 避免 `time.Now`；UPX 压缩二进制。
9. **更新节流**：`CheckForUpdate` 24h 内不重复发网络请求（除非 `force=true`），记录 `LastUpdateCheck` 到配置。
10. **测试钩子**：`window.__litemd__{split,cm,tm,preview,bindings,mockfs}` 供 E2E 注入与断言。

---

## 12. 数据目录与配置

| 项 | 路径 / 位置 |
| --- | --- |
| 配置文件 | `~/.litemd/config.json`（Windows: `%USERPROFILE%\.litemd\config.json`） |
| 图片资产 | `./assets/`（相对于每个 .md 文件所在目录） |
| 配置目录 | 不存在时自动 `MkdirAll`（权限 0o755） |
| 最近文件 | 存于配置 `recentFiles`，最多 10 条，去重 |
| 版本号 | `AppVersion` 常量（`app.go`），NSIS 脚本同步替换 |

**配置示例（Default）：**

```json
{
  "theme": "auto",
  "fontFamily": "system-ui",
  "fontSize": 14,
  "recentFiles": [],
  "windowWidth": 1024,
  "windowHeight": 768,
  "keyMap": "default",
  "customCssPath": "",
  "lastUpdateCheck": "0001-01-01T00:00:00Z"
}
```

---

## 13. 主题配色方案

LiteMD 采用 CSS 变量驱动双主题，所有组件只引用变量而不写死色值，保证两套主题下视觉结构与对比度一致（正文按 WCAG AA ≥4.5:1 校准）。通过 `<html data-theme="dark|light">` 切换，持久化到 `localStorage("litemd:theme")`，默认暗色。

### 13.1 暗色主题（默认）— GitHub Dark 风格

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--bg-0 / --bg-1 / --bg-2 / --bg-3` | `#0D1117 / #161B22 / #21262D / #30363D` | 背景梯度 |
| `--fg-0 / --fg-1 / --fg-2` | `#F0F6FC / #C9D1D9 / #8B949E` | 文字层级 |
| `--accent` | `#58A6FF`（蓝） | 强调色 / 交互高亮 |
| `--brand-a / --brand-b` | `#58A6FF / #A5D6FF` | 品牌渐变 |
| `--danger / --warn / --ok` | `#F85149 / #D29922 / #3FB950` | 状态色 |

### 13.2 亮色主题 — 浅护眼配色（豆沙绿/米杏）

> v0.2.x 迭代优化：由原 GitHub Light（纯白 + 蓝 accent）改为低饱和暖色系，长时间阅读不刺眼。

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--bg-0` | `#FBF8F1`（米杏） | 主背景（护眼纸张色） |
| `--bg-1` | `#F2EEE0` | 顶栏/标签栏/状态栏 |
| `--bg-2 / --bg-3` | `#E8E2D0 / #D8D2BE` | 悬停 / 弹层 |
| `--border / --border-strong` | `#D9D2BD / #B9B29C` | 低对比米褐边框 |
| `--fg-0 / --fg-1 / --fg-2` | `#2A2722 / #3D3A33 / #6B6759` | 深褐黑文字（非纯黑，与暖底协调） |
| `--accent` | `#5B7A5B`（豆沙绿） | 强调色（低饱和，护眼） |
| `--accent-fg` | `#FBF8F1` | 强调色上文字（对比度 4.9:1） |
| `--brand-a / --brand-b` | `#5B7A5B / #8AA38A` | 品牌渐变 |
| `--danger / --warn / --ok` | `#B54848 / #A87B2A / #4F8050` | 降饱和状态色 |

**Markdown 元素配色**（`--md-*`）在亮色下同步重校：标题深豆沙/暖褐、链接豆沙绿、行内代码棕橙、引用米褐、列表低饱和紫，均与主界面暖色系协调。
**顶栏**：双变量渐变 `var(--bg-1)→var(--bg-0)`（不引用硬编码暗色），顶栏按钮背景对亮色用 `transparent`；**分屏把手**的中央竖线默认隐藏、仅悬停/拖动时按需淡出（见 §5.7）。

---

## 附录：Sprint 演进时间线

| Sprint | 主题 | 关键交付 |
| --- | --- | --- |
| 1 | 基础框架 + 文件 IO | Wails 骨架、多标签、关闭未保存拦截、配置持久化、原子写 |
| 2 | 编辑器内核 + 预览 | CodeMirror 6 集成、marked + DOMPurify、可拖拽分屏 |
| 3 | Obsidian 语法兼容 | 双链 `[[Wiki]]`、Callouts 12 类、Frontmatter 面板、图片拖入资产 |
| 4 | 性能优化 + 打包 | 移除 language-data、Preview debounce、NSIS + UPX（3.0MB） |
| 5 | 启动屏 + 自动更新 | Splash 渐变 Logo、GitHub Releases 检查、24h 节流、主题细化 |

项目于 2026-08-11 ~ 2026-08-12 跨 5 个 Sprint 完成全部手册要求 + 3 项扩展，状态：**生产就绪（Production-Ready）**。详见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)。

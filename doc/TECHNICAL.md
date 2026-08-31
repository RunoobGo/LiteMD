# LiteMD 技术文档

> 最后更新：2026-08-31（对齐当前代码快照 v0.2.0）
> 历史文档已归档至 `doc/archive/`，如需追溯开发过程请查阅。

---

## 1. 架构总览

LiteMD 是一个桌面 Markdown 编辑器，技术栈：

- **桌面壳**：Wails v2（Go + WebView2，Windows / macOS / Linux）
- **后端**：Go（文件 IO、配置持久化、文件关联冷启动、单实例锁、图片资产复制）
- **前端**：原生 TypeScript（无框架），CodeMirror 6 编辑器，marked + DOMPurify 渲染管线
- **构建**：`build-win11-x64.sh` 一键交叉编译 Windows 产物（NSIS 安装包 + 便携版）

```
┌─────────────────────────────────────────────┐
│          Wails 无边框窗口（自绘标题栏）        │
│  ┌──────────────┬──────────────────────────┐ │
│  │  顶栏/标签栏   │  编辑器 (CodeMirror 6)    │ │
│  ├──────────────┼──────────────────────────┤ │
│  │  前端模块      │  预览 (marked+DOMPurify)  │ │
│  │  main/tabs/…  │   + KaTeX 公式            │ │
│  └──────────────┴──────────────────────────┘ │
│  ▲          Wails bindings (Go API)          │
└─┼───────────────────────────────────────────┘
  │
  ├── app.go（OpenFile/SaveFile/Config/图片复制）
  ├── startupfile.go（命令行/文件关联启动文件队列）
  ├── internal/config（~/.litemd/config.json）
  └── internal/fileio（原子写 + 安全守卫）
```

### 1.1 数据流：打开一个文件

```
双击 .md / 命令行参数
  → extractStartupFiles(argv) 入队（startupfile.go）
  → 前端启动后 while ConsumeStartupFile() 逐个消费（main.ts）
  → OpenFile(path) → fileio.ReadText（IsRegular + 50MB + UTF-8 校验）
  → FilePayload{path, content, modified} → tm.openTab()
```

单实例锁：第二次启动的文件关联会转发给已运行实例（`OnSecondInstanceLaunch` → 前端收到 `litemd:openExternalFile` 事件）。

### 1.2 数据流：保存

```
Ctrl+S → handleSave() → saveFile(path, content) → app.SaveFile
  → fileio.WriteText（临时文件 → Sync → Rename 原子写）
  → updateContentBaseline（推进 baseline，不覆盖 liveContent）
```

### 1.3 无边框标题栏（Frameless）

`main.go` 设 `Frameless: true`，系统标题栏被移除，顶栏（`.topbar`）兼任标题栏：
右侧集成最小化 / 最大化还原 / 关闭按钮（`.window-controls`），配色随暗/亮主题变量自适应。

**拖动机制**（Wails v2.14 `internal/frontend/runtime/desktop/main.js` 的 `dragTest`）：

```
mousedown → getComputedStyle(e.target).getPropertyValue("--wails-draggable") === "drag"
          且 e.buttons===1 且 e.detail===1（双击第二次跳过，留给 dblclick）
  → 置 shouldDrag
mousemove（按键仍按住）→ WailsInvoke("drag")
  → Go: ReleaseCapture + PostMessage(WM_NCLBUTTONDOWN, HTCAPTION) → 系统模态拖动
```

两条铁律（对应此前两个失效问题的根因）：

1. **必须用 CSS 变量 `--wails-draggable: drag`**。`-webkit-app-region` 是
   Electron 专有属性，WebView2/Wails 完全不识别——此前拖不动即源于此。
2. **可交互元素必须显式 `--wails-draggable: no-drag`**。CSS 变量可继承，
   若按钮从顶栏继承了 `drag`，点击时手抖 1px 就会触发 mousemove → 进入
   系统模态拖动循环，`click` 被吞（表现即"按钮失效"）。故 `.actions` 与
   `.window-controls` 均显式覆盖为 `no-drag`。

**窗口操作 API**（`frontend/src/titlebar.ts`，经依赖注入便于单测）：

| 操作 | API | 说明 |
|---|---|---|
| 最小化 | `WindowMinimise()` | |
| 最大化/还原 | `WindowToggleMaximise()` | 双击标题栏空白同样触发（Wails 不内建，`titlebar.ts` 补齐） |
| 关闭 | `Quit()` | **Wails v2 无 `WindowClose`**，`Quit` 与系统关闭行为一致（均不触发 beforeunload） |
| 状态同步 | `WindowIsMaximised()` | Wails v2.14 Windows 不广播 `wails:maximise` 事件，改在 `resize` 上防抖 150ms 查询，切换 `.is-maximised` 图标 |

浏览器 mock 端（dev.html）无 `window.runtime`，`initTitlebar(null)` 自动隐藏控制按钮组。

---

## 2. 目录结构

```
LiteMD/
├── main.go                 # 入口：窗口配置、单实例锁、文件关联冷启动
├── app.go                  # Wails binding：文件/配置/图片 API
├── startupfile.go          # 启动文件队列（并发安全）
├── app_test.go / app_integration_test.go / startupfile_test.go
├── internal/
│   ├── config/             # ~/.litemd/config.json 持久化（主题/字号/最近文件）
│   └── fileio/             # 文件读写（原子写 + safeWritePath 守卫）
├── frontend/
│   ├── src/
│   │   ├── main.ts         # 应用主入口：事件绑定/快捷键/窗口流程
│   │   ├── titlebar.ts     # 无边框标题栏：窗口控制按钮/双击最大化/状态同步
│   │   ├── tabs.ts         # TabManager：标签生命周期 + dirty 状态
│   │   ├── editor.ts       # CodeMirror 6 封装
│   │   ├── preview.ts      # 渲染管线主流程（marked+DOMPurify+链接加固）
│   │   ├── latex.ts        # LaTeX 公式提取/渲染/还原（KaTeX）
│   │   ├── obsidian.ts     # Obsidian 语法：双链/callout/frontmatter
│   │   ├── file-ops.ts     # 与后端 binding 的桥接层
│   │   ├── splitpane.ts    # 分屏拖拽
│   │   ├── unsaved-guard.ts# 未保存拦截对话框
│   │   ├── mocks.ts        # 浏览器开发模式 mock
│   │   └── *.test.ts       # 测试（自制断言框架）
│   ├── index.html          # 生产入口
│   ├── dev.html            # 浏览器开发入口（含 mock）
│   └── vite.config.js      # 构建配置（含 KaTeX 字体裁剪插件）
├── build_windows/          # NSIS 安装脚本
├── e2e/                    # E2E 脚本（sprint1-5）
├── doc/                    # 技术文档（本文件 + CHANGELOG + archive/）
└── build-win11-x64.sh      # 一键构建脚本
```

---

## 3. 渲染管线（重要：顺序约束）

```
Markdown 源文本
  → ① extractLatex(md)          ← LaTeX 公式抽成占位符（随机盐）
  → ② preprocessAll(text)       ← Obsidian 双链 / callout / frontmatter
  → ③ marked.parse(html)        ← Markdown → HTML
  → ④ DOMPurify.sanitize        ← 严格白名单清洗
  → ⑤ hardenLinks(html)         ← 外链加 target=_blank + rel=noopener
  → ⑥ restoreLatex(html)        ← 占位符还原为 KaTeX HTML（仅文本节点）
```

**顺序为什么必须这样（两个硬约束）：**

1. **公式提取必须在 marked 之前**（① 先于 ③）：否则 `a_i * b_j` 里的 `*` 会被 marked 解析为斜体标记，公式被破坏。
2. **公式还原必须在 DOMPurify 之后**（⑥ 后于 ④）：KaTeX 输出依赖内联 `style` 属性与 MathML 标签，若在清洗前注入会被 DOMPurify 剥离。

**公式占位符的安全设计（2026-08-31 加固）：**

- 每次 `extractLatex` 生成**随机盐**（`Math.random + Date.now`），占位符形如 `LTMDPHLX<salt><n>ZX`，不可预测
- 提取阶段先把用户文本中所有「占位符形态」（`LTMDPHLX[A-Za-z0-9]*\d+ZX`）剥成空串
- `restoreLatex` 只在 `>...<` 之间的文本节点替换，**绝不触碰属性上下文**
- 双保险的意义：即使攻击者在文档里伪造占位符形态（旧版可借此把 KaTeX HTML 注入 `data-wikilink`、`title` 等属性，突破 DOMPurify 属性白名单），本实现也不构成注入面

**代码块豁免：**

- ``` 围栏块、`行内代码`、`\$` 转义先被标记为豁免区间（`findExemptRanges`）
- 豁免区间**只标记位置、不替换内容** —— marked 必须还能看到反引号，否则代码块会降级成普通段落
- 未闭合围栏视作「开栏到文末为代码区」（与 marked 行为一致）
- 豁免区间查找为线性实现（按行状态机 + 二分），避免旧版 O(n²) ReDoS

### 3.1 DOMPurify 配置

```ts
ALLOWED_TAGS: a/p/div/span/em/strong/b/i/u/s/code/pre/blockquote/ul/ol/li/h1-h6/table/thead/tbody/tr/th/td/img/figure/figcaption/hr/br/details/summary/mark/kbd
FORBID_ATTR: onerror/onload/onclick/onmouseover/onmouseout/onfocus/onblur/style/srcdoc
ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/|#)/i
```

注意：`style` 属性对 KaTeX 输出是**有意放行**的（公式还原发生在 DOMPurify 之后），这一层依赖 KaTeX `trust:false` 保证输出安全。

### 3.2 LaTeX 公式语法

- 行内：`$...$`（紧邻定界符不得为空白，避免货币误判）
- 块级：`$$...$$`
- 代码块/行内代码/`\$` 内不渲染

KaTeX 配置：`trust:false`（禁 `\href`/`\url`/`\htmlClass`/`\htmlStyle`/`\htmlData`/`\includegraphics`）、`maxSize:50`、`maxExpand:1000`、`throwOnError:false`。

> ⚠️ KaTeX 版本约束：**不得低于 0.16.21**（CVE-2025-23207 修复版本，漏洞点正是本方案依赖的属性校验路径）。

---

## 4. 安全模型

| 层 | 职责 | 位置 |
|---|---|---|
| 1 | 公式占位符防伪（随机盐 + 剥除） | `latex.ts` |
| 2 | Obsidian 预处理转义（双链属性过滤） | `obsidian.ts` |
| 3 | marked 解析 | `marked` |
| 4 | DOMPurify 严格白名单 | `preview.ts` |
| 5 | 外链加固（target/rel） | `preview.ts` |
| 6 | 公式还原（仅文本节点） | `latex.ts` |
| 7 | DOM 兜底 scrub（移除 on* / javascript:） | `preview.ts` |
| 8 | 写路径守卫（绝对路径/Clean/Windows 保留设备名） | `fileio/safepath.go` |

**原则**：DOMPurify 是唯一且充分的 HTML 清洗层；KaTeX 输出注入是设计上的例外，依赖 `trust:false` + 占位符防伪双重保护。

---

## 5. 后端模块

### 5.1 fileio（文件读写）

- `ReadText`：IsRegular 校验（拒绝 FIFO/设备/伪文件）→ 50MB 上限 → LimitReader 兜底 → BOM 剥除 → UTF-8 校验
- `WriteText` / `WriteBase64File`：临时文件 → `Sync()` → `Rename` 原子写
- `safeWritePath`：绝对路径 + Clean + Windows 保留设备名（CON/NUL/AUX/COM1-9/LPT1-9）拒绝

### 5.2 config（配置持久化）

- 路径：`~/.litemd/config.json`
- 字段：`theme` / `fontFamily` / `fontSize` / `recentFiles`（**最小集**，无窗口尺寸/KeyMap 等预留字段）
- 原子写 + Sync；损坏时降级默认值
- 线程安全：`Store.mu` 保护读写

> 注意：前端当前**不消费** `GetConfig`/`SetConfig`（主题存于 localStorage）。`recentFiles` 由 `PushRecent` 写入。

### 5.3 启动文件与单实例

- 冷启动：argv 中非程序路径入队 → 前端 `ConsumeStartupFile()` 逐个消费
- 单实例：`SingleInstanceLock` 三平台生效，二次启动转发参数 → `litemd:openExternalFile` 事件
- macOS 注意：`mac.Options.OnFileOpen` 未配置（2026-08-31 待办 P1-F），Finder 双击打开链路失效

---

## 6. 构建与打包

### 6.1 一键构建（Windows 11 x64）

```bash
export GOTOOLCHAIN=auto
cd frontend && npm ci && cd ..
OUT=/path/to/dist ./build-win11-x64.sh
```

产物：

| 产物 | 说明 |
|---|---|
| `LiteMD-0.2.0-Setup-x64.exe` | NSIS 安装版（LZMA 固实压缩） |
| `LiteMD-0.2.0-Portable-x64.zip` | 便携版（解压即用） |
| `LiteMD-0.2.0-Portable-x64-upx.zip` | UPX 压缩便携版（可选产物） |

### 6.2 体积优化策略（已落地）

| 优化 | 效果 |
|---|---|
| `-webview2 browser` + 自定义 NSIS 宏（检测注册表，不内嵌引导器） | 安装包 -43%（6.01MB → 3.43MB） |
| LZMA 固实压缩（`/SOLID lzma` + `DictSize 32`） | 进一步压缩 |
| `-ldflags "-s -w"` + `-trimpath` | 剥离符号 + 可复现构建（跨构建 exe SHA256 一致） |
| Vite 插件剥离 woff/ttf 字体引用（KaTeX） | dist 2.2MB → 1.3MB |
| 不用 UPX 压缩安装包（杀软误报风险 > 3% 收益） | 仅便携版可选 |

### 6.3 WebView2 策略

安装包**不内嵌** WebView2 运行时。安装时检测注册表（HKLM/HKCU），缺失则提示下载地址但**不阻断安装**。Win11 通常已自带。

---

## 7. 测试

### 7.1 运行方式

```bash
# Go（含 race 检测）
go test ./... -race -count=1

# 前端全部（preview + obsidian + latex + titlebar）
cd frontend && LITEMD_TEST=all npx tsx src/preview.test-bootstrap.ts

# 前端单套
cd frontend && LITEMD_TEST=latex npx tsx src/preview.test-bootstrap.ts
cd frontend && LITEMD_TEST=titlebar npx tsx src/preview.test-bootstrap.ts
```

### 7.2 当前统计（2026-08-31）

| 套件 | 断言数 |
|---|---|
| Go（app + config + fileio） | 约 45 Test 函数 |
| preview.test.ts | 22 |
| obsidian.test.ts | 45（含 ReDoS 防护 9 项） |
| latex.test.ts | 55（含占位符防伪 5 项 + ReDoS 守卫 2 项） |
| titlebar.test.ts | 11（按钮/手势/状态同步/降级） |
| E2E（sprint1-5） | 部分失效，见 §8 待办 |

### 7.3 安全专项测试

- 占位符伪造：wiki-link / img title 属性内占位符形态被剥除
- 占位符盐每次不同
- 还原不触碰属性上下文
- `WIKI_RE` / `FENCE_RE` ReDoS 回归守卫（大输入 < 500ms 断言）
- KaTeX `trust:false` 注入（\href/\htmlClass/\<script\>）
- 宏展开炸弹（maxExpand 限制）

---

## 8. 已知限制与待办

### 8.1 已知限制

- macOS「双击打开 .md」链路失效（未配置 `mac.Options.OnFileOpen`）
- `.mkdn` 扩展名未注册文件关联（仅 md/markdown/mdown/mkd）
- 前端不消费 `GetConfig`/`SetConfig`（主题在 localStorage，字号不持久化）
- 无外部文件变更检测（用户决策取消目录监控）

### 8.2 待办（P0 已修，P1+ 待做）

| 优先级 | 项 | 位置 |
|---|---|---|
| P1 | Wails `OnBeforeClose` 异步协商（关窗提示未保存） | `main.go` + `unsaved-guard.ts` |
| P1 | 保存重构：保存期间新输入保持 dirty（`markSaved` 不覆盖 liveContent） | `main.ts` + `tabs.ts` |
| P1 | `mac.Options.OnFileOpen` + 更正过时注释 | `main.go` |
| P1 | `PushRecent` 读-改-写事务化 | `app.go` + `config.go` |
| P1 | DOMPurify 升 3.4.14 + CI 接 `npm audit` | `package.json` |
| P1 | 修 E2E 失效断言（sprint1/2/4/5） | `e2e/` |
| P2 | 图片插入的 markdown 转义（alt/URL） | `obsidian.ts` |
| P2 | `\raisebox` 等逃逸 maxSize 的命令加闸门 | `latex.ts` |
| P3 | 测试框架迁移 vitest；`npm run test:unit` 默认跑全量 | `package.json` |

---

## 9. 变更记录

完整变更历史见 `doc/CHANGELOG.md`。近期关键变更：

- **2026-08-31（无边框标题栏 v2）**：`Frameless: true` + 自绘窗口控制按钮；修复拖动失效（`-webkit-app-region` → `--wails-draggable`）与按钮失效（no-drag 显式覆盖）；双击标题栏最大化、resize 防抖状态同步；titlebar.test.ts 11 项
- **2026-08-31（P0 修复版）**：ReadText 伪文件防护、原子写 Sync、写路径守卫、setContent 不入 undo 历史；占位符加盐防伪造、FENCE/inRanges 线性化（ReDoS）
- **2026-08-31（回退版）**：撤销无边框自定义标题栏，恢复系统原生
- **2026-08-30**：新增 LaTeX 公式渲染（KaTeX）；体积优化；文件关联冷启动 + 单实例锁

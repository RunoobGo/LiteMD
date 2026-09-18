# LiteMD

[![CI](https://github.com/RunoobGo/LiteMD/actions/workflows/ci.yml/badge.svg)](https://github.com/RunoobGo/LiteMD/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.11-blue.svg)](./doc/CHANGELOG.md)
[![Go](https://img.shields.io/badge/Go-1.27.1-00ADD8?logo=go)](https://go.dev/)
[![Platform](https://img.shields.io/badge/platform-Windows%2011%20x64-0078D6?logo=windows)](https://www.microsoft.com/windows)

**一个 3.6 MB 的桌面 Markdown 编辑器** —— 用 Go + WebView2 把原生桌面的启动速度和文件关联能力，与 CodeMirror 6 的编辑体验压进一个不到 4 MB 的安装包里，并原生兼容 Obsidian 语法。

> 如果你受够了 Electron 编辑器动辄 100 MB 体积、几秒冷启动，又不想放弃 `[[双链]]`、callout、frontmatter 这些 Obsidian 写法 —— LiteMD 就是为此而生的。

---

## ✨ 核心特性

**1. 秒开与极小体积**
Wails (Go) + 系统自带 WebView2，无内嵌 Chromium。安装包 3.6 MB（LZMA 固实压缩），冷启动在毫秒级。

**2. Obsidian 语法原生兼容**
`[[双链]]` 跳转、`> [!note]` callout、`--- frontmatter ---` 解析、拖入/粘贴图片自动复制到 `assets/` 并改写为相对路径。笔记库可直接在 LiteMD 与 Obsidian 之间双向流动。

**3. 安全优先的渲染管线**
预览走 marked → DOMPurify → 链接白名单三层过滤，LaTeX 以 `trust: false` 渲染。后端另有敏感路径黑名单（`.env`、`.aws/credentials`、`id_rsa` 等）阻止 `file://` 越权读取，文件写入采用「临时文件 + fsync + rename」原子写，并保存前用 mtime 检测外部篡改。

**4. 为长文档设计的导航**
侧边栏大纲树支持层级折叠、点击跳转、跟随光标高亮（`Ctrl+B`），配同步滚动与三档分屏模式。

**5. 完整的桌面集成**
NSIS 安装器支持 `.md` / `.markdown` / `.mdown` / `.mkd` / `.mkdn` 五种文件关联、双击打开、单实例锁（第二个实例会把文件路径转交给已运行的窗口后退出）。

---

## 🚀 快速开始

### 直接使用（Windows 11 x64）

1. 从 [Releases](https://github.com/RunoobGo/LiteMD/releases) 下载 `LiteMD-0.2.11-Setup-x64.exe`
2. 双击运行 → 下一步，自动创建快捷方式并关联 `.md` 文件
3. 双击任意 `.md` 文件即可打开

> **WebView2**：Windows 11 通常已自带；缺失时安装器会提示下载地址，不阻断安装。
> 便携版 `Portable-x64.zip` 解压即用，不写注册表。

### 从源码构建

**前置依赖**

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Go | ≥ 1.27.1 | 与 `go.mod` 的 `go` 指令一致 |
| Node.js | ≥ 20 | 前端构建（CI 使用 20） |
| Wails CLI | v2.14.0 | 桌面壳构建工具 |
| NSIS | 3.x | 仅 Windows 打包安装器时需要 |

**最小可运行示例**

```bash
# 1. 安装 Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@v2.14.0

# 2. 安装前端依赖
cd frontend && npm ci && cd ..

# 3. 启动开发模式（前端热重载 + Go 热重载）
wails dev
```

`wails dev` 会拉起一个带热重载的桌面窗口。前端逻辑也可脱离桌面壳，在浏览器里单独调试：

```bash
cd frontend
npm run dev      # 仅前端，Vite dev server，用 dev-bootstrap.ts 里的 mock 替代 Go 后端
```

**测试**

```bash
# 前端单测（17 个套件全绿）
cd frontend && LITEMD_TEST=all npx tsx src/preview.test-bootstrap.ts

# Go 单测（86 个测试函数，含 race 检测）
# 注意：main.go 用 //go:embed all:frontend/dist 嵌入前端产物，
# 需先构建一次前端，否则报 "pattern all:frontend/dist: no matching files found"
cd frontend && npm run build && cd ..
go test ./... -race -count=1
```

**打包**

```bash
export GOTOOLCHAIN=auto
OUT=/path/to/dist ./build-win11-x64.sh

# 版本号默认自动 patch+1（0.2.11 → 0.2.12），并同步全部版本事实源
# 重打包同一版本：SKIP_BUMP=1 ./build-win11-x64.sh
# 指定版本：    VERSION=1.0.0 ./build-win11-x64.sh
```

---

## ⌨️ 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+N` | 新建标签 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存为 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+P` | 切换分屏 / 预览模式 |
| `Ctrl+F` | 查找 |
| `Ctrl+H` | 查找替换 |
| `Ctrl+B` | 切换大纲侧边栏 |

---

## 📁 项目结构

```
LiteMD/
├── main.go              # Wails 入口：窗口配置、单实例锁、启动文件消费
├── app.go               # 绑定给前端的后端方法（打开/保存/配置/资产/外部链接）
├── errcode.go           # 前后端统一的错误码体系
├── startupfile.go       # 双击 .md 与二实例间的启动文件传递
├── internal/
│   ├── config/          # 最近文件、主题等配置的持久化读写
│   ├── fileio/          # 原子写、图片资产复制、安全路径校验
│   └── links/           # 链接分类、敏感路径黑名单、外部程序打开
├── frontend/
│   ├── src/             # TypeScript 源码：编辑器/预览/大纲/标签/主题/分屏
│   └── wailsjs/         # Wails 自动生成的 Go ↔ TS 绑定（勿手改）
├── build/               # Wails 平台构建资源（macOS bundle 配置等）
├── nsis-src/            # Windows 安装器脚本（NSIS，含文件关联与注册表项）
├── e2e/                 # 真实 Chromium 端到端脚本（sprint1~sprint7）
├── doc/                 # 按软件生命周期组织的全流程文档
└── .github/workflows/   # CI：go-test / frontend-test / npm-audit / 打 tag 构建
```

---

## 🛠 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Wails v2.14（Go 1.27.1 + WebView2） |
| 编辑器 | CodeMirror 6（@codemirror/lang-markdown、search、autocomplete） |
| 渲染 | marked v18 → DOMPurify v3 → KaTeX v0.16 → Mermaid v11 |
| 前端工程 | TypeScript 5.9 + Vite 7 |
| 打包 | NSIS（LZMA 固实压缩） |

**为什么选 Wails 而不是 Electron**：Go 二进制 + 系统 WebView2 让安装包从 ~100 MB 降到 3.6 MB，代价是需要自己处理跨语言边界的错误码传递和文件系统安全——`errcode.go` 与 `internal/links` 就是为此存在的。

---

## 🤝 贡献指南

欢迎 Issue 与 PR。为保证质量，请遵循：

1. **先开 Issue 再动手** —— 尤其是涉及渲染管线、安全策略或文件关联的改动，这些区域有对应的审计结论，需要对齐后再改。
2. **提交前跑通测试** —— 前端 17 套件 + Go `go test ./... -race` 必须全绿，且 `gofmt -l .` 无输出，CI 会以此拦截。
3. **提交信息用 Conventional Commits** —— 如 `fix(preview): callout 行号漂移`。
4. **改动测试必同步文档** —— `doc/test/TEST-MATRIX.md` 是测试事实源，任何测试变更都要同步更新（见 `doc/README.md` 的维护纪律）。
5. **新增文档要挂进地图** —— 新文档需在 `doc/README.md` 的导航中登记。

**安全相关**：本项目把「链接白名单 + 敏感路径黑名单 + 原子写」当作三道防线。若发现绕过路径，请**不要**开公开 Issue，直接通过私人渠道联系维护者。

---

## 📜 文档

> 全流程文档地图（按软件生命周期组织）见 **[doc/README.md](./doc/README.md)**。快速索引：

| 文档 | 内容 |
| --- | --- |
| [doc/TECHNICAL.md](./doc/TECHNICAL.md) | 技术文档：架构 / 渲染管线 / 安全模型 / 构建 / 待办 |
| [doc/CHANGELOG.md](./doc/CHANGELOG.md) | 版本变更日志（逐版本） |
| [doc/design/PRINCIPLES.md](./doc/design/PRINCIPLES.md) | 设计原则与工程约定、主题配色 |
| [doc/test/TEST-MATRIX.md](./doc/test/TEST-MATRIX.md) | 分级测试矩阵、运行方式、覆盖率统计 |
| [doc/audit/](./doc/audit/) | 审计与评审报告（AUDIT / CODE-REVIEW） |
| [doc/archive/](./doc/archive/) | 历史归档（开发计划 / 评审 / 测试审计 / 发布说明） |

---

## 📄 许可

[MIT License](./LICENSE) © 2026 LiteMD

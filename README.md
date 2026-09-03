# LiteMD

**极致轻量 · Markdown 编辑器**（Windows 11 x64）

> 基于 Wails (Go) + CodeMirror 6 的桌面 Markdown 编辑器。启动快、安装包小（3.6 MB）、支持 LaTeX 公式与 Obsidian 语法。

## ✨ 核心特性

- 📝 **CodeMirror 6** — 行号、Markdown 高亮、搜索、自动补全
- 📐 **LaTeX 公式** — `$行内$` 与 `$$块级$$`，KaTeX 渲染（`trust:false` 安全配置）
- 👀 **实时预览** — marked + DOMPurify，多层 XSS 防护
- 📑 **文档大纲** — 侧边栏层级树，点击跳转、跟随光标高亮、子章节可折叠（`Ctrl+B`）
- 🔗 **Obsidian 兼容** — `[[双链]]` / `> [!callout]` / `--- frontmatter ---`
- 📁 **多标签** — 原子写（临时文件 + fsync + rename）、关闭未保存提示
- 🖼 **图片资产** — 拖入/粘贴自动复制到 `assets/`
- 🎨 **双主题** — 暗色 GitHub 风格 / 亮色护眼，一键切换
- 🖥 **NSIS 安装器** — 桌面快捷方式 + `.md` / `.markdown` / `.mdown` / `.mkd` / `.mkdn` 文件关联 + 单实例锁

## 📦 安装

1. 下载 `LiteMD-0.2.10-Setup-x64.exe`
2. 双击运行 → 下一步
3. 自动创建快捷方式 + 关联 .md 文件

> **WebView2**：Win11 通常已自带。缺失时安装器会提示下载地址，不阻断安装。
>
> 便携版（`Portable-x64.zip`）解压即用，不写注册表。

## ⌨️ 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+N` | 新建标签 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存为 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+P` | 切换分屏/预览模式 |
| `Ctrl+F` | 查找 |
| `Ctrl+H` | 查找替换 |
| `Ctrl+B` | 切换大纲侧边栏 |

## 🛠 技术栈

- **桌面壳**：Wails v2.14（Go 1.25 + WebView2）
- **前端**：TypeScript + Vite + CodeMirror 6 + marked + DOMPurify + KaTeX
- **打包**：NSIS（LZMA 固实压缩）

## 🧪 开发

```bash
# 依赖
go install github.com/wailsapp/wails/v2/cmd/wails@v2.14.0
cd frontend && npm ci && cd ..

# 开发模式（热重载）
wails dev

# 前端测试（全量：preview + obsidian + latex）
cd frontend && LITEMD_TEST=all npx tsx src/preview.test-bootstrap.ts

# Go 测试（含 race 检测）
# 前置条件：main.go 用 `//go:embed all:frontend/dist` 嵌入前端产物，
# 须先构建一次前端，否则报 `pattern all:frontend/dist: no matching files found`。
go test ./... -race -count=1

# E2E 测试（真实 Chromium，需要 agent-browser CLI）
# sprint1~5：标签 / CodeMirror / Obsidian 语法 / 主题 / LaTeX / 启动屏
# sprint6：目录树（大纲）解析 / 折叠 / 三模式点击跳转 / 滚动跟随高亮
# sprint7：侧边栏内容栏扩展 / 顶栏 tooltip z-index / 顶栏高度压缩 /
#         预览链接相对路径 + 危险 scheme 过滤 / 代码块语言标签 + 复制按钮
cd e2e && ./sprint6.sh && ./sprint7.sh

# 一键构建 Windows 产物
export GOTOOLCHAIN=auto
OUT=/path/to/dist ./build-win11-x64.sh

# 打包时自动把版本号第三位 +1（0.2.2 → 0.2.3），并同步五处版本事实源。
# 重打包同一版本：SKIP_BUMP=1 ./build-win11-x64.sh
# 指定版本：VERSION=1.0.0 ./build-win11-x64.sh
```

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

## 📄 许可

MIT License

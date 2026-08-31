# LiteMD

**极致轻量 · Markdown 编辑器**（Windows 11 x64）

> 基于 Wails (Go) + CodeMirror 6 的桌面 Markdown 编辑器。启动快、安装包小（3.6 MB）、支持 LaTeX 公式与 Obsidian 语法。

## ✨ 核心特性

- 📝 **CodeMirror 6** — 行号、Markdown 高亮、搜索、自动补全
- 📐 **LaTeX 公式** — `$行内$` 与 `$$块级$$`，KaTeX 渲染（`trust:false` 安全配置）
- 👀 **实时预览** — marked + DOMPurify，多层 XSS 防护
- 🔗 **Obsidian 兼容** — `[[双链]]` / `> [!callout]` / `--- frontmatter ---`
- 📁 **多标签** — 原子写（临时文件 + fsync + rename）、关闭未保存提示
- 🖼 **图片资产** — 拖入/粘贴自动复制到 `assets/`
- 🎨 **双主题** — 暗色 GitHub 风格 / 亮色护眼，一键切换
- 🖥 **NSIS 安装器** — 桌面快捷方式 + `.md` 文件关联 + 单实例锁

## 📦 安装

1. 下载 `LiteMD-0.2.0-Setup-x64.exe`
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
| `Ctrl+Shift+F` | 查找替换 |

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
go test ./... -race -count=1

# 一键构建 Windows 产物
export GOTOOLCHAIN=auto
OUT=/path/to/dist ./build-win11-x64.sh
```

## 📜 文档

- [doc/TECHNICAL.md](./doc/TECHNICAL.md) — 技术文档（架构 / 渲染管线 / 安全模型 / 构建 / 待办）
- [doc/CHANGELOG.md](./doc/CHANGELOG.md) — 版本变更日志
- [doc/archive/](./doc/archive/) — 历史文档归档（开发计划 / 评审 / 测试审计 / 发布说明）

## 📄 许可

MIT License

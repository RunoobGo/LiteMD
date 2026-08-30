# LiteMD

**极致轻量 · Markdown 编辑器**（Windows x64）

> 基于 Wails (Go) + CodeMirror 6，目标是对标 Obsidian 的「快捕」场景 — 启动 < 1 秒、内存 < 200MB、安装包 < 5MB。

## ✨ 核心特性

- 🚀 **极速启动** — 3.0 MB 安装包，UPX 压缩
- 📝 **CodeMirror 6** — 行号、Markdown 高亮、搜索、命令面板
- 👀 **实时预览** — marked + DOMPurify，XSS 多层防护
- 🔗 **Obsidian 兼容** — `[[双链]]` / `> [!callout]` / `--- frontmatter ---`
- 📁 **多标签** — 文件 IO（原子写）、关闭未保存提示
- 🖼 **图片资产** — 拖入/粘贴自动复制到 `assets/`
- 🎨 **双主题** — 暗色为 GitHub 风格；亮色为浅护眼配色（米杏/豆沙绿），一键切换 + 玻璃态顶栏
- 🔄 **自动更新** — GitHub Releases API，5s 静默检查
- 🖥 **NSIS 安装器** — 桌面/开始菜单快捷方式 + .md 文件关联

## 📦 安装

### Windows 用户

1. 下载 `LiteMD-Setup-v0.2.0.exe`（3.0 MB）
2. 双击运行 → 下一步
3. 自动创建桌面快捷方式 + 关联 .md 文件

### 开发者

```bash
# 1. 克隆仓库
git clone https://github.com/litemd/litemd.git
cd litemd

# 2. 安装依赖（Go 1.25+, Node.js 18+, Wails v2.14）
go install github.com/wailsapp/wails/v2/cmd/wails@latest
cd frontend && npm install && cd ..

# 3. 开发模式（热重载）
wails dev

# 4. 生产构建（Windows x64）
wails build -platform windows/amd64

# 5. 压缩 + 打包安装器
upx --best --lzma build/bin/LiteMD.exe
cd build/nsis && makensis LiteMD-Setup.nsi
```

## 🖥 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+N` | 新建标签 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存为 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+P` | CodeMirror 命令面板 |
| `Ctrl+F` | 查找 |
| `Ctrl+H` | 查找替换 |

## 📁 数据目录

- **配置**：`%USERPROFILE%\.litemd\config.json`
- **资产**：`./assets/`（相对于每个 .md 文件）

## 🛠 技术栈

- **后端**：Go 1.25 + Wails v2.14
- **前端**：TypeScript + Vite + CodeMirror 6 + marked + DOMPurify
- **打包**：NSIS 3.09 + UPX 4.2

## 📊 性能指标

| 指标 | 数值 |
| --- | --- |
| 安装包大小 | 3.0 MB |
| 启动时间 | < 1.5 秒 |
| 100KB 文档渲染 | 692ms |
| 测试用例总数 | **Go 单测 50 / 前端单测 52 / E2E 脚本 80 ≈ 182 用例，99% 通过** |

## 🧪 开发

```bash
# 安装 Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# 开发模式（热重载）
wails dev

# 生产构建
wails build -platform windows/amd64

# UPX 压缩
upx --best --lzma build/bin/LiteMD.exe

# NSIS 打包
cd build/nsis && makensis LiteMD-Setup.nsi
```

## 📜 文档

- [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) — 完整开发计划 + 5 Sprint 验收
- [CHANGELOG.md](./CHANGELOG.md) — 版本变更日志
- [RELEASE-NOTES.md](./RELEASE-NOTES.md) — v0.2.0 发布说明
- [e2e/](./e2e/) — 自动化 E2E 脚本（sprint1-5）

## 📄 许可

MIT License

## 🤝 反馈

- GitHub Issues: https://github.com/litemd/litemd/issues
- 项目主页: https://github.com/litemd/litemd

# LiteMD Changelog

LiteMD 版本变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 约定，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

---

## [0.2.0] — 2026-08-12

**首个生产可用版本**：对标 Obsidian 快捕场景，启动 < 1.5s、安装包 3MB、内存 < 200MB。

### ✨ 新增

- **CodeMirror 6 编辑器**：行号、Markdown 语法高亮、搜索 (`Ctrl+F`)、
  替换 (`Ctrl+H`)、命令面板 (`Ctrl+P`)、多种 keyMap（默认 / Vim / Emacs）。
- **实时预览（分屏）**：`marked` 渲染 + `DOMPurify` 清洗 + `hardenLinks` 外链
  加固（`target="_blank" rel="noopener noreferrer"`）+ 内部锚点不被加固。
- **Obsidian 语法兼容层**：
  - `[[Note Name]]` / `[[Note|Alias]]` 双链 → 渲染为 `#/wiki/<url>` 锚点，
    点击自动切换到已打开的同名 Tab。
  - `> [!note|tip|warning|danger|...]` 12 种 callout → 彩色 blockquote 容器
    （标题 + body 分离）。
  - `---\nkey:value\n---` YAML Frontmatter → 独立折叠面板展示，支持
    Windows CRLF 换行与带端口的 URL value（`url: https://x:8080/p`）。
- **多标签页管理**：
  - `Ctrl+N` 新建 / `Ctrl+O` 打开 / `Ctrl+W` 关闭 / `Ctrl+S` 保存 /
    `Ctrl+Shift+S` 另存为。
  - 关闭未保存 `<dialog>` 原生对话框拦截（标题带 `•` 脏标记）。
- **图片资产**：拖拽 / 粘贴图片自动复制到 `<md 文件目录>/assets/` 并写入
  `![name](./assets/name.png)`；base64 解码用 `FileReader.readAsDataURL`
  （避免大图片栈溢出）。
- **深色渐变主题（GitHub Dark）**：玻璃态顶栏、Compartment 热切换（刷新不变）、
  编辑器字号 / 字体 / 分屏比例全部可配置，自动写入
  `%USERPROFILE%\.litemd\config.json`（Windows）或 `$HOME/.litemd/config.json`。
- **自动更新检查**：
  - 启动 5s 后 + 菜单手动触发 GitHub Releases API 检查。
  - 严格 semver 比较（`1.2.3` 正式版 > `1.2.3-rc1` 预发布版）。
  - 24h 节流（保存失败 log，不阻塞返回）。
  - 资产选择：优先 `LiteMD*-Setup-*.exe`，支持 Pro / Enterprise 变体，
    fallback 到 `LiteMD*.exe` 排除 source 包。
- **NSIS 安装器**：桌面快捷方式 + 开始菜单 + `.md` 文件关联 + 卸载完整清理。

### 🛡 安全

- XSS 5 层防护链：preprocessWikiLinks 过滤 → marked GFM → DOMPurify
  → hardenLinks 外链加固 → DOM scrub 2 次 pass。单元测试覆盖 `<script>`、
  `javascript:` 协议、`onerror`、`<iframe>`、`onclick` 5 种载荷。
- `App.SaveFileAs` 使用系统原生 SaveFileDialog（Wails runtime），拒绝直接
  以路径写入，避免路径穿越。

### 🚀 性能

- 安装包：3.0 MB（NSIS + UPX `--best --lzma`）。
- 启动：< 1.5 秒（冷启动）。
- 100KB 文档渲染（约 500 个 h2）：注入 + 渲染约 692 ms。
- 文件读写：原子写（临时文件 + rename），避免崩溃导致原文件损坏。

### 🧪 测试

- Go 单元测试 4 包：app(12) / config(7) / fileio(12) / updater(19) — 合计 50 用例。
- 前端单元测试：preview(19) + obsidian(33) — 合计 52 用例（含 CRLF 边界
  与 F10 link 负向覆盖）。
- E2E 自动化 5 份脚本（sprint1~5）：约 80+ 项断言（CodeMirror、性能、
  Obsidian 语法、构建产物、更新检查）。

### 🧹 代码质量（v0.2.0 审查修复）

- 修复 B 系列后端高/中/低优 14 项（B1~B16，除 P5 生产签名外全修）。
- 修复 F 系列前端高/中/低优 17 项（F1~F17，F18/F19 按低优保留）。
- 修复 T/E 系列测试/E2E 19 项：95% 已完成（剩余 E14 截图路径
  环境变量化按 CI 配置节奏补充）。

---

## [0.1.0] — 2026-06-30

**Sprint 0 原型版本**：内部验证，功能不完整。

### 新增

- Wails v2 基础骨架：Go 嵌入 Vite 产物 + Wails binding 示例。
- CodeMirror 6 基础配置（GFM 高亮）。
- marked + DOMPurify 预览雏形（无分屏、无 Obsidian 兼容）。

### 已知问题

- 分屏交互未实现。
- 多标签管理未实现。
- 自动更新与 NSIS 安装器未接入。
- 测试体系未建立（无单测 / E2E）。

---

[0.2.0]: https://github.com/litemd/litemd/releases/tag/v0.2.0
[0.1.0]: https://github.com/litemd/litemd/releases/tag/v0.1.0

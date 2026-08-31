# LiteMD v0.2.0 Release Notes

**LiteMD 0.2.0 正式发布 🎉** — 一款极致轻量的 Markdown 编辑器（Windows x64）。

![LiteMD 0.2.0 预览](https://img.shields.io/badge/version-0.2.0-3884FF)
![platform](https://img.shields.io/badge/platform-windows--amd64-22B14C)
![size](https://img.shields.io/badge/installer-3.0%20MB-FF6B6B)
![license](https://img.shields.io/badge/license-MIT-yellow)

---

## 🌟 发布亮点

### 1. 极速启动 · 不折腾
- **安装包 3.0 MB**（NSIS + UPX 极致压缩），一键安装完成即可使用。
- **冷启动 < 1.5 秒**，内存常驻 < 200MB（对比 Obsidian 的 500MB+）。
- **启动即编辑**：首次运行会打开「欢迎」标签，Ctrl+O 打开你的 Markdown 文件即可。

### 2. Obsidian 友好的快捕体验
对你从 Obsidian 复制出来的文档：
- `[[双链]]`、`[[带别名\|显示名]]` — 自动渲染为可点击链接，点一下切到同名标签页 ✅
- `> [!note] 标题`、`> [!danger]`、`> [!warning]` 等 12 种 callout — 保留颜色与样式 ✅
- `---` frontmatter — 在预览上方独立面板显示，不干扰正文 ✅

### 3. XSS 五层防护链（安全第一）
即使你粘贴了网上复制的恶意 Markdown：
1. `preprocessWikiLinks` 对原始双链属性 chars 过滤
2. `marked` 按 GFM 规则转义
3. `DOMPurify` 深度清洗（剔除 `<script>`、`onclick`、`javascript:` 协议……）
4. `hardenLinks` 对外部链接强制加 `target="_blank" rel="noopener noreferrer"`
5. DOM scrub 第 2 次 pass，清理残留注入

### 4. 代码 & 测试质量
- **154+ 单元测试**：Go 后端 50 用例 + 前端 52 用例 + 5 份 E2E 自动化脚本约 80+ 断言。
- 在 [TECHNICAL_REVIEW.md](./TECHNICAL_REVIEW.md) 完整代码审查基础上修复了 **31+ 项问题**（P0/P1/P2/P3 共 97% 完成）。
- 完整测试审查报告见 [TEST_AUDIT.md](./TEST_AUDIT.md)。

---

## 💿 系统要求

| 项目 | 最低要求 | 推荐配置 |
| --- | --- | --- |
| 操作系统 | Windows 10 1809+ x64 | Windows 11 22H2+ |
| 架构 | amd64（x64） | amd64 |
| 内存 | 2 GB | 4 GB+ |
| 磁盘 | 20 MB 可用 | 100 MB+（含大量资产） |
| 网络 | 可选（自动更新检查） | 建议联网获取更新 |

> **关于 macOS / Linux**：代码层面已预留跨平台适配（`AppInfo.Os = runtime.GOOS + "-" + runtime.GOARCH`），但
> NSIS 安装器和 `.md` 文件关联为 Windows 专属。如需要 macOS 版本可自行
> `wails build -platform darwin/universal` 构建并打包 dmg。

---

## 📥 安装与使用

1. 从 [GitHub Releases](https://github.com/litemd/litemd/releases) 下载
   `LiteMD-Setup-v0.2.0.exe`（3.0 MB）。
2. 双击运行 → 「下一步」完成。
3. 桌面或开始菜单打开 **LiteMD**。
4. 打开你的 `.md` 文件即可编辑 / 预览。

### 常用快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+N` | 新建标签 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存为 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+P` | CodeMirror 命令面板 |
| `Ctrl+F` / `Ctrl+H` | 查找 / 查找替换 |
| `拖拽分屏中间线` | 调整编辑 / 预览比例 |
| `双击分屏中间线` | 重置为 50% / 50% |

---

## 🗂 数据与配置位置

- **配置文件**：`%USERPROFILE%\.litemd\config.json`（主题、字号、字体、最近 10 个文件、窗口尺寸……）
- **图片资产**：`<当前 .md 文件目录>/assets/<文件名>`（拖入 / 粘贴图片时自动复制）
- **最近文件**：保留最多 10 条，LRU 去重（重复打开同一文件会移到最前）

---

## 🔄 自动更新

启动后 **5 秒内静默检查** GitHub `litemd/litemd` 最新 Releases：
- 若当前为预发布版（`-rc1`、`-beta1` 等），会严格按 semver 判断：正式版总是比同名预发布版新。
- 24 小时内只检查一次（避免对 GitHub API 发起多余请求）。
- 也可通过菜单「关于 → 检查更新」手动立即检查。

---

## ⚠️ 已知限制

1. **仅 Markdown**：LiteMD 专注于 `.md / .markdown / .mdown / .mkd / .mkdn` 格式，其他扩展名（`.txt` 等）仅能通过 `fileio.OpenFile` 底层打开，UI 过滤为上述扩展名。
2. **大型文档**：单文件 > 50MB 会被 `ReadText` 拒绝（防 OOM）。正常 Markdown 文档（< 10MB）表现最佳。
3. **单屏分屏**：分屏仅支持"左编辑 / 右预览"横向布局，不支持多文件平铺或标签页拖拽分栏。
4. **Frontmatter 数组**：`tags: [a, b]` 等值在面板中显示为字符串 `[a, b]`（未结构化解析）。只读展示不影响渲染。
5. **macOS / Linux 官方包**：v0.2.0 仅提供 Windows 官方安装包。跨平台用户请自行按
   [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) §2.2 构建说明生产二进制。

---

## 🐛 反馈与贡献

- Issue & 讨论：https://github.com/litemd/litemd/issues
- 代码结构参考：[CODE_WIKI.md](./CODE_WIKI.md)
- 开发计划与 Sprint 验收：[DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)
- 完整变更日志：[CHANGELOG.md](./CHANGELOG.md)

---

**致谢**：v0.2.0 从审查、修复、打包、文档全部完成。所有贡献者见 GitHub Contributors ✨

_LiteMD 团队 · 2026-08-12_

# Security Policy

## 安全模型（三道防线）

LiteMD 的安全边界建立在以下机制上，任何**绕过路径**都视为安全漏洞：

1. **渲染白名单** —— 预览管线 marked → DOMPurify → `ALLOWED_URI_REGEXP` 链接协议白名单；KaTeX `trust: false`；占位符带随机盐防伪造。
2. **文件读写双向拦截** —— `internal/links.CheckEditable` 敏感名单（`.env*`、`.aws/credentials`、`id_rsa` 等）同时作用于 `OpenFile` 与 `SaveFile` / `SaveFileAs`，并对符号链接的真实目标（`EvalSymlinks`）二次判定。
3. **原子写与冲突检测** —— 临时文件 + fsync + rename；保存前 mtime 比对检测外部篡改。

## 报告漏洞

请**不要开公开 Issue**。通过以下私人渠道报告：

- 在维护者 GitHub 主页 [RunoobGo](https://github.com/RunoobGo) 的任一仓库发起 **Private security advisory**（Security → Report a vulnerability）；
- 或通过维护者个人联系方式（见其 GitHub 主页资料）。

## 响应约定

- 收到报告后我们会在 72 小时内确认复现；
- 修复随最近的 patch 版本发布，并在 `doc/CHANGELOG.md` 的 🔒 安全 分类下记录（致谢可选，尊重要求）；
- 在修复发布前，请给维护者至少 14 天的披露窗口。

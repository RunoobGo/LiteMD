# LiteMD 文档体系导航

> 本页是 LiteMD 全部技术文档的**单一入口**。按软件生命周期（规划 → 设计 → 开发 → 测试 → 发布 → 审计）组织，目标是让任何角色都能在 1 分钟内定位所需文档。

- **产品入口**（用户视角）：见仓库根 [README.md](../README.md)
- **版本基线**：tag `v0.2.12`（2026-09-18，Pre-release，四平台 CI 产物）；工作区代码领先 tag 一个未发布批次
- **当前批次**：[CHANGELOG.md](./CHANGELOG.md) `[Unreleased]` 段 = v0.2.12 之后的「全面审查与测试补强」批次（敏感文件读写双向拦截 + 符号链接白名单加固 + 标题栏关闭双弹框修复 + 测试补强至 Go 107 例 / 前端 17 套件），待发布为下一版本

---

## 从哪读起

| 你的角色 | 建议路径 |
|---|---|
| 新读者 / 想快速了解项目 | `README.md` → [TECHNICAL.md](./TECHNICAL.md) §1-4 → [design/PRINCIPLES.md](./design/PRINCIPLES.md) |
| 前端 / 后端开发 | [TECHNICAL.md](./TECHNICAL.md)（架构/渲染管线/安全模型）+ [design/PRINCIPLES.md](./design/PRINCIPLES.md) |
| 测试 / QA | [TEST-MATRIX.md](./TEST-MATRIX.md) |
| 发布 / 运维 | [CHANGELOG.md](./CHANGELOG.md) + [TECHNICAL.md](./TECHNICAL.md) §6 构建打包 |
| 审阅最近改动 / 追溯历史 | [audit/](./audit/) + [archive/](./archive/) |

---

## 生命周期 × 文档矩阵

| 阶段 | 文档 | 定位 | 主要读者 | 更新触发 |
|---|---|---|---|---|
| 规划 / 需求 | [archive/DEVELOPMENT_PLAN.md](./archive/DEVELOPMENT_PLAN.md) | 项目目标、范围边界（v0.2.0 历史基线） | 产品 / 架构 | 一次性，历史冻结 |
| 设计 / 架构 | [TECHNICAL.md](./TECHNICAL.md) | 架构总览、渲染管线、安全模型、构建 | 全研发 | 每次功能/安全变更 |
| 设计原则 | [design/PRINCIPLES.md](./design/PRINCIPLES.md) | 跨模块设计约定与编码纪律（原子写、XSS、并发） | 全研发 | 新增约定时 |
| 建议 / 路线图 | [design/ROADMAP-2026-09-03.md](./design/ROADMAP-2026-09-03.md) | 优化/改进/功能开发建议与预期效果（R1-R12） | 架构 / 研发 | 每轮评审 |
| 测试 | [TEST-MATRIX.md](./TEST-MATRIX.md) | 分级测试矩阵、运行方式、覆盖率统计 | QA / 研发 | 每次用例变更 |
| 发布 | [CHANGELOG.md](./CHANGELOG.md) | 版本变更日志（逐版本平铺） | 发布 / 全团队 | **每次修复/功能落地** |
| 发布说明 | [archive/RELEASE-NOTES.md](./archive/RELEASE-NOTES.md) | v0.2.0 发布亮点（历史） | 市场 / 用户 | 一次性，历史冻结 |
| 审计 / 评审 | [audit/AUDIT-2026-09-03.md](./audit/AUDIT-2026-09-03.md) | 第一轮全景审计（7 项 P1 全部修复） | 研发 / 架构 | 每次大审查 |
| 审计 / 评审（R2）| [audit/AUDIT-2026-09-03-R2.md](./audit/AUDIT-2026-09-03-R2.md) | 第二轮审计（F1 错误码体系 + G1-G11 / F2-F17） | 研发 / 架构 | 每次大审查 |
| 审计总结 | [audit/AUDIT-SUMMARY-2026-09-03.md](./audit/AUDIT-SUMMARY-2026-09-03.md) | 第一轮审计一页版结论 | 管理层 / 研发 | 每次大审查 |
| 审计总结（R2）| [audit/AUDIT-SUMMARY-2026-09-03-R2.md](./audit/AUDIT-SUMMARY-2026-09-03-R2.md) | 第二轮审计一页版结论（F1 错误码体系 + 20 P1 + 18 P2 全部修复） | 管理层 / 研发 | 每次大审查 |
| 文档整合计划 | [archive/DOC-INTEGRATION-PLAN-2026-09-03.md](./archive/DOC-INTEGRATION-PLAN-2026-09-03.md) | 2026-09-03 文档体系整合的执行计划（已落地） | 文档维护者 | 一次性，历史冻结 |
| 历史归档 | [archive/](./archive/) | 已取代文档（标注基线，仅追溯） | — | 一次性，历史冻结 |

---

## 文档目录速览

```
doc/
├── README.md                    ← 本导航门户
├── CHANGELOG.md                 版本变更日志（主文档锚点）
├── TECHNICAL.md                 技术文档（架构/管线/安全/构建/测试，主文档锚点）
├── TEST-MATRIX.md               分级测试矩阵与运行文档（测试事实源）
├── design/
│   ├── PRINCIPLES.md            设计原则与约定（含主题配色）
│   └── ROADMAP-2026-09-03.md    优化/改进/功能建议（R1-R12）
├── audit/                       全景审计报告（活文档，随审查轮次增补）
│   ├── AUDIT-2026-09-03.md            第一轮全景审计主报告（7 项 P1 已修复）
│   ├── AUDIT-2026-09-03-R2.md         第二轮全景审计（F1 错误码体系 + G1-G11/F2-F17）
│   ├── AUDIT-SUMMARY-2026-09-03.md    第一轮审计总结
│   └── AUDIT-SUMMARY-2026-09-03-R2.md 第二轮审计总结
└── archive/                     历史归档（每份均带「归档声明」头部）
    ├── CODE_WIKI.md                 代码百科（§11 设计原则、§13 配色 → 已吸收）
    ├── DEVELOPMENT_PLAN.md          开发计划
    ├── DOC-INTEGRATION-PLAN-2026-09-03.md  文档整合计划（已落地）
    ├── RELEASE-NOTES.md             发布说明
    ├── TECHNICAL_REVIEW.md          技术复审
    ├── TEST_AUDIT.md                测试体系审查
    ├── CODE-REVIEW-2026-09-02.html  代码审查报告（历史）
    └── LiteMD-0.2.0-*.html          早期审查/修复交付报告（历史）
```

> E2E 手工测试素材（`Markdown-test.md` 全语法兼容性样本）随测试体系归入 `e2e/fixtures/`，截图存档在 `e2e/screenshots/`。

---

## 文档维护纪律

> 以下来自 2026-09-03 审计的教训，**必须遵守**：

1. **修复即日志**：每个审查/功能修复合入时代码时，**同步写一条 [CHANGELOG.md](./CHANGELOG.md)**（含 P0 安全修复），禁止发版日集中补记。
2. **发版前核对**：TECHNICAL.md 的「版本头」「测试统计」「待办表」是三大易失真点，发版 checklist 必须逐项刷新。
3. **测试矩阵跟随**：新增/删除测试时，更新 [TEST-MATRIX.md](./TEST-MATRIX.md) 的覆盖标记（🟢🟡🔴）。
4. **新约定入原则**：新增跨模块约定时，写入 [design/PRINCIPLES.md](./design/PRINCIPLES.md)，不散落各处。
5. **archive 冻结**：归入 archive/ 的文档只允许加「归档声明」，不修改原始内容。

---

*最后更新：2026-09-21（文档结构整理：TEST-MATRIX 上移为一级文档、一次性审查报告归档、E2E 素材归位）· 详见 [CHANGELOG.md](./CHANGELOG.md)*
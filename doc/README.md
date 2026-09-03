# LiteMD 文档体系导航

> 本页是 LiteMD 全部技术文档的**单一入口**。按软件生命周期（规划 → 设计 → 开发 → 测试 → 发布 → 审计）组织，目标是让任何角色都能在 1 分钟内定位所需文档。

- **产品入口**（用户视角）：见仓库根 [README.md](../README.md)
- **版本基线**：v0.2.9（2026-09-03）

---

## 从哪读起

| 你的角色 | 建议路径 |
|---|---|
| 新读者 / 想快速了解项目 | `README.md` → [TECHNICAL.md](./TECHNICAL.md) §1-4 → [design/PRINCIPLES.md](./design/PRINCIPLES.md) |
| 前端 / 后端开发 | [TECHNICAL.md](./TECHNICAL.md)（架构/渲染管线/安全模型）+ [design/PRINCIPLES.md](./design/PRINCIPLES.md) |
| 测试 / QA | [test/TEST-MATRIX.md](./test/TEST-MATRIX.md) |
| 发布 / 运维 | [CHANGELOG.md](./CHANGELOG.md) + [TECHNICAL.md](./TECHNICAL.md) §6 构建打包 |
| 审阅最近改动 / 追溯历史 | [audit/](./audit/) + [archive/](./archive/) |

---

## 生命周期 × 文档矩阵

| 阶段 | 文档 | 定位 | 主要读者 | 更新触发 |
|---|---|---|---|---|
| 规划 / 需求 | [archive/DEVELOPMENT_PLAN.md](./archive/DEVELOPMENT_PLAN.md) | 项目目标、范围边界（v0.2.0 历史基线） | 产品 / 架构 | 一次性，历史冻结 |
| 设计 / 架构 | [TECHNICAL.md](./TECHNICAL.md) | 架构总览、渲染管线、安全模型、构建 | 全研发 | 每次功能/安全变更 |
| 设计原则 | [design/PRINCIPLES.md](./design/PRINCIPLES.md) | 跨模块设计约定与编码纪律（原子写、XSS、并发） | 全研发 | 新增约定时 |
| 测试 | [test/TEST-MATRIX.md](./test/TEST-MATRIX.md) | 分级测试矩阵、运行方式、覆盖率统计 | QA / 研发 | 每次用例变更 |
| 发布 | [CHANGELOG.md](./CHANGELOG.md) | 版本变更日志（逐版本平铺） | 发布 / 全团队 | **每次修复/功能落地** |
| 发布说明 | [archive/RELEASE-NOTES.md](./archive/RELEASE-NOTES.md) | v0.2.0 发布亮点（历史） | 市场 / 用户 | 一次性，历史冻结 |
| 审计 / 评审 | [audit/AUDIT-2026-09-03.md](./audit/AUDIT-2026-09-03.md) | 本轮全景审计（问题/差异/测试计划） | 研发 / 架构 | 每次大审查 |
| 审计总结 | [audit/AUDIT-SUMMARY-2026-09-03.md](./audit/AUDIT-SUMMARY-2026-09-03.md) | 本轮审计一页版结论 | 管理层 / 研发 | 每次大审查 |
| 历史归档 | [archive/](./archive/) | 已取代文档（标注基线，仅追溯） | — | 一次性，历史冻结 |

---

## 文档目录速览

```
doc/
├── README.md                    ← 本导航门户
├── CHANGELOG.md                 版本变更日志（主文档锚点）
├── TECHNICAL.md                 技术文档（架构/管线/安全/构建/测试，主文档锚点）
├── design/
│   └── PRINCIPLES.md            设计原则与约定（含主题配色）
├── test/
│   └── TEST-MATRIX.md           分级测试矩阵与运行文档
├── audit/
│   ├── AUDIT-2026-09-03.md         全景审计主报告
│   ├── AUDIT-SUMMARY-2026-09-03.md 审计总结
│   ├── CODE-REVIEW-2026-09-02.html 代码审查（历史）
│   └── LiteMD-0.2.0-*.html         早期审查/交付报告（历史）
└── archive/                     历史归档（每份均带「归档声明」头部）
    ├── CODE_WIKI.md                 代码百科（§11 设计原则、§13 配色 → 已吸收）
    ├── DEVELOPMENT_PLAN.md          开发计划
    ├── RELEASE-NOTES.md             发布说明
    ├── TECHNICAL_REVIEW.md          技术复审
    └── TEST_AUDIT.md                测试体系审查
```

---

## 文档维护纪律

> 以下来自 2026-09-03 审计的教训，**必须遵守**：

1. **修复即日志**：每个审查/功能修复合入时代码时，**同步写一条 [CHANGELOG.md](./CHANGELOG.md)**（含 P0 安全修复），禁止发版日集中补记。
2. **发版前核对**：TECHNICAL.md 的「版本头」「测试统计」「待办表」是三大易失真点，发版 checklist 必须逐项刷新。
3. **测试矩阵跟随**：新增/删除测试时，更新 [test/TEST-MATRIX.md](./test/TEST-MATRIX.md) 的覆盖标记（🟢🟡🔴）。
4. **新约定入原则**：新增跨模块约定时，写入 [design/PRINCIPLES.md](./design/PRINCIPLES.md)，不散落各处。
5. **archive 冻结**：归入 archive/ 的文档只允许加「归档声明」，不修改原始内容。

---

*最后更新：2026-09-03（目录重构后）· 详见 [AUDIT-SUMMARY-2026-09-03.md](./audit/AUDIT-SUMMARY-2026-09-03.md)*
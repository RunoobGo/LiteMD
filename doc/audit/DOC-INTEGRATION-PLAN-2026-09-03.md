# LiteMD 文档体系整合计划

> 计划性质：正式执行档案（背景 → 目标 → 步骤 → 验证 → 执行记录）。
> 制定与执行：2026-09-03 ｜ 版本基线：v0.2.9 ｜ 状态：**已执行完成 ✅**

---

## 一、背景与动机

文档整合前，项目文档散布在 4 处（根 `README.md`、`doc/`、`doc/archive/`、`.workbuddy/`），存在四类结构性问题：

1. **无统一导航门户**：README 文档区仅列 3 项，未覆盖审计/评审报告；
2. **无全流程组织**：按软件生命周期（需求→设计→测试→发布→审计）无法快速定位文档；
3. **精华未吸收**：`doc/archive/CODE_WIKI.md`（901 行）的「§11 关键设计原则」与「§13 主题配色」仍适用于 v0.2.9，却被埋没在 v0.2.0 历史快照里；
4. **报告类混放**：本轮 `AUDIT-*.md` 与主文档 `TECHNICAL.md`/`CHANGELOG.md` 并列于 `doc/` 根，无分类。

## 二、目标

建立 doc 子目录 + 全流程导航门户，把报告/审计归位，吸收 archive 精华，并为 archive 历史文档加基线标注，最终形成由 `doc/README.md` 一键导航、各文档相互交叉引用的完整文档体系。

## 三、目标目录结构

```
doc/
├── README.md                      NEW   全流程导航门户（生命周期 × 文档矩阵 + 维护纪律）
├── CHANGELOG.md                   KEEP  版本变更日志（主文档锚点）
├── TECHNICAL.md                   KEEP  技术文档（主文档锚点；头部加交叉导航行）
├── design/
│   └── PRINCIPLES.md              NEW   设计原则与约定、主题配色（吸收 CODE_WIKI §11/§13）
├── test/
│   └── TEST-MATRIX.md             NEW   分级测试矩阵、运行方式、覆盖率（整合 AUDIT §3 + TECHANICAL §7 + TEST_AUDIT）
├── audit/
│   ├── AUDIT-2026-09-03.md        MOVE  全景审计主报告
│   ├── AUDIT-SUMMARY-2026-09-03.md MOVE 审计总结
│   ├── CODE-REVIEW-2026-09-02.html  MOVE
│   └── LiteMD-0.2.0-*.html         MOVE  早期审查/交付报告 ×2
└── archive/                       KEEP  历史归档 + 每份「归档声明」头部
    ├── CODE_WIKI.md / DEVELOPMENT_PLAN.md / RELEASE-NOTES.md
    ├── TECHNICAL_REVIEW.md / TEST_AUDIT.md
```

**关键取舍**：`TECHNICAL.md` / `CHANGELOG.md` **不移动**，保留在 `doc/` 根作稳定锚点——它们是全局引用最多者（AUDIT 报告、README、记忆多处），移动会使现有链接大面积失效且收益低。

## 四、实施步骤

| # | 步骤 | 动作 |
|---|---|---|
| 1 | **目录归位** | 移动 5 份报告类文件到 `doc/audit/`；修复 AUDIT 主报告 10 处相对链接 `../` → `../../`（AUDIT-SUMMARY 与主报告同目录，相对链接天然仍有效） |
| 2 | **导航门户** | 新建 `doc/README.md`：入口说明、「从哪读起」、生命周期×文档矩阵表、目录速览、文档维护纪律 |
| 3 | **设计原则** | 新建 `doc/design/PRINCIPLES.md`：吸收 CODE_WIKI §11（10 条，校正已废止的更新节流）+ 新增约定 5 条 + §13 主题配色，各条附当前代码锚点 |
| 4 | **测试矩阵** | 新建 `doc/test/TEST-MATRIX.md`：运行方式 + 覆盖统计 + 8 模块 P0-P2 用例矩阵 + 缺口建议 + TEST_AUDIT 历史结论 |
| 5 | **主文档交叉指引** | `doc/TECHNICAL.md` 头部加三处导航行；根 `README.md` 文档区重写为索引表 |
| 6 | **归档声明** | 5 份 archive 文档各插入「归档声明」blockquote，标注版本基线、精华去向、替代文档（正文不动） |

## 五、验证方式（纯文档任务，无代码变更，无需运行测试）

1. `git status` 确认移动/新增/修改文件符合预期
2. 校验所有相对链接与 `file:///` 路径指向存在（尤其 audit 报告 `../../`、导航门户、archive 声明 `../`）
3. 人工通读 `doc/README.md`：确认 6 阶段×文档矩阵无遗漏、每文档定位/读者/更新触发填全
4. 确认主文档 `TECHNICAL.md` / `CHANGELOG.md` 未被误改正文（`git diff` 仅见新增指引行；大 diff 为上一阶段审计修复累积，非本轮引入）
5. archive 5 份文档均有归档声明且原内容完整保留
6. 目录树符合目标结构

## 六、执行记录（已全部完成 ✅）

| 步骤 | 交付物 | 结果 |
|---|---|---|
| 1 目录归位 | `doc/audit/` 5 份 + 链接修复 | ✅ 目录树符合目标 |
| 2 导航门户 | `doc/README.md` | ✅ 链接校验无失效 |
| 3 设计原则 | `doc/design/PRINCIPLES.md` | ✅ 含 15 条原则 + 配色 |
| 4 测试矩阵 | `doc/test/TEST-MATRIX.md` | ✅ 8 模块 P0-P2 |
| 5 交叉指引 | TECHNICAL + README | ✅ 校验通过 |
| 6 归档声明 | archive ×5 | ✅ 正文完整保留 |
| 验证 | 目录树 / 链接 / 主文档 | ✅ 全通过 |

**验证明细**：
- 目标目录树与 `find doc` 结果一致
- audit 报告 `../../` 链接目标（7 处）全部存在
- `doc/README.md`、`TECHNICAL.md` 新链接经脚本校验无失效（仅 `[文本](../a.md)` 为展示示例，非链接）
- archive 5 份中 2 处历史正文旧链接（`./CHANGELOG.md`、`./README.md`）因重构失效，按「archive 冻结、不改正文」纪律保留，导航门户与归档声明已用正确 `../` 路径指向
- `git status` 与 `git diff` 核对：无代码文件被误改（既有 M 均为上一阶段审计修复累积）

**遗留说明**：全部变更未提交（沿用此前「先不提交」决定），待用户确认后入库。

---

*本计划为 Vibe Coding 可追溯性档案。执行过程与产出详见 [AUDIT-2026-09-03.md](./AUDIT-2026-09-03.md) 与导航门户 [doc/README.md](../README.md)。*
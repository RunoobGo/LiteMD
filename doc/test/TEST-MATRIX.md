# LiteMD 分级测试矩阵

> **测试体系单一入口**：运行方式、分级用例矩阵、覆盖统计全在此。整合自 `audit/AUDIT-2026-09-03.md` §3、`TECHNICAL.md` §7 与历史 `archive/TEST_AUDIT.md`。
> 版本基线：v0.2.9（2026-09-03）。**任何测试变更都要同步更新本文档**（见 `doc/README.md` 维护纪律）。

---

## 1. 运行方式

```bash
# Go 单测（含 race 检测）
# 前置：先构建一次前端（go:embed frontend/dist），否则报 files not found
cd frontend && npx vite build   # 或 npm run build
cd .. && go test ./... -race -count=1

# 前端单测（父/子进程隔离运行器，LITEMD_SUITE 选套件，LITEMD_TEST=all 全量）
cd frontend && npm test
cd frontend && LITEMD_TEST=latex npx tsx src/preview.test-bootstrap.ts

# E2E（真实 Chromium，需 agent-browser CLI；sprint4-11 为有效集）
cd e2e && ./sprint6.sh && ./sprint7.sh
```

## 2. 覆盖统计（2026-09-03，v0.2.9）

| 层 | 数量 | 备注 |
|---|---|---|
| Go 单测 | 69 Test 函数（4 包） | main / config / fileio / links；含关闭守卫、二实例通知、navguard、错误文案契约 |
| 前端单测 | 10 套件全绿 | preview(84) / user-css(64) / obsidian(45) / latex(55) / titlebar(21) / tabs(22) / link-handler(33) / toc(33) / md-escape(30) / mermaid(26) |
| E2E | sprint4~11 | sprint1/2/3/5 历史脚本失效未修 |

**核心业务逻辑覆盖率估计 >85%**（目标 >80%，达标）。

---

## 3. 分级定义

- **P0**：核心业务流程，不通过即阻塞发版
- **P1**：边界条件与异常处理
- **P2**：UI/UX 细节

覆盖标记：🟢 已有自动化覆盖（含依赖文件）｜🟡 部分覆盖需补强｜🔴 无覆盖需新增

## 4. 用例矩阵

### 模块 1：文件打开 / 保存管线（P0）

| 用例 | 级 | 状态 |
|---|---|---|
| OpenFile：正常 .md 读取，返回 abs/内容/mtime | P0 | 🟢 app_test.go |
| OpenFile：文本白名单（.exe 拒）+ 凭据黑名单（id_rsa/.env/.pem） | P0 | 🟢 links_test.go |
| ReadText：不存在 / 超 50MB / 无效 UTF-8 / 含 NUL / FIFO | P0 | 🟢 fileio_test.go |
| SaveFile：expectMtime 不符 → ErrExternalModified 不写入 | P0 | 🟢 app_test.go |
| SaveFile：expectMtime=0 强制覆盖 | P0 | 🟢（Go）+ 🟡 confirmOverwrite 无单测 |
| 原子写：临时文件→fsync→rename；沿用原权限 | P0 | 🟢 fileio_test.go |
| 保存期间继续输入不丢字（enqueueSave 串行） | P0 | 🟡 E2E 覆盖 |
| SaveFileAs：取消返回空；无扩展名补 .md | P1 | 🟢 app_test.go |

### 模块 2：标签管理（P0）

| 用例 | 级 | 状态 |
|---|---|---|
| newTab/openTab/activate/closeTab 生命周期与 dirty | P0 | 🟢 tabs.test.ts |
| 路径去重：重复打开同路径激活旧标签 | P0 | 🟢 tabs.test.ts |
| 空未保存标签被 openInCurrentIfEmpty 覆盖 | P0 | 🟡 main.ts 逻辑，E2E 覆盖 |
| 关闭最后一个标签自动新建空标签 | P0 | 🟢 tabs.test.ts（+硬约束） |
| 切标签光标/滚动位置记忆 | P1 | 🟡 E2E 部分 |
| 切标签清空 undo 栈 | P0 | 🟡 editor 行为无直接断言 |

### 模块 3：渲染管线（P0）

| 用例 | 级 | 状态 |
|---|---|---|
| XSS 五层防护（script/javascript:/onerror/iframe/onclick） | P0 | 🟢 preview.test.ts |
| Obsidian 双链/callout/frontmatter（含 CRLF、行号守恒） | P0 | 🟢 obsidian.test.ts |
| LaTeX 占位符防伪 + 代码块豁免 + ReDoS 守卫 | P0 | 🟢 latex.test.ts |
| 内嵌 CSS 作用域隔离（五类攻击面） | P0 | 🟢 user-css.test.ts |
| Mermaid：缓存/主题隔离/错误三分/超时/串行 | P0 | 🟢 mermaid.test.ts |
| 大文档分块缓存与整文输出等价 | P1 | 🟢 preview.test.ts |
| data URI 图片 MIME 白名单（拒 svg+xml） | P1 | 🟢 preview.test.ts |

### 模块 4：链接与本地资源（P0）

| 用例 | 级 | 状态 |
|---|---|---|
| classifyHref：external/mail/anchor/local/unsafe + 控制字符剥离 | P0 | 🟢 link-handler.test.ts |
| Resolve：file:// 剥离/解码/盘符/UNC/../折叠/嗅探 | P0 | 🟢 links_test.go |
| OpenExternal：scheme 白名单（拒 file://、javascript:） | P0 | 🟢 links_test.go |
| OpenWithSystem：可执行扩展黑名单 + 常规文件校验 | P0 | 🟢 links_test.go |
| ReadAssetDataURL：TOCTOU/10MB 上限/.svg 默认拒 | P0 | 🟢 links_test.go |
| navGuard 兜底：404→302，/wails/ 与非 GET 透传 | P0 | 🟢 navguard_test.go |

### 模块 5：未保存守卫（P0）

| 用例 | 级 | 状态 |
|---|---|---|
| dialog returnValue 残留清零（ESC 不误选） | P0 | 🟢 unsaved-guard |
| SetUnsavedCount 上报 + beforeClose 放行/否决/负数钳位 | P0 | 🟢 app_close_test.go |
| pendingNotify 并发补发（二实例不丢事件） | P0 | 🟢 app_notify_test.go |

### 模块 6：单实例与启动文件（P1）

| 用例 | 级 | 状态 |
|---|---|---|
| extractStartupFiles：旗标/相对路径/仅常规文件 | P1 | 🟢 startupfile_test.go |
| 队列并发 push/pop | P1 | 🟢 startupfile_test.go |
| macOS Finder 双击打开（OnFileOpen 未配置） | P1 | 🔴 已知限制，文档记录 |

### 模块 7：配置持久化（P1）

| 用例 | 级 | 状态 |
|---|---|---|
| 损坏 config.json 自愈（ErrCorrupted 降级 + Mutate 覆盖落盘） | P1 | 🟢 config_test.go |
| PushRecent 去重/上限 10/Mutate 事务化 | P1 | 🟢 config_test.go + app_test.go |

### 模块 8：UI/UX（P2）

| 用例 | 级 | 状态 |
|---|---|---|
| 标签栏/TOC/分屏把手键盘可达性 | P2 | 🟡 E2E sprint7/8 |
| 标题栏拖动/双击最大化/图标同步 | P2 | 🟢 titlebar.test.ts |
| 主题切换 / mermaid 主题跟随 | P2 | 🟢 mermaid.test.ts |
| toast 浮层 / navGuard 提示 | P2 | 🟡 E2E sprint9 |

---

## 5. 覆盖缺口与建议

1. **main.ts 编排层**（保存竞态、空标签覆盖、冲突确认流程）依赖 DOM + Wails binding，单测成本高，靠 E2E sprint 覆盖——无阻塞发版的空洞。
2. **e2e sprint1/2/3/5** 历史脚本失效（含已移除的更新检查 sprint5），为「有效集」口径困扰源：要么修复、要么删除（见 `TECHNICAL.md` §8.2 待办）。
3. **跨语言错误契约**：Go 三个 sentinel 文案由 `TestErrorTextContractForFrontend` 钉死，前端分支依赖它，见 `design/PRINCIPLES.md` #11。

---

## 6. 历史：TEST_AUDIT 风险结论（源自 archive/TEST_AUDIT.md §5）

> v0.2.0 测试体系审查的风险分级结论，**全部已修复**：P0 高风险 ✅、P1 中风险 9 项 ✅、原 P2/P3 全部跟进完成 ✅。当前矩阵是 v0.2.9 演化后的最新状态，以本文档为准。

---

*维护：新增/删除用例或变更覆盖状态时更新 S4 矩阵与 S2 统计，勿散落各处。*
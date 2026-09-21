# LiteMD 分级测试矩阵

> **测试体系单一入口**：运行方式、分级用例矩阵、覆盖统计全在此。整合自 `audit/AUDIT-2026-09-03.md` §3 + `audit/AUDIT-2026-09-03-R2.md` §三 + `TECHNICAL.md` §7 与历史 `archive/TEST_AUDIT.md`。
> 版本基线：tag `v0.2.12` + 工作区 Unreleased 批次（2026-09-21）。**任何测试变更都要同步更新本文档**（见 `doc/README.md` 维护纪律）。

***

## 1. 运行方式

```bash
# Go 单测（含 race 检测）
# 前置：先构建一次前端（go:embed frontend/dist），否则报 files not found
cd frontend && npx vite build   # 或 npm run build
cd .. && go test ./... -race -count=1

# 前端单测（父/子进程隔离运行器，LITEMD_SUITE 选套件，LITEMD_TEST=all 全量）
cd frontend && npm test
cd frontend && LITEMD_TEST=latex npx tsx src/preview.test-bootstrap.ts
# 单套件：LITEMD_SUITE=<name>（被 bootstrap 内部使用，外部走 LITEMD_TEST）

# E2E（真实 Chromium，需 agent-browser CLI；有效集 sprint4~11）
cd e2e && ./sprint6.sh && ./sprint7.sh
# 失败脚本：sprint1/2/3/5 已降级归档至 `e2e/SPRINT-LEGACY-README.md`
```

## 2. 覆盖统计（v0.2.12 + Unreleased 批次 · 2026-09-21）

| 层     | 数量              | 备注                                                                                                                                                                                                                                    |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go 单测 | 107 Test 函数（4 包） | main / config / fileio / links；含关闭守卫、二实例通知、navguard、错误文案契约（6 哨兵）、**错误码穿透 wrap**、**AllowSVG -race 并发**、**CopyImageAsset 5 用例**、**SaveFile expectMtime 3 用例**、**publicPath 6 用例**、**ResolveMalformedPath**；v0.2.11 新增 **DotDotBackstop**（safeWritePath `..` 兜底）与 **ObsidianNoExtStillAllowed**（敏感名单扩充不误伤无扩展名约定）；**审查 2026-09-18 新增 app\_bindings\_test.go 20 例**：binding 层 0 覆盖补齐（ResolveLocalPath / OpenExternal / OpenPath / ReadLocalAsset / 对话框 nil ctx）、**全 16 哨兵错误码契约**、**SaveFile+SaveFileAs 敏感目标拦截**、**OpenFile 软链绕过 CheckEditable** |
| 前端单测  | 17 套件全绿         | preview(116) / user-css(64) / obsidian(45) / latex(66) / titlebar(17) / tabs(43) / link-handler(23) / toc(30) / md-escape(22) / mermaid(26) / font-size(17) / **errcode(33)** / **file-ops(12)** / **sidebar(21)** / **splitpane(28)** / **unsaved-guard(16)** / **env(8)**（v0.2.11 新增：运行形态判定契约；2026-09-18 新增 unsaved-guard：quitDecision 决策表 + 对话框失效安全方向 + returnValue 清零；2026-09-21 补 requestQuit 放行序列） |
| E2E   | sprint1、sprint4\~11 | sprint1（v3 版，走 `__litemd__bindings`）v0.2.11 实测 15/15 恢复有效；sprint2/3/5 仍降级归档至 `e2e/SPRINT-LEGACY-README.md`（sprint10 的 mockfs 注入时序缺陷已修复，21/21） |

**核心业务逻辑覆盖率估计 >87%**（目标 >80%，达标；R2 修复后新增 errcode / file-ops / sidebar / splitpane + tabs.findByPath 把"主目录、IPC、UI 容器"模块全部覆盖）。

***

## 3. 分级定义

- **P0**：核心业务流程，不通过即阻塞发版

- **P1**：边界条件与异常处理

- **P2**：UI/UX 细节

覆盖标记：🟢 已有自动化覆盖（含依赖文件）｜🟡 部分覆盖需补强｜🔴 无覆盖需新增

## 4. 用例矩阵

### 模块 1：文件打开 / 保存管线（P0）

| 用例                                                | 级  | 状态                                                     |
| ------------------------------------------------- | -- | ------------------------------------------------------ |
| OpenFile：正常 .md 读取，返回 abs/内容/mtime                | P0 | 🟢 app\_test.go                                        |
| OpenFile：文本白名单（.exe 拒）+ 凭据黑名单（id\_rsa/.env/.pem）  | P0 | 🟢 links\_test.go                                      |
| ReadText：不存在 / 超 50MB / 无效 UTF-8 / 含 NUL / FIFO   | P0 | 🟢 fileio\_test.go                                     |
| **ReadText 错误文案只露 basename（R2-G1）**               | P1 | 🟢 publicPath 5 例 + basename-only 1 例                  |
| SaveFile：expectMtime 不符 → ErrExternalModified 不写入 | P0 | 🟢 app\_test.go + **app\_save\_conflict\_test.go 3 例** |
| SaveFile：expectMtime=0 强制覆盖                       | P0 | 🟢（Go）+ 🟡 confirmOverwrite 无单测                        |
| SaveFile stat 失败（非 IsNotExist）返 wrap err          | P1 | 🟢 app\_test.go                                        |
| 原子写：临时文件→fsync→rename；沿用原权限                       | P0 | 🟢 fileio\_test.go                                     |
| 保存期间继续输入不丢字（enqueueSave 串行）                       | P0 | 🟡 E2E 覆盖                                              |
| SaveFileAs：取消返回空；无扩展名补 .md                        | P1 | 🟢 app\_test.go                                        |
| **SaveFile / SaveFileAs 拒绝敏感目标（写入侧与读取侧同口径）**      | P0 | 🟢 **app\_bindings\_test.go** TestSaveFile\_RejectsSecretTarget + TestSaveFile\_AllowsNormalMarkdown |
| **OpenFile 软链绕过 CheckEditable（真实目标二次判定）**          | P0 | 🟢 **app\_bindings\_test.go** TestOpenFile\_RejectsSymlinkToSecret + TestOpenFile\_AllowsSymlinkToMarkdown |
| **CopyImageAsset 受限资产写入（R2-G7）**                  | P0 | 🟢 **app\_asset\_test.go 5 例**                         |
| **CopyImageAsset 锚点 baseFile 须为可编辑文本文件**            | P0 | 🟢 **app\_bindings\_test.go** TestCopyImageAsset\_RejectsNonEditableBase |

### 模块 2：标签管理（P0）

| 用例                                           | 级  | 状态                    |
| -------------------------------------------- | -- | --------------------- |
| newTab/openTab/activate/closeTab 生命周期与 dirty | P0 | 🟢 tabs.test.ts       |
| 路径去重：重复打开同路径激活旧标签                            | P0 | 🟢 tabs.test.ts       |
| 空未保存标签被 openInCurrentIfEmpty 覆盖              | P0 | 🟡 main.ts 逻辑，E2E 覆盖  |
| 关闭最后一个标签自动新建空标签                              | P0 | 🟢 tabs.test.ts（+硬约束） |
| 切标签光标/滚动位置记忆                                 | P1 | 🟡 E2E 部分             |
| 切标签清空 undo 栈                                 | P0 | 🟡 editor 行为无直接断言     |
| **findByPath 按 path 反查（R2-F17）**             | P1 | 🟢 tabs.test.ts 7 例   |

### 模块 3：渲染管线（P0）

| 用例                                                  | 级  | 状态                                |
| --------------------------------------------------- | -- | --------------------------------- |
| XSS 五层防护（script/javascript:/onerror/iframe/onclick） | P0 | 🟢 preview\.test.ts               |
| Obsidian 双链/callout/frontmatter（含 CRLF、行号守恒）        | P0 | 🟢 obsidian.test.ts               |
| LaTeX 占位符防伪 + 代码块豁免 + ReDoS 守卫                      | P0 | 🟢 latex.test.ts                  |
| 内嵌 CSS 作用域隔离（五类攻击面）                                 | P0 | 🟢 user-css.test.ts               |
| Mermaid：缓存/主题隔离/错误三分/超时/串行                          | P0 | 🟢 mermaid.test.ts                |
| **Mermaid SVG DOMPurify 二道防线（R2-F3）**               | P1 | 🟢 preview\.ts:applyMermaidResult |
| 大文档分块缓存与整文输出等价                                      | P1 | 🟢 preview\.test.ts               |
| data URI 图片 MIME 白名单（拒 svg+xml）                     | P1 | 🟢 preview\.test.ts               |

### 模块 4：链接与本地资源（P0）

| 用例                                                      | 级  | 状态                                                    |
| ------------------------------------------------------- | -- | ----------------------------------------------------- |
| classifyHref：external/mail/anchor/local/unsafe + 控制字符剥离 | P0 | 🟢 link-handler.test.ts                               |
| Resolve：file:// 剥离/解码/盘符/UNC/../折叠/嗅探                   | P0 | 🟢 links\_test.go                                     |
| **Resolve 百分号编码损坏返 ErrMalformedPath（R2-G6）**            | P1 | 🟢 TestResolveMalformedPath                           |
| OpenExternal：scheme 白名单（拒 file://、javascript:）          | P0 | 🟢 links\_test.go                                     |
| OpenWithSystem：可执行扩展黑名单 + 常规文件校验                        | P0 | 🟢 links\_test.go                                     |
| ReadAssetDataURL：TOCTOU/10MB 上限/.svg 默认拒 + **-race 并发** | P0 | 🟢 links\_test.go + TestAllowSVG\_ConcurrentReadWrite |
| navGuard 兜底：404→302，/wails/ 与非 GET 透传                   | P0 | 🟢 navguard\_test.go                                  |

### 模块 5：未保存守卫（P0）

| 用例                                          | 级  | 状态                      |
| ------------------------------------------- | -- | ----------------------- |
| dialog returnValue 残留清零（ESC 不误选）            | P0 | 🟢 **unsaved-guard.test.ts 16 例** |
| **requestQuit 放行序列（计数清零先于 Quit，防双原生框；取消不动作；清零失败兜底）** | P1 | 🟢 **unsaved-guard.test.ts**（2026-09-21） |
| **对话框缺失时的失效安全方向（cancel / 不覆盖 / 不退出）**  | P0 | 🟢 **unsaved-guard.test.ts**（askUnsaved 曾缺判空，模板改坏即抛 TypeError） |
| **quitDecision 决策表（无脏放行 / 有脏仅显式退出放行）**    | P0 | 🟢 **unsaved-guard.test.ts** |
| SetUnsavedCount 上报 + beforeClose 放行/否决/负数钳位 | P0 | 🟢 app\_close\_test.go  |
| pendingNotify 并发补发（二实例不丢事件）                 | P0 | 🟢 app\_notify\_test.go |

### 模块 6：单实例与启动文件（P1）

| 用例                                                            | 级  | 状态                                                              |
| ------------------------------------------------------------- | -- | --------------------------------------------------------------- |
| extractStartupFiles：旗标/相对路径/仅常规文件 + **Markdown 扩展白名单（R2-G3）** | P1 | 🟢 startupfile\_test.go + app\_test.go                          |
| 队列并发 push/pop                                                 | P1 | 🟢 startupfile\_test.go                                         |
| macOS Finder 双击打开（OnFileOpen）                                 | P1 | 🟢 app\_test.go:TestOnFileOpen\_PushAndNotify（**真实 .exe 落盘测试**） |

### 模块 7：配置持久化（P1）

| 用例                                                    | 级  | 状态                                |
| ----------------------------------------------------- | -- | --------------------------------- |
| 损坏 config.json 自愈（ErrCorrupted 降级 + Mutate 覆盖落盘）      | P1 | 🟢 config\_test.go                |
| PushRecent 去重/上限 10（**MaxRecentFiles 常量**）/Mutate 事务化 | P1 | 🟢 config\_test.go + app\_test.go |

### 模块 8：跨语言错误契约（P1，R2 强化）

| 用例                                                           | 级  | 状态                                                                                                     |
| ------------------------------------------------------------ | -- | ------------------------------------------------------------------------------------------------------ |
| **错误码体系 R2-F1：所有 binding error** **`[code] message`** **形态** | P1 | 🟢 TestErrorTextContractForFrontend 6 哨兵 + TestErrorCodeOf\_Wrapped wrap 穿透 + **errcode.test.ts 33 例** |
| 错误码常量与 Go 端 const 对齐                                         | P1 | 🟢 errcode.test.ts EC 与 fileio/links/main Code 一一对应                                                    |
| **全哨兵 `[code]` 前缀 + CodeOf 可解出（防新增哨兵漏加码）**                | P1 | 🟢 **app\_bindings\_test.go** TestErrorCodeContract\_AllSentinels（16 哨兵逐一定码）                            |
| **AppInfo.Version === AppVersion（版本事实源不漂移）**                  | P1 | 🟢 **app\_bindings\_test.go** TestAppInfo\_VersionMatchesConst                                            |

### 模块 9：UI/UX（P2）

| 用例                                            | 级  | 状态                            |
| --------------------------------------------- | -- | ----------------------------- |
| 标签栏/TOC/分屏把手键盘可达性                             | P2 | 🟡 E2E sprint7/8              |
| 标题栏拖动/双击最大化/图标同步                              | P2 | 🟢 titlebar.test.ts           |
| **scheduleSync 代际序号防 stale（R2-F4）**           | P2 | 🟢 titlebar.ts:syncGen        |
| 主题切换 / mermaid 主题跟随                           | P2 | 🟢 mermaid.test.ts            |
| **主题首启读 prefers-color-scheme（R2-F12）**        | P2 | 🟢 main.ts:initialThemeBase   |
| toast 浮层 / navGuard 提示                        | P2 | 🟡 E2E sprint9                |
| **Sidebar 拖拽宽度 + 持久化（R2 测试补强）**               | P2 | 🟢 **sidebar.test.ts 21 例**   |
| **SplitPane 键盘 ←/→/Home/End + 双击复位（R2 测试补强）** | P2 | 🟢 **splitpane.test.ts 28 例** |
| **file-ops bind fallback chain（R2 测试补强）**     | P2 | 🟢 **file-ops.test.ts 7 例**   |

***

## 5. 覆盖缺口与建议

1. **main.ts 编排层**（保存竞态、空标签覆盖、冲突确认流程）依赖 DOM + Wails binding，单测成本高，靠 E2E sprint 覆盖——无阻塞发版的空洞。
2. **e2e sprint12** 把 sprint1/2/3/5 的失效断言迁到 `__litemd__bindings` 注入体系（[ROADMAP R9](../design/ROADMAP-2026-09-03.md)）；非紧急。
3. **跨语言错误契约 R2-F1**：Go 15 个 sentinel 由 `TestErrorTextContractForFrontend` + `TestErrorCodeOf_Wrapped` 双向钉死，前端 `errcode.ts` 解析后 `errCode(e) === EC.xxx` 切精确分支；契约详情见 [PRINCIPLES.md #16](../design/PRINCIPLES.md)。
4. **editor undo 隔离 / preview renderGen 旧结果丢弃**：依赖 CodeMirror 完整 setup，单测成本高，靠 E2E + 代码 review 覆盖。

***

## 6. 历史：TEST\_AUDIT 风险结论（源自 archive/TEST\_AUDIT.md §5）

> v0.2.0 测试体系审查的风险分级结论，**全部已修复**：P0 高风险 ✅、P1 中风险 9 项 ✅、原 P2/P3 全部跟进完成 ✅。当前矩阵是 v0.2.9 演化后的最新状态，以本文档为准。

***

*维护：新增/删除用例或变更覆盖状态时更新 S4 矩阵与 S2 统计，勿散落各处。*

# LiteMD Changelog

LiteMD 版本变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 约定，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

***

## \[0.2.11] — 2026-09-04

基于外部代码审查报告（🔴 R1 / 🟡 Y1-Y3 / 🟢 G1-G5，下称 REV-09-04）与其前期文档核对结论的 patch 收口。核对确认 R1 为 v0.2.x 历史修复的不彻底复发、Y1 与 P0-2 契约同向，同时发现并修复了 R2-F7 修复引入的 E2E 回归。

### 🐛 修复

- **预览链接 URL 白名单剥除中文文件名 / Windows 盘符（REV-09-04 R1，v0.2.x 历史问题复发）**：
  `preview.ts` 的 `ALLOWED_URI_REGEXP` 在 v0.2.x 修复"相对路径链接不可点击"时
  只补了 `./`、`../` 与 `[a-zA-Z0-9._-]` 开头三条分支——最后一条仅认 ASCII 开头，
  中文文件名（marked 输出为 `%E6%96%87…`，`%` 不在首字符类）与盘符路径
  （`C:/notes/a.md` 的冒号被当成 scheme）仍被剥成 `href=null`，`<a>` 渲染出来
  却点不动。现改为"白名单协议 + 本地路径"两段判定：协议分支不变；
  盘符单独前置分支；其余路径用负向前瞻排除 `scheme:` 形态
  （`javascript:` / `vbscript:` / `file:` / `blob:` / 非图片 `data:` 一律照旧拒绝）
  后放行。`preview.test.ts` 新增 15 例回归（中文 / 盘符 / 各类危险 scheme 大小写绕过）。

- **调试句柄 DEV 守门导致 E2E 全线失效（R2-F7 回归修复）**：R2-F7 用
  `import.meta.env.DEV` 守门 `window.__litemd__bindings`，但全部 E2E sprint 跑在
  `vite preview --port 5174` 服务的**生产构建产物**上（`DEV` 被静态替换为 `!1`），
  dev.html 与 index.html 共用同一份 bundle，换入口页并不能让 `DEV` 变回 true——
  `sprint1.sh` Phase 4 的 `bindings.SaveFile` 硬断言在生产产物下必然失败。
  0.2.10 段"（注意：E2E 走 dev-bootstrap + dev.html 路径，绑定仍可用。）"
  的声明**不成立**，已勘误。现统一改为按"是否存在 Wails 运行时"判定
  （新增 `frontend/src/env.ts`：`isWailsRuntime` / `exposeDebugHandles`，
  与 main.ts 既有的 `window.runtime` 判据同一口径）：真实桌面端不注入，
  浏览器 / E2E（含生产产物）注入。`main.ts` 的 7 个调试句柄同口径收口
  （REV-09-04 G3）。新增 `env.test.ts` 8 用例锁定判定契约。

- **`safeWritePath` 补上注释承诺的 `..` 兜底检查（REV-09-04 G1）**：
  `internal/fileio/safepath.go` 原注释称"拒绝 `..` 残余（这里兜底）"但代码里
  没有该检查，注释误导维护者以为存在第二道闸。现按分隔符切段精确比对补上
  （`strings.Contains("..")` 会误伤"笔记..备份.md"这类合法名，故按段比对）；
  Unix 上反斜杠不是分隔符、Clean 折叠不掉的形态由此闸拦住。
  新增 `TestSafeWritePath_DotDotBackstop`（含不误伤用例）。

- **E2E 脚本自身缺陷修复**：
  - `sprint1.sh`：eval 对字符串返回值带引号（`"Y"`），`grep -oE '^[NY]$'`
    永不匹配；`grep -oE 'true\|false'` 在 ERE 下 `\|` 是字面管道符，
    对话框断言永不匹配（两个 bug 叠加，曾把真实正常的对话框行为误报为失败）；
    截图路径从写死 `/workspace/LiteMD/…` 改为脚本所在目录，仓库 checkout
    在任意位置均可存档。
  - `sprint10.sh`：原脚本在打开应用之前就执行 `mockfs.setFile`——浏览器无页面
    或页面未加载完时 eval 抛错且被 `>/dev/null` 静默吞掉，文档没写进去，
    后续依赖文档元素的断言连锁失败，并把 fallback 读到的应用自身主题渐变
    误报为"🔴 外发背景图生效"（假阳性安全告警）。现先 open 并轮询
    `window.__litemd__mockfs` 就绪后再注入。

### 🛡 健壮性

- **标签去重 / path 反查改用比较键归一（REV-09-04 Y2）**：`tabs.ts` 的
  `t.path === path` 是大小写与分隔符敏感的字符串比较——在 macOS / Windows
  （大小写不敏感卷）上，`/notes/TODO.md` 与 `/notes/todo.md` 会被开成两个标签，
  保存时互相覆盖。新增 `pathCompareKey()`（反斜杠统一、百分号解码、连续斜杠
  折叠、大小写不敏感卷上转小写），`openTab` 去重与 `findByPath` 反查统一改走
  比较键；**tab.path 保持磁盘真实大小写原样，展示不受影响**；Linux（大小写
  敏感卷）不转小写，避免误合并两个真实存在的不同文件。`tabs.test.ts` 新增
  12 例覆盖双平台分支。

- **`secretNames` 敏感名单扩充 + `.env` 前缀判定（REV-09-04 Y3）**：
  原"想到一个加一个"的名单遗漏面随时间累积。新增 SSH FIDO 私钥
  （`id_ecdsa_sk` / `id_ed25519_sk`）、git / 容器 / 语言生态凭据
  （`.git-credentials` / `.dockercfg` / `credentials` / `.yarnrc` / `.pypirc`）、
  各类交互历史（`.fish_history` / `.psql_history` / `.mysql_history` /
  `.python_history`）；变体极多的 `.env.*`（.env.development / .env.production /
  …）改由 `secretNamePrefixes` 按前缀判定，不再逐个穷举（误拒
  `.environment` 类名字的成本远低于漏放一个 `.env.production`）。
  **"无扩展名放行"的 Obsidian 约定不变**（与 Resolve / looksLikeText 同一口径），
  新增 `TestCheckEditable_ObsidianNoExtStillAllowed` 反向守卫防误伤。

- **渲染缓存 key 改内容摘要（REV-09-04 G2）**：`preview.ts` 的 `renderCache`
  原以整篇 md 为 key，50MB 文档 × 8 条 LRU 光 key 就要 ~800MB 常驻。改用
  长度 + 双 FNV-1a 摘要（~64 位），key 开销 O(文档大小) → O(1)；单哈希的
  碰撞后果是"渲染出另一篇文档的内容"，故用双哈希 + 长度三重区分。

- **复选框占位 class 加随机盐（REV-09-04 G4）**：原固定串 `litemd-cb` 可被
  用户裸 HTML 伪造（`<span class="litemd-cb">` 会被还原阶段替换成复选框，
  仅视觉异常、无安全影响）。占位 class 改为带随机盐的不可预测形态，
  与 KaTeX 占位符（latex.ts）的防伪思路一致；还原正则按盐预编译一次，
  不影响分块渲染高频路径。

- **`SaveFile` TOCTOU 残余窗口显式记录（REV-09-04 G5）**：P0-5 的 mtime
  冲突检测在 stat 与 rename 之间仍有理论窗口，完全闭合需文件锁 / CAS 写入，
  对单人手动保存场景成本收益不成比例。维持现状，已在 `app.go` 注释中记录
  决策，避免后续审计重复提出。

### 🧹 清理

- **`persistImageAsset` / `ImageDropResult` 死代码删除（REV-09-04 Y1）**：
  `obsidian.ts` 的该函数以 `copyFn("assets/xxx", b64)` 形态调用写入接口，
  带目录分隔符的路径与 P0-2 收敛后 Go 端 `AssetWritePath` 的"纯文件名"校验
  直接冲突，调用必然被拒；真实图片落盘由 `main.ts` 的 onImageDrop →
  `CopyImageAsset` + `buildImageMarkdown` 承担。属 P0-2 后的遗留死代码，
  全仓库（含 E2E）零引用，安全删除。

### 🧪 测试

- 新增 `frontend/src/env.test.ts`（第 16 个套件）：运行形态判定 8 用例。
- `preview.test.ts` +15 例（R1 URI 白名单、G2 缓存摘要、G4 占位防伪）。
- `tabs.test.ts` +12 例（Y2 双平台比较键）。
- `internal/links`：`TestCheckEditable` deny 列表扩至新名单；
  新增 `TestCheckEditable_ObsidianNoExtStillAllowed`。
- `internal/fileio`：新增 `TestSafeWritePath_DotDotBackstop`。
- E2E 实测：`sprint1.sh` 15/15、`sprint10.sh` 21/21（vite preview 生产产物 + agent-browser）。
- 全量：`go vet` 干净、`go test ./... -race` 4 包全过、前端 16/16 套件
  （tsc + vite build 通过）。

### 📚 文档

- `TECHNICAL.md` §3.1 的 `ALLOWED_URI_REGEXP` 描述对齐实现（补盘符分支与
  "scheme 形态负向前瞻"说明）。
- 勘误 0.2.10 段 `window.__litemd__bindings` 条目中"绑定仍可用"的失实声明
  （详见上文修复条目）。

***

## \[0.2.10] — 2026-09-03

基于 [AUDIT-2026-09-03-R2.md](./audit/AUDIT-2026-09-03-R2.md) 的 patch 收口。第二轮全景审计 + 文档对齐 + 测试补强，全项目落地 0 P0 / 20 P1 / 18 P2 / 6 个新测试套件 + 12 个 Go 新测试函数。

### 🐛 修复

- **错误文案哨兵化**：`app.go` 提 `ErrEmptyPath` / `ErrAppNotReady` /
  `ErrEmptyImageData` 三个 package-level 哨兵（散落 6 处的 `errors.New(...)`）；
  `TestErrorTextContractForFrontend` 钉死字符串，配套 `errors.Is` 双保险，
  渐进切到错误码体系（F1）做铺垫。

- **`SaveFile`** **stat 错误不再静默 fallthrough**：`expectMtime` 路径下
  `os.Stat` 失败（除 `IsNotExist`）原实现被静默写盘，权限/IO 错误场景
  数据无提示丢失。改为返回 wrap 后的 statErr。

- **`extractStartupFiles`** **加 Markdown 扩展白名单**：原先只过存在 + 常规
  文件，Finder 右键"打开方式 → LiteMD" 选 .exe 会被入队再被 OpenFile 拒
  （无效事件 + 路径出现在前端）。现复用 `links.CheckEditable` 与 OpenFile
  同一口径过滤。`TestOnFileOpen_PushAndNotify` 改写为真实 .exe 落盘测试。

- **`HUGE_LENGTH_RE`** **正则去重**：`latex.ts` 中 `cm` 出现两次（拷贝残留），删。

- **`mocks.ts`** **自替自身死代码删除**：原 `s.replace(/\/\.\.\//g, "/../")`
  regex 与 replacement 形态相同，且后续 Clean 重复处理。

- **空** **`shutdown`** **钩子解挂**：`app.shutdown` 钩子体为空，main.go 摘除
  `OnShutdown` 注册；需要资源释放/统计上报时再启用。

### 🛡 健壮性

- **`AllowSVG`** **改** **`atomic.Bool`**：`links/asset.go` 原裸 `var AllowSVG = false`
  全局可写无锁，未来"用户偏好驱动开关"或测试并发写会触发 -race。改为
  `atomic.Bool` + `SetAllowSVG` / `AllowSVG()` 接缝，新增
  `TestAllowSVG_ConcurrentReadWrite`（4 写 8 读 × 200 轮）守护。

- **mermaid SVG 二道 DOMPurify 防线**：`preview.ts:applyMermaidResult` 注入
  前再过 `DOMPurify.sanitize(svg, { USE_PROFILES: { svg, svgFilters } })`，
  即便 mermaid 11 `securityLevel:"strict"` 未来回归破防，也只能写出纯 SVG 节点。

- **错误码体系 F1 落地**：Go 侧所有 binding error 在文案前挂 `[code]` 前缀
  （fileio / links / app 三包共 15 个 Code 常量 + 哨兵），新增
  `CodeOf(err)` 辅助穿透 wrap 链；前端新增 `errcode.ts`（`errCode` /
  `hasCode` / `EC` 常量），`main.ts` 6 处 `e.message.includes("...")` 子串
  匹配全部切到 `errCode(e) === EC.xxx` 精确分支。Go 端
  `TestErrorTextContractForFrontend` 扩钉 code + `TestErrorCodeOf_Wrapped`
  守护 wrap 穿透；前端新增 `errcode.test.ts` 33 用例覆盖正则边界 + 常量对齐。

### ⚡ 性能

- **`formulaCache`** **改 LRU**：`latex.ts` 原实现容量 500 满时 `clear()` 整清，
  下一次 render 整文档所有公式一次性重算（thundering herd）。改为删最老
  key 保留命中，命中率不再被一次性清空打断（与 preview\.ts / mermaid.ts 一致）。

### 🎨 主题

- **LaTeX** **`errorColor`** **走 CSS 变量**：从硬编码 `#e06c75`（oneDark 暗红，
  亮主题对比度差）改为读 `--md-error`，缺变量时回退 oneDark 红色。

### 🧹 清理

- **`window.__litemd__bindings`** **仅 DEV 暴露**：`file-ops.ts` 原所有模式都
  注入到 window（含生产构建），与上方注释"real binding 总是被打包"相矛盾。
  守 `import.meta.env.DEV` 后仅 dev/E2E 暴露，生产构建不泄漏。
  （注意：E2E 走 dev-bootstrap + dev.html 路径，绑定仍可用。
  —— **勘误（0.2.11）**：该声明不成立。E2E 跑在 vite preview 的生产产物上，
  `DEV` 恒为 false，dev.html 与 index.html 共用同一 bundle，调试句柄在 E2E
  中实际已全部失效（sprint1 Phase 4 硬断言必挂）。0.2.11 已改为按
  "是否存在 Wails 运行时"判定，详见 [0.2.11] 修复段。）

### 🧪 测试

- **新增** **`app_asset_test.go`**：CopyImageAsset 5 用例覆盖 happy / 路径穿越
  / 坏 base64 / 超 20MB / 空数据（审计 R2-G7，0 测试覆盖 → 5 用例）。

- **新增** **`app_save_conflict_test.go`**：SaveFile expectMtime 3 用例覆盖
  冲突拒绝 + 匹配写入 + 强制覆盖（审计 R2-G8，P0-5 关键守护无测试）。

- **新增** **`TestAllowSVG_ConcurrentReadWrite`**：原子切换 + 并发读
  -race 守护（审计 R2-G2）。

- **新增** **`TestErrorCodeOf_Wrapped`**：错误码穿透 wrap 链，SaveFile 实
  际 `fmt.Errorf("%w: %s (disk %d, expected %d)", ...)` 形态能正确反解
  code（审计 R2-F1）。

- **新增** **`errcode.test.ts`（33 用例）**：前端错误码解析契约：正则边界
  / 非 Error 处理 / EC 常量与 Go 端对齐 / EC ↔ errCode 联动。

- **`TestErrorTextContractForFrontend`** **扩 3 → 6 用例**：加 3 个新哨兵文案钉死 + 6 个 code 字段钉死。

- **`TestOnFileOpen_PushAndNotify`** **改写**：真实 .exe 落盘后再断言拒收
  （原 fixture 不落盘让测试"恒过"，审计 R2-G3）。

### 📝 文档

- 校正 3 处"macOS OnFileOpen 未配置"陈旧描述（TECHNICAL §5.3 / TEST-MATRIX §4 /
  AUDIT-R1 §三）→ "已实装" + commit 引用。

- 修正 README 特性行"`.md` 文件关联" → 5 扩展（md/markdown/mdown/mkd/mkdn）。

- 修正 README 快捷键"Ctrl+Shift+F 查找替换" → "Ctrl+H"（CodeMirror `searchKeymap` 默认）。

- CHANGELOG [0.2.0](https://github.com/litemd/litemd/releases/tag/v0.2.0) 历史条目加注脚（"命令面板 / Vim·Emacs keymap" 实际未实装）。

- TECHNICAL §7.2 / TEST-MATRIX §2 测试统计对齐：11 套件 + 各套件数与 E2E sprint4-11。

- 新增 `doc/audit/AUDIT-2026-09-03-R2.md`（第二轮全景审计报告）。

### 验证

- `go test ./... -race -count=1` 4 包全绿（含新 9 测试函数 + 改造 2 测试）

- `LITEMD_TEST=all npx tsx src/preview.test-bootstrap.ts` 11/11 套件全绿

- `npx tsc --noEmit` 无错

- `npx vite build` 主 chunk 仍 61KB / gzip 22KB（拆包未退化）

> R1 批次（R1-R8 路线图落地）已并入 \[0.2.9] 段；本段为 R2 批次
> （[AUDIT-2026-09-03-R2.md](./audit/AUDIT-2026-09-03-R2.md) 落地项）。

### 上一轮（\[0.2.9] 已包含）

- macOS Finder 双击打开（OnFileOpen）/ `.mkdn` 扩展名关联 / 字号可调持久化

- LaTeX 逃逸 maxSize 闸门 / 死代码清理 / main bundle 拆包 / CI 接入

- DOMPurify 3.4.13 → 3.4.14 / E2E 失效脚本降级

- CHANGELOG 0.2.9 段补记 P0-2/P0-5/P1-6/P1-8/P1-10/P1-12 / TECHNICAL 对齐 v0.2.9

***

## \[0.2.9] — 2026-09-03

基于代码审查（`doc/CODE-REVIEW-2026-09-02.html`）的 patch 收口。
全景审计报告见 `doc/AUDIT-2026-09-03.md`（含本段补记说明）。

### 🔒 安全

- **打开链路加固**：`OpenWithSystem` 增加 `IsRegular()` 校验与可执行扩展名黑名单
  （bat/exe/lnk/sh）；`ReadAssetDataURL` 改用 `statExistingFile` 消除 TOCTOU、
  补 `LimitReader` 兜底、`.svg` 默认关闭（需 `AllowSVG` 显式开启）。

- **文件读取**：`ReadText` 增加 NUL 字节检测；`OpenFile` 增加文本类型白名单 +
  凭据黑名单（`id_rsa` / `.env` / `.pem`）。

- **链接分类**：`classifyHref` 判定协议前剥离控制字符
  （U+0000–U+001F / U+007F–U+009F），防控制字符绕过。

- **图片资产写入收敛（审查 P0-2，本段补记）**：`CopyImageAsset` 旧签名
  `(targetPath, base64Data)` 允许前端指定任意绝对路径，等价「任意文件写入
  原语」；改为 `(baseFile, assetName, base64Data)`，写入位置由后端从文档
  目录推导（`<文档目录>/assets/`），assetName 校验纯文件名 + 图片扩展名
  白名单 + 128 字符上限，解码内容限 20MB。新增 `internal/fileio/asset.go`。

- **保存冲突检测与串行化（审查 P0-5/P1-10，本段补记）**：`SaveFile` 增加
  `expectMtime` 参数，mtime 不符返回 `ErrExternalModified` 拒绝写入（旧版
  静默覆盖外部修改）；前端 per-tab `enqueueSave` 串行链消除「旧内容覆盖新
  内容」竞态，保存后以 Go 返回的真实 mtime 记账（旧版用 `Date.now()` 伪造）。

- **二实例通知并发修复（审查 P1-8，本段补记）**：`pendingNotify` 与 `ctx`
  收进同一把 `ctxMu` 写锁，消除「读 ctx 为 nil 后被 startup 插队、标记再无
  补发时机」的丢通知窗口（回归测试 `app_notify_test.go`）。

### 🐛 修复

- **callout 行号漂移**：callout 体内含 `[[wiki]]` 时保留 `m[1]` 前缀，使
  `rawLines == prepLines`、行号记账守恒（审查 P1-2）。

- **OS 级关闭守卫**：新增 `SetUnsavedCount` 绑定，`OnBeforeClose` 检查未保存计数
  弹原生确认框（审查 P1-11）。

- **mermaid 失败原因三分（审查 P0-1/P1-6，本段补记）**：渲染结果由
  `string|null` 改为 `{ok,svg}|{ok:false,reason:"empty"|"load"|"syntax"|"timeout"}`；
  病态输入卡死 render 走超时接缝（`setRenderTimeout`），并发请求经
  `enqueueRender` 串行化（峰值 in-flight = 1）。

- **编辑器搜索与 undo 隔离（本段补记）**：补装 CodeMirror `search()` 扩展
  （此前 searchKeymap 缺依赖 field，Ctrl+F 是空操作）；切标签时经
  `historyCompartment` 换新 history 实例清空 undo 栈，杜绝「切到 B 后
  Ctrl+Z 把 A 的变更逆放回 B」的跨文件数据污染。

- **图片插入竞态（审查 P1-10，本段补记）**：await 期间用户切走标签时，
  图片 markdown 插回原标签（必要时重新激活）；目标标签已关闭则明确提示
  而非静默丢失。

### ⚡ 性能

- **大文档增量渲染**：按顶层 token 分块走完整安全管线并缓存
  （`BLOCK_CACHE_MAX=4096`），共享单个 `DOMParser` 实例，防抖按文档大小分档
  （审查 P1-3）。

- **共享 DOMParser**（本段补记）：`hardenLinks` 等环节复用单个 `DOMParser`
  （jsdom 下每次 new 会随调用次数二次劣化），无 `<a>` 块跳过 DOM 解析；
  latex 占位符盐改为会话级，含公式文档的分块缓存得以命中。

### 🧰 工程（本段补记）

- **测试套件隔离运行器**：`preview.test-bootstrap.ts` 改父/子进程模型
  （`LITEMD_SUITE`），10 套件真实并发隔离运行；补 `npm test` 入口。

- **构建脚本版本语义拆分（审查 P1-12）**：`SKIP_BUMP=1`（完全不动）/
  `VERSION=x.y.z`（回写六处事实源）/ 无参（自增 patch）三种语义独立处理，
  矛盾组合给出明确警告；版本事实源从 5 处扩到 6 处（新增 README 下载名）。

- **三个恒过/撞名测试修复**：`TestAppSaveFileAs_NilCtxSafe` 改三段契约
  断言；`TestAppPushRecent_Limit10` 路径构造改 `fmt.Sprintf`；fileio 测试
  `/tmp` 硬编码改 `t.TempDir()`。

### ⚠️ 勘误

- **自动更新模块移除**：v0.2.0 曾记录「自动更新检查（GitHub Releases API）」，
  该功能已于 2026-08-31（e64af52，早于 0.2.4 发版）随构建目录重组整体移除，
  此前各版本均未记录。当前版本无自动更新能力，README 与代码一致。

## \[0.2.8] — 2026-09-01

新增 **Mermaid 图表渲染**（评估报告 P1）：动态 import 启动≈0、图级缓存 +30MB
内存 0ms 命中、竞态防护、securityLevel strict。前端全量 376 断言 0 失败。

### ✨ 新增

- **`<code class="language-mermaid">`** **代码块自动渲染**：在 render() 阶段
  把 `<pre><code.language-mermaid>` 替换为 `.mermaid-block` 容器，异步水合
  成 SVG；不进入 `.code-block` 装饰（图表不是代码，无复制按钮）。

- **图级缓存（LRU 64）**：缓存键 `theme + \0 + code`，同图同主题毫秒级命中。

- **主题跟随**：`applyTheme` 末尾触发 `preview.onThemeChange(theme)`，已渲染图
  按新主题重新水合；不同主题缓存各自保留。

- **加载/语法错误降级**：`is-error` 容器保留原文 + 错误文案，便于校对修改。

- **测试接缝** **`setMermaidLoader`**：node/jsdom 注入 fake 模块测缓存/隔离/
  失败/loader 异常；浏览器/E2E 走真实 dynamic import。

### 🔒 安全（mermaid 11）

- `securityLevel: 'strict'`：禁用 click 回调与危险 HTML，href 协议白名单。

- `startOnLoad: false`：杜绝 mermaid 自动扫文档渲染。

- mermaid 输出的 SVG 直接 `innerHTML` 注入，依赖 strict 净化；后续若需
  进一步收紧可改为 `<img src="data:image/svg+xml,...">` + DOM 净化。

### 🏗️ 结构

- **`frontend/src/mermaid.ts`**：懒加载单例 + LRU + setMermaidLoader 接缝。

- **Preview 类扩展**：`replaceMermaidBlocks`（decorate 之前替换）、
  `hydrateMermaidBlocks(holders, gen, theme)`（异步 SVG 注入）、`onThemeChange`
  （仅重 hydrate 已有块，不重 render 整文档）。

- **style.css** 新增 `.mermaid-block` / `[data-state=loading|error]` 样式。

- **`main.ts applyTheme`**：末尾调用 `preview.onThemeChange(base)`。

### 🧪 测试

- 新增 `mermaid.ts` + `mermaid.test.ts`（**22 断言**）：基础渲染、缓存命中、
  主题隔离、错误降级、空代码、LRU 上限、loader 失败。

- `preview.test.ts` 增补 **9 断言**（Preview 实例化集成）：替换发生、不
  进入 `.code-block`、成功路径注入 `<svg>`、错误路径 `data-state=error`、
  快速切换仅保留最新文档的 mermaid 块。

- 修复 `preview.test-bootstrap.ts` 缺 `getComputedStyle`（mermaid ensureInitialized
  在 node 环境会 TypeError → null）。

- 前端全量 **376 断言 0 失败**（preview 84 / obsidian 45 / latex 55 /
  titlebar 21 / tabs 22 / md-escape 30 / toc 33 / user-css 64 / mermaid 22）。

- 新增 `e2e/sprint11.sh`（E2E，见仓库）：真实 Chromium 下 flowchart 渲染
  出 svg、错误语法降级、主题切换重渲染、缓存命中零耗时。

### 📦 产物

- 主 JS **966KB / 317.86KB gzip**（v0.2.7 是 963KB/316.83KB，仅 +3KB）。

- **mermaid 自动按图种分包**：cynefin chunk 690KB/155KB gzip 等多个按需 chunk。

- 启动时主 chunk 不含 mermaid，文档无 mermaid 时零开销；首次出现按需下载。

***

## \[0.2.7] — 2026-09-01

新增**内嵌 HTML 渲染**与**内嵌 CSS 渲染**（含 `<style>` 块与 style 属性），
配套作用域隔离与五类攻击面防护。前端全量 362 断言 0 失败。

### ✨ 新增

- **内嵌 HTML 渲染**：DOMPurify 白名单扩充 26 个语义/媒体标签——
  `figure`/`figcaption`/`details`/`summary`/`mark`/`abbr`/`q`/`cite`/`small`/
  `dl`/`dt`/`dd`/`caption`/`col`/`colgroup`/`address`/`time`/`var`/`samp`/
  `bdi`/`bdo`/`wbr`/`video`/`audio`/`source`/`track`/`picture`；属性扩充
  `colspan`/`rowspan`/`controls`/`loop`/`muted`/`poster`/`datetime` 等。
  `autoplay` 不放行（防自动播放骚扰）。`button`/`form`/`iframe`/`input`
  等交互元素仍一律剥除。

- **内嵌 CSS 渲染（`<style>`** **块）**：marked 输出中的 `<style>` 块由新模块
  `user-css.ts` 接管——提取 → `scopeUserCss` 重写为 **`.preview-content`
  作用域 CSS** → 以 `<style data-user-css>` 拼回渲染输出。支持普通规则、
  `@media`/`@supports`/`@container` 递归、`@keyframes`（内部不前缀）、
  `@font-face` 等声明型 at-rule；`html`/`body`/`:root` 开头的选择器映射为
  预览容器自身（符合「文档样式作用于正文」的直觉）。

- **style 属性渲染**：`<div style="color:red">` 等 30 余常用属性放行，
  经 DOMPurify `uponSanitizeAttribute` hook 声明级过滤。

- **data URI 图片**：`<img src="data:image/png;base64,...">` 直通渲染
  （`svg+xml`/`text/html` 等非白名单 MIME 显式拒绝）。

### 🔒 安全（内嵌 CSS 的五类攻击面防护）

1. **UI 欺骗（钓鱼）**：恶意文档用 `position:fixed` + `z-index:99999`
   盖住整个应用伪造界面 → 声明黑名单直接丢弃 `position` 非 relative/static
   值、`z-index`、`top/right/bottom/left/inset`；作用域前缀保证用户 CSS
   最远只能命中 `.preview-content` 包裹层内部（编辑器/侧栏/标题栏不可达）。
2. **外发跟踪/内网探测**：`background-image:url(http://evil/track)` →
   `url()` 仅放行 `#fragment` 与 `data:`；声明值含 `//` 一律丢弃（覆盖
   `image-set()`/`src()` 等全部加载函数）；`@import`/`@charset`/`@namespace`
   整条丢弃。
3. **HTML 逃逸**：CSS 字符串内 `</style>` 会让浏览器提前终止 style 块 →
   `buildUserStyleTag` 输出转义 `</style`；逃逸出的 HTML 本就落回
   DOMPurify 管线清洗，双保险。
4. **旧 IE 向量**：`expression()`/`behavior`/`-moz-binding` 声明丢弃。
5. **data URI 收窄**：DOMPurify 默认对 img/video 等放行全部 data:/blob:，
   hook 收窄为图片 base64 MIME 白名单（`svg+xml` 可携带脚本向量，拒绝）。

### 🏗️ 结构

- **Preview 增加** **`.preview-content`** **包裹层**：渲染内容全部落在
  `host(.preview) > wrap(.preview-content)` 内，是用户 CSS 的作用域边界；
  flow-root 建立 BFC，用户 CSS 的 float 不外溢。滚动容器仍是 `.preview`，
  滚动/同步滚动/大纲 API 不变；`sync-scroll` 等外部模块的后代查询穿透
  包裹层零改动。行号选择器 `.preview > [data-line]` 同步改为后代形式。

### 🧪 测试

- 新增 `frontend/src/user-css.ts` + `user-css.test.ts`（64 断言）：前缀化
  （含 `:not()` 内逗号、属性选择器字符串）、at-rule 分支、声明黑名单、
  url 白名单、`</style>` 逃逸转义、Nesting 整块丢弃。

- `preview.test.ts` 增补 26 断言：HTML 白名单正反向、style 属性过滤、
  `<style>` 作用域化、data URI 收窄；修复中发现并验证 DOMPurify 对
  媒体标签的 data: 兜底行为（已用 hook 收窄）。前端全量 **362 断言
  0 失败**（preview 75 / user-css 64 / obsidian 45 / latex 55 / titlebar 21 /
  tabs 22 / md-escape 30 / link-handler 33 / toc 17）。

- 新增 `e2e/sprint10.sh`（E2E，见仓库）：真实 WebView 下的样式生效与
  作用域隔离断言。

***

## \[0.2.6] — 2026-09-01

修复预览页链接跳转 404 卡死（🔴 严重：一次误点击即丢失全部未保存内容）。
新增 `e2e/sprint9.sh`（26 断言）与 `internal/links` 包（Go 单测 8 组）。

### 🐛 修复

- **预览区相对链接点击导致应用 404 卡死**（🔴，用户报告）：`[举例](../../文档名)`
  此前被原样保留 `href` 且无人拦截，点击让 WebView2 就地导航到
  `http://wails.localhost/文档名` → assetserver 未命中返回 404 空白页 →
  整个前端 SPA 被卸载（无边框窗口的标题栏/关闭按钮都由前端渲染，
  界面完全消失，只能杀进程重启，各标签未保存内容全部丢失）。
  三层修复：

  1. **渲染/交互层**：`preview.ts` 事件委托拦截**所有** `a[href]`（含中键
     auxclick / Ctrl+点击），`preventDefault` 后按 `classifyHref` 分类分流——
     外链/mailto 交系统默认程序（Go 白名单 http/https/mailto/tel）、
     本地 Markdown/文本在应用内打开（复用 tab 去重与最近文件）、
     其他已存在文件**二次确认后**交系统默认程序、不存在给出明确提示、
     未保存文档引导先保存（相对链接以其所在目录为基准）。
  2. **路径解析层**：新增 `internal/links` 包 + 4 个 binding
     （`ResolveLocalPath`/`OpenExternal`/`OpenPath`/`ReadLocalAsset`）。
     路径解析全部在 Go 侧完成：URL 百分号解码、`file://` 剥离、反斜杠
     归一、跨平台绝对路径判定（盘符/UNC）、`..` 折叠、扩展名分类；
     无扩展名目标按 Obsidian 约定嗅探文件头（8KB、无 NUL、合法 UTF-8）
     归为 Markdown。
  3. **兜底层**：assetserver 加 `navGuard` Middleware，未命中的 GET 一律
     302 回 `/?nav=<路径>`，前端显示浮层提示"链接无法在应用内打开"——
     任何漏网导航（未来新代码、右键新窗口等）都不再白屏卡死。

### ✨ 新增

- **标题锚点跳转**：marked v5+ 不再生成 heading id，`[跳转](#标题)` 点了
  永远没反应。渲染后为 h1–h6 补 GitHub 风格 slug id（重复自动加序号），
  锚点点击滚动预览区。

- **本地相对路径图片显示**：`![](../img.png)` 此前请求不存在的 HTTP 路径
  必然破图。渲染后异步解析为磁盘文件（限 10MB、白名单图片扩展名）回填
  data URL；失败显示虚线边框提示；renderGen 机制防止异步回填串版。

- **浮层提示组件**：fixed 定位独立层（不插入 grid 布局），textContent 防
  XSS，4–6 秒自动消失。

### 🧪 测试

- 新增 `internal/links`：路径解析 12 组、错误语义、kind 判定（含无扩展名
  嗅探）、scheme 白名单、图片读取限制，Go 单测全绿。

- 新增 `navguard_test.go`：兜底中间件——404 → 302 `/?nav=`、正常资源/首页/
  `/wails/` 端点/非 GET 均原样透传。

- 新增 `frontend/src/link-handler.ts`（分类纯函数）+ 33 条单测，前端全量
  272 断言 0 失败。

- 新增 `e2e/sprint9.sh` 26 断言：相对链接应用内打开且**不导航**、外链走
  OpenExternal、二次确认开/取消、断链提示、锚点滚动、未保存引导、中键
  拦截、图片 data URL 回填、wiki-link 回归、编辑器回归。

- 回归：sprint4（16）、sprint6（29）、sprint7（30）、sprint8（14）全绿。

***

## \[0.2.5] — 2026-09-01

### ♻️ 调整布局

- **标题栏增高 / 标签栏压缩**：`grid-template-rows` 第 1 行 32px → **40px**，
  第 2 行 36px → **30px**。标题栏恢复 Win11 常规标题栏高度（突出应用身份与
  窗口拖动区），标签栏收紧把空间让给正文；`sprint7` 场景 3 同步更新断言。
  标题栏 40 / 标签栏 30 = 4:3 比例，层次对比更清晰。

***

## \[0.2.4] — 2026-09-01

本次为 v0.2.3 全面代码审查（Go / 前端 TS / UI 三维度）后的集中修复，
共修 🔴 3 项、🟡 14 项、🟢 10 项。新增 `e2e/sprint8.sh`（14 断言）覆盖关键回归。

### 🐛 修复

- **复制按钮监听器随渲染无限累积**（🔴，sprint7 引入）：`preview.ts` 把
  代码块复制按钮的 `click` 监听器写在 `render()` 内，每次渲染追加一个、
  只增不减——长编辑会话点击一次复制会执行成百上千次 clipboard 写入。
  移到 constructor（与 wiki-link 监听并列，host 从不被 innerHTML 清空）。

- **对话框 returnValue 残留导致 ESC 误执行上次选择**（🔴）：ESC 关闭
  `<dialog>` 不修改 `returnValue`，它保留上一次按钮写入的值。连续关闭
  第二个未保存标签时按 ESC 会「复用」上次的「放弃」→ 静默丢数据。
  `askUnsaved` / `confirmQuit` 在 `showModal()` 前显式 `returnValue = ""`。

- **config.json 损坏后 PushRecent 永久失败且无法自愈**（🟡）：`Mutate`
  对 `json.Unmarshal` 失败直接 return，损坏文件永远不被覆盖。引入
  `ErrCorrupted` 哨兵区分「已降级 Default 可继续」与「读取失败应中断」，
  Mutate 遇损坏时以默认值继续并落盘覆盖，实现自愈（含回归测试）。

- **未保存文档拖入图片在 Windows 真机必失败**（🟡）：`main.ts` 对无 path
  标签硬编码 `/mock/assets/`（mock 专用路径），Windows 上非绝对路径被
  Go 侧 `safeWritePath` 拒绝。桌面端（有 `window.runtime`）引导先保存；
  mock 的 `CopyImageAsset` 补绝对路径校验，对齐真实 binding 行为。

- **拖拽分隔条未监听 pointercancel**（🟡）：触屏手势冲突 / Alt-Tab 打断
  拖拽时派发 `pointercancel` 而非 `pointerup`，`dragging` 永真、监听器
  永久残留——此后鼠标移动分栏比例/侧栏宽度跟着变。`splitpane` 与
  `sidebar` 同听 `pointercancel` 复位并摘除监听器。

- **图片插入追加到文档末尾且光标重置**（🟡）：新增 `insertAtCursor`，
  在光标处插入图片 markdown；新增每标签光标/滚动位置记忆，切回恢复。

### ✨ 新增

- **标签栏键盘可达性**（🔴）：roving tabindex（仅活动标签入 Tab 序），
  ←/→/↑/↓ 切换激活、Home/End 跳首尾、Enter/Space 激活、Delete/Backspace 关闭。

- **TOC 键盘导航**（🟡）：容器单 Tab 入口，↑/↓ 在可见行间移动并跳转、
  ←/→ 折叠/展开、Home/End 跳首尾、Enter 跳转。

- **分屏把手键盘调整**（🟡）：`role="separator"` + `aria-valuenow`，
  ←/→ 步进 2%、Home/End 到边界。

### ♻️ 优化

- **渲染性能**（🟡）：KaTeX 公式结果缓存（连续输入不再重算相同公式）；
  `renderMarkdown` 整文 LRU（8 条）——切 tab 往返跳过全管线。

- **callout 标题**（🟢）：改走 `marked.parseInline`，标题内 `**加粗**` /
  `` `代码` `` 与正文一致渲染（旧版显示字面星号）。

- **工具函数收敛**：`escapeHtml` 抽到 `html.ts` 唯一事实源（原 main.ts
  与 latex.ts 双份）；`marked.setOptions` 收敛到 `preview.ts` 一处。

- **UI 细节**（🟡/🟢）：tab 关闭按钮对比度提升、预览长单词/长 URL 换行、
  窄窗口媒体查询、外部链接 `↗` 标记、状态栏路径点击复制、图片
  `loading="lazy"`、tooltip `:focus-visible` 触发。

- **工程卫生**：删除 `._*` AppleDouble 残留与临时 CHANGELOG；
  `build_windows/` 改名 `nsis-src/`（同步构建脚本与文档）；
  构建脚本 `ls | head` 补 `|| true` 使失败报错生效。

***

## \[0.2.3] — 2026-09-01

### 🐛 修复

- **侧边栏收起后内容栏未自动扩展**（v0.2.1 引入）：`sidebar.ts` 用
  `style.setProperty("--sidebar-w", width)` 把列宽写到 `#app` 的 inline style，
  开关时只更新 data 属性、没同步写变量 → 收起后 `--sidebar-w` 仍是 240px，
  `1fr` 内容列吃不到 240px 空间。`applyVisible` 与 `applyWidth` 互相感知可见性：
  收起时把变量强制归零，展开时恢复；拖动时只在可见状态下更新。

- **顶栏 tooltip 被目录栏 / 标签栏遮挡**：`.topbar` 自身没设 z-index，
  按 DOM 顺序被后续兄弟（`.sidebar` / `.tabbar`）盖住；tooltip z:100 只在
  topbar 内部有效，跨不过自身边界。给 `.topbar` 加 `position: relative; z-index: 10`，
  提为顶层 stacking context。

- **预览中相对路径链接不可点击**（v0.2.x 起）：`DOMPurify.sanitize` 的
  `ALLOWED_URI_REGEXP` 限得太死，仅允许 `https?:` / `mailto:` / `tel:` / `/` / `#`，
  `./foo` / `../foo` / `foo` 全部被剥 → `<a>` 渲染但 `href=null`、cursor: auto。
  改为显式接受相对路径，同时仍拒绝 `javascript:` / `data:` / `vbscript:` /
  大小写绕过。

### ✨ 新增

- **代码块装饰（Obsidian 风）**：每个有语言标签的代码块顶部加 header，含
  「语言名（大写灰字）」+「复制按钮（inline SVG 剪贴板图标）」。

  - 仅扫描 `pre > code[class*="language-"]`，无语言标签的代码块不装饰

  - header 用 `border-bottom: none` + pre 用 `border-top-left-radius: 0` 圆角对齐

  - 复制：调 `navigator.clipboard.writeText`，成功后按钮 1.2s 内显「已复制」+ 高亮

  - 装饰在 `preview.ts render()` 内、scrub 之后做，pre 上的 `data-line` 保留
    → 同步滚动 / 大纲跳转不被破坏

- **顶栏高度压缩**：`min-height` 40px → 32px（Win11 标题栏标准），`grid-template-rows`
  第 1 行同步改为 32px。释放 12px 给文档区，与侧边栏标题 28px 同档。

### 🧪 测试

- 新增 `e2e/sprint7.sh`：侧边栏内容栏扩展（3 模式 / 6 断言）/ topbar stacking context
  与 tooltip 浮出 / topbar 高度 / 链接 href 注入（5 路径 + 3 危险 scheme 过滤）/
  代码块装饰（容器数 / 语言标签 / 复制按钮 / data-line 保留 / 截图）。28 断言全过。

- 回归：sprint1-6 + 单测全过。

- 视觉截图：`e2e/sprint7-tooltip-on-top.png`、`e2e/sprint7-topbar-compact.png`、
  `e2e/sprint7-codeblocks.png`。

## [0.2.2](https://github.com/litemd/litemd/releases/tag/v0.2.2) — 2026-09-01

### 🐛 修复

- **预览模式下点击目录树无法跳转**（v0.2.1 引入）：仅预览模式下编辑器 pane 为
  `display:none`，`revealLine()` 对它 dispatch 滚动、`focus()` 都是空操作，
  点击大纲条目后界面毫无反应。

  - 改为按视图模式分流跳转目标：仅预览时滚动预览区，分屏 / 仅编辑时跳编辑器
    （分屏下由同步滚动把预览一并带过去）。

  - 预览侧复用 `render()` 已注入的 `data-line`（原文行号）定位内容块，
    不另建一套标题索引 —— 两套索引最容易失步。

  - 找不到行号精确相等的块时退到"最后一个位于目标行之前的块"：标题被包在
    列表 / callout 等容器里时，其块行号等于容器起始行而非标题所在行。

- **仅预览模式下大纲高亮不跟随**：该模式没有编辑器光标可用，高亮会一直停在
  跳转前的位置，手动滚预览也不更新。新增预览区滚动监听（rAF 节流），
  由视口顶部所在标题驱动高亮。

- **空文档与"有内容但无标题"文档切换时大纲占位文案不刷新**（sprint6 E2E 检出）：
  `update()` 用 `flat.map(...).join("\n")` 做签名短路，但两种空状态的 `flat`
  都是空数组 → 签名都是 `""` → 切到无标题文档时命中短路、不重建 DOM，
  提示文案卡在「未打开文档」。签名加入 `emptyKind` 区分两种空状态。

### 🧪 测试

- 新增 `e2e/sprint6.sh`：侧边栏开关 + Ctrl+B / 大纲解析（围栏、frontmatter、
  Setext、层级缩进）/ 折叠态按路径键 / 三模式点击跳转 / 滚动跟随高亮 /
  空状态提示 / 跨 Sprint 回归。29 项断言全通过。

- Playwright 真机浏览器验证四种场景全部通过：仅预览跳转（目标标题精确落在
  距顶 8px 留白处）、预览滚动驱动高亮、分屏跳转 + 同步滚动、仅编辑跳转。

- 全量前端套件 269 项断言通过；`tsc --noEmit` 无错误；Go 测试全通过。

## [0.2.1](https://github.com/litemd/litemd/releases/tag/v0.2.1) — 2026-09-01

### ✨ 新增

- **文档大纲（目录树）**：左侧边栏以层级树展示当前文档的 H1–H6 标题，
  点击跳转到对应行，并跟随光标高亮所在章节。

  - 解析同时支持 ATX（`# 标题`）与 Setext（`标题` + `===` / `---`）两种写法；

  - 跳过围栏代码块与 YAML frontmatter —— 避免 shell 注释里的 `# 安装`
    被误判为标题、`key: value` 被 Setext 规则误升级为 H2；

  - 标题文本自动剥除 `**加粗**` / `` `代码` `` / `[链接](url)` /
    `[[双链|别名]]` / 图片 / HTML 标签等行内标记；

  - 子章节可折叠，折叠状态按树中位置路径记忆，编辑标题文字不会丢失；

  - 层级跳变（H2 直接跟 H4）时 H4 挂在 H2 下，不制造空的中间层级节点。

- **左侧边栏容器**：可折叠（顶栏按钮 / 面板内箭头 / `Ctrl+B`）、
  可拖拽调宽（双击复位），显隐与宽度写入 localStorage。
  容器与内容解耦，后续可直接挂载文件树等新面板。

### 🔧 修复

- `build-win11-x64.sh` 在干净检出时失败：`mkdir -p build/windows` 后
  直接往 `build/windows/installer/` 复制 `project.nsi`，目录不存在导致 `cp` 报错。
  改为 `mkdir -p build/windows/installer`。

- 安装包版本信息滞后：wails 只在 `wails_tools.nsh` 缺失时才生成它，
  版本升级后会沿用旧文件。构建前删除该文件强制重新生成。

- 构建脚本新增版本号自动递增（patch 位 +1），并同步 `wails.json` /
  `app.go` / `index.html` / `dev.html` / `mocks.ts` 五处版本事实源，
  避免「安装包是新版、启动屏还是旧版」。用 `SKIP_BUMP=1` 或 `VERSION=x.y.z` 可绕过。

### 🧪 测试

- 新增 `frontend/src/toc.test.ts`：30 项断言，覆盖层级识别、围栏代码块排除、
  frontmatter 排除、`#hashtag` / `#######` 伪标题、Setext 消歧、
  行内标记清洗、层级跳变嵌套。

- 全量前端套件 269 项断言通过（7 套件）；`tsc --noEmit` 无错误；Go 测试全通过。

## [0.2.0](https://github.com/litemd/litemd/releases/tag/v0.2.0) — 2026-08-12

**首个生产可用版本**：对标 Obsidian 快捕场景，启动 < 1.5s、安装包 3MB、内存 < 200MB。

### ✨ 新增

- **CodeMirror 6 编辑器**：行号、Markdown 语法高亮、搜索 (`Ctrl+F`)、
  替换 (`Ctrl+H`)。<!-- 勘误：v0.2.0 段曾列"命令面板 (Ctrl+P)"与"多种 keyMap（默认/Vim/Emacs）"，实际未实装（当前 `Ctrl+P` 为切换预览模式），已在 v0.2.9 段去除 -->

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

- E2E 自动化 5 份脚本（sprint1\~5）：约 80+ 项断言（CodeMirror、性能、
  Obsidian 语法、构建产物、更新检查）。

### 🧹 代码质量（v0.2.0 审查修复）

- 修复 B 系列后端高/中/低优 14 项（B1\~B16，除 P5 生产签名外全修）。

- 修复 F 系列前端高/中/低优 17 项（F1\~F17，F18/F19 按低优保留）。

- 修复 T/E 系列测试/E2E 19 项：95% 已完成（剩余 E14 截图路径
  环境变量化按 CI 配置节奏补充）。

***

## [0.1.0](https://github.com/litemd/litemd/releases/tag/v0.1.0) — 2026-06-30

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

***


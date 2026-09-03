package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"litemd/internal/config"
	"litemd/internal/fileio"
	"litemd/internal/links"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// AppVersion 是 LiteMD 当前版本号,作为全项目唯一版本事实源。
// 发版时需同步更新:wails.json 的 info.productVersion(NSIS 安装包名/版本
// 信息由此生成)。注释中的"编译时注入"曾与硬编码实现不符,已修正。
const AppVersion = "0.2.8"

// App 是 Wails 应用主体，前端可通过自动生成的 wailsjs/go 绑定访问其方法。
//
// 设计原则：
//   - 方法都返回 (T, error)，前端可用 try/catch 处理；
//   - 错误优先用 errors.Is 判断类型，便于前端分类提示；
//   - 不在 binding 内做重活，所有 IO 都即时返回。
//
// 并发说明：ctx 由 startup 钩子写入、可能被 SingleInstanceLock 的
// OnSecondInstanceLaunch 回调并发读取,因此经 ctxMu 读写锁保护;
// pendingNotify 用于"回调先于 startup"时挂起通知、startup 后补发。
type App struct {
	ctxMu         sync.RWMutex
	ctx           context.Context
	store         *config.Store
	startupFiles  *startupFileQueue // 文件关联打开的待开文件（启动参数 / 二实例参数）
	// pendingNotify 前端就绪前收到二实例打开请求的补发标记。
	// 审查 P1-8：由 ctxMu（写锁）而非 atomic 保护 —— 它必须与 ctx 的读写
	// 在同一临界区内翻转，否则"读 ctx 为 nil"与"置标记"之间会被 startup
	// 插队，标记再无补发时机。
	pendingNotify bool
}

// NewApp 构造应用实例。store 注入便于测试替换。
func NewApp() *App {
	return &App{store: config.NewStore(), startupFiles: &startupFileQueue{}}
}

// startup 是 Wails 生命周期钩子，保存 ctx 供后续 binding 使用。
// 二实例回调(OnSecondInstanceLaunch)可能在钩子前后任意时刻到达,
// 因此这里写入后需检查是否有挂起的通知需要补发。
func (a *App) startup(ctx context.Context) {
	a.ctxMu.Lock()
	a.ctx = ctx
	a.ctxMu.Unlock()
	a.flushPendingNotify()
}

// currentCtx 以读锁安全获取 ctx(可能为 nil,发生在 startup 之前)。
func (a *App) currentCtx() context.Context {
	a.ctxMu.RLock()
	defer a.ctxMu.RUnlock()
	return a.ctx
}

// shutdown 是 Wails 生命周期钩子。当前无需收尾工作:
// 配置在每次 SetConfig/PushRecent 时即时落盘,文件保存也是即时原子写,
// 不存在"内存态需在退出前刷盘"的场景。保留钩子供未来扩展。
func (a *App) shutdown(ctx context.Context) {
	_ = ctx
}

// ============================================================================
// 文件 IO 绑定
// ============================================================================

// FilePayload 是 OpenFile / SaveFile 的标准返回结构。
type FilePayload struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Modified int64  `json:"modified"` // 文件最后修改时间戳（Unix）
}

// OpenFile 打开一个 .md 文件并返回内容。
//
// 错误语义：
//   - 返回的 error 可被 errors.Is(err, fileio.ErrNotFound) 识别 → 前端可引导用户新建
//   - 返回的 error 可被 errors.Is(err, fileio.ErrIsBinary) 识别 → 前端拒绝显示
//
// 性能优化：Modified 字段直接读取 stat.ModTime（避免多余 time.Now 调用）；
// 仅在 stat 失败时退回到 time.Now()，保持向前兼容。
func (a *App) OpenFile(path string) (FilePayload, error) {
	if path == "" {
		return FilePayload{}, errors.New("path is empty")
	}
	// 审查 P1-9：只放行 Markdown / 纯文本类型。打开对话框带 "All Files"
	// 过滤器，缺了这道兜底，ReadText（只校验 UTF-8）会把 ~/.ssh/id_rsa、
	// .env 这类明文凭据原样读进编辑器。
	if err := links.CheckEditable(path); err != nil {
		return FilePayload{}, err
	}
	content, err := fileio.ReadText(path)
	if err != nil {
		return FilePayload{}, err
	}
	abs, absErr := filepath.Abs(path)
	if absErr != nil {
		// 路径规范化失败（极端场景），回退到原 path
		abs = path
	}
	// 一次 stat 获取 mtime；失败时退到 now（保证前端永远拿到时间戳）
	st, statErr := os.Stat(abs)
	modified := time.Now().Unix()
	if statErr == nil {
		modified = st.ModTime().Unix()
	}
	return FilePayload{
		Path:     abs,
		Content:  content,
		Modified: modified,
	}, nil
}

// OpenDialog 是 Wails 调用文件选择对话框的便利包装。
//
// 返回值：
//   - 选中的绝对路径，字符串
//   - 用户取消时为空字符串 + nil
//   - 出错时返回非 nil error
func (a *App) OpenDialog() (string, error) {
	ctx := a.currentCtx()
	if ctx == nil {
		return "", errors.New("app not ready")
	}
	return wailsruntime.OpenFileDialog(ctx, wailsruntime.OpenDialogOptions{
		Title: "打开 Markdown 文件",
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "Markdown (*.md, *.markdown)", Pattern: "*.md;*.markdown;*.mdown;*.mkd;*.mkdn"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
}

// SaveDialog 弹出另存为对话框。
func (a *App) SaveDialog(suggestedName string) (string, error) {
	ctx := a.currentCtx()
	if ctx == nil {
		return "", errors.New("app not ready")
	}
	return wailsruntime.SaveFileDialog(ctx, wailsruntime.SaveDialogOptions{
		Title:           "另存为",
		DefaultFilename: suggestedName,
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "Markdown", Pattern: "*.md"},
			{DisplayName: "All Files", Pattern: "*.*"},
		},
	})
}

// SaveFile 保存文本到指定路径，返回保存后磁盘文件的真实 mtime（Unix 秒）。
//
// P0-5 外部修改冲突检测：expectMtime > 0 时先 stat 目标文件，mtime 与预期
// 不符（文件被其他程序改过）返回包一层 fileio.ErrExternalModified 的错误，
// 不写入——旧版会静默覆盖外部修改，且前端从不消费 FilePayload.Modified，
// diskMtime 只写不读。expectMtime 传 0（首次保存/用户确认覆盖）跳过检测。
//
// 返回 mtime 而非让前端用本地时钟伪造（旧版 Date.now()/1000 与磁盘真实
// mtime 存在时钟偏差，会把「外部改过」误判为「没改过」）。
//
// 注意：调用方应先通过 SaveDialog 让用户确认目标路径（如果不希望弹窗，可由前端直接调）。
func (a *App) SaveFile(path, content string, expectMtime int64) (int64, error) {
	if path == "" {
		return 0, errors.New("path is empty")
	}
	if expectMtime > 0 {
		if st, err := os.Stat(path); err == nil && st.ModTime().Unix() != expectMtime {
			return 0, fmt.Errorf("%w: %s (disk %d, expected %d)",
				fileio.ErrExternalModified, path, st.ModTime().Unix(), expectMtime)
		}
	}
	if err := fileio.WriteText(path, content); err != nil {
		return 0, err
	}
	// 保存后取真实 mtime 回传；stat 失败退回当前时间（保底可用）
	if st, err := os.Stat(path); err == nil {
		return st.ModTime().Unix(), nil
	}
	return time.Now().Unix(), nil
}

// SaveFileAs 弹出对话框让用户选择保存位置，然后写入。
//
// 返回最终写入的绝对路径（用户取消则为空字符串 + nil）。
func (a *App) SaveFileAs(suggestedName, content string) (string, error) {
	target, err := a.SaveDialog(suggestedName)
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil // 用户取消
	}
	if filepath.Ext(target) == "" {
		target += ".md"
	}
	if err := fileio.WriteText(target, content); err != nil {
		return "", err
	}
	// #11 修复：Abs 失败不再静默吞错。文件已成功落盘，此时返回错误会让
	// 前端误以为保存失败；回退到写入路径保证用户拿到可用的路径。
	abs, absErr := filepath.Abs(target)
	if absErr != nil {
		return target, nil
	}
	return abs, nil
}

// ============================================================================
// 文件关联（"使用本应用打开"）
// ============================================================================

// ConsumeStartupFile 取出待打开的关联文件（若存在）。
//
// 触发来源：
//   - 系统以文件路径为参数启动应用（见 main.go 对 os.Args 的解析）
//   - 应用已运行时再次通过文件关联打开（二实例参数，见 SingleInstanceLock 回调）
//
// 返回语义：
//   - 无待开文件：返回零值 FilePayload{Path: ""} + nil，前端据此走"新建空文档"
//   - 有待开文件：等价于 OpenFile 的返回（读取失败时返回相应 error）
//
// "消费即清除"保证重复调用不会重复打开。
func (a *App) ConsumeStartupFile() (FilePayload, error) {
	path := a.startupFiles.pop()
	if path == "" {
		return FilePayload{}, nil
	}
	return a.OpenFile(path)
}

// notifyExternalOpen 通知前端"有新的关联文件待打开"。
//
// 时序兜底:若回调到达时 startup 尚未执行(ctx == nil),事件无法发出,
// 置 pendingNotify 标记,startup 完成后由 flushPendingNotify 补发;
// 即使补发也失败(极端:前端事件监听未注册),文件仍在队列中,
// 前端下次消费(事件触发或重启)仍可取到,不丢数据。
//
// 审查 P1-8:"读 ctx → 置标记"必须与 startup 的"写 ctx → 补发"互斥,
// 否则存在交叉窗口:本函数读到 ctx==nil 后被挂起,startup 写完 ctx 并
// 执行了 flushPendingNotify(此时标记还是 false,空转返回),标记随后才被
// 置 true,且再无补发时机 —— 用户双击了 .md,第二个实例把路径塞进队列,
// 主界面却永远收不到事件。因此全程持 ctxMu 写锁,并把标记改成锁内 bool。
func (a *App) notifyExternalOpen() {
	ctx := a.takeCtxForNotify()
	if ctx != nil {
		emitEvent(ctx, openExternalFileEvent)
	}
}

// openExternalFileEvent 前端监听的事件名（"有关联文件待打开"）。
const openExternalFileEvent = "litemd:openExternalFile"

// emitEvent 是事件发送接缝，真实实现转调 wails runtime。
//
// 单测需要验证"通知不丢不重"（审查 P1-8）：runtime.EventsEmit 在 ctx 里
// 拿不到 wails 的 events 对象时会直接 log.Fatal 终止进程，无法在测试中调用，
// 故留出接缝供测试替换（与 links.runDetached 同一套路）。
var emitEvent = func(ctx context.Context, name string) {
	wailsruntime.EventsEmit(ctx, name)
}

// defaultEmitEvent 保存真实实现，供测试替换后还原。
var defaultEmitEvent = emitEvent

// takeCtxForNotify 在 ctxMu 保护下取 ctx:取到则直接可发事件;
// 取不到(ctx 尚未就绪)则置挂起标记,返回 nil。
// takeCtxForNotify 在 ctxMu 保护下取 ctx:取到则直接可发事件;
// 取不到(ctx 尚未就绪)则置挂起标记,返回 nil。
//
// 关键在于"读 ctx"与"置标记"必须在同一临界区内:startup 的"写 ctx +
// flushPendingNotify"若插在两者之间,标记会被置位在补发之后,再无补发时机
// (审查 P1-8;回归测试见 app_notify_test.go 的 ConcurrentNoStuck)。
func (a *App) takeCtxForNotify() context.Context {
	a.ctxMu.Lock()
	defer a.ctxMu.Unlock()
	if a.ctx != nil {
		return a.ctx
	}
	a.pendingNotify = true
	return nil
}

// flushPendingNotify 补发挂起的通知(仅 startup 后调用一次;
// 标记在 ctxMu 下与 ctx 一起翻转,至多补发一次)。
func (a *App) flushPendingNotify() {
	a.ctxMu.Lock()
	if !a.pendingNotify {
		a.ctxMu.Unlock()
		return
	}
	a.pendingNotify = false
	ctx := a.ctx
	a.ctxMu.Unlock()
	if ctx != nil {
		emitEvent(ctx, openExternalFileEvent)
	}
}

// ============================================================================
// 链接与本地资源绑定
// ============================================================================

// LinkTarget 是 ResolveLocalPath 对前端的返回结构。
//
// 背景：预览区的 [文本](../xxx.md) 若放任 WebView 处理，会就地导航到
// http://wails.localhost/xxx.md → assetserver 404 → 整个前端被卸载（界面卡死、
// 未保存内容丢失）。前端因此拦截所有链接点击，先经本方法解析，再决定动作：
// markdown/text 在应用内打开，other 交系统默认程序，missing 提示用户。
type LinkTarget struct {
	Path   string `json:"path"`   // 绝对路径；不存在时是"应该在哪"的路径，供提示展示
	Exists bool   `json:"exists"` // 目标是否存在
	Kind   string `json:"kind"`   // markdown | text | other | dir | missing
	Anchor string `json:"anchor"` // 目标文件内的锚点（无则空串）
}

// ResolveLocalPath 解析 Markdown 链接目标。
//
// baseFile 是当前文档的绝对路径（相对链接以其所在目录为基准，未保存文档传空串）；
// href 是预览 DOM 上的原始 href（可能带百分号编码 / #锚点 / ?查询）。
//
// 错误语义（前端按类型分别提示）：
//   - errors.Is(err, links.ErrNoBase)：相对链接但当前文档未保存 → 引导先保存
//   - errors.Is(err, links.ErrNotLocal)：带 http/mailto 等协议 → 应走 OpenExternal
//   - errors.Is(err, links.ErrEmptyTarget)：href 为空
func (a *App) ResolveLocalPath(baseFile, href string) (LinkTarget, error) {
	t, err := links.Resolve(baseFile, href)
	if err != nil {
		return LinkTarget{}, err
	}
	return LinkTarget{Path: t.Path, Exists: t.Exists, Kind: string(t.Kind), Anchor: t.Anchor}, nil
}

// OpenExternal 用系统默认浏览器/邮件客户端打开外链。
//
// 只放行 http/https/mailto/tel：被打开的 .md 内容不受信任，未做 scheme 白名单
// 就丢给系统程序等同于给文档作者一个"打开任意本地文件"的原语。
func (a *App) OpenExternal(rawURL string) error {
	u, err := links.ValidateExternalURL(rawURL)
	if err != nil {
		return err
	}
	ctx := a.currentCtx()
	if ctx == nil {
		return errors.New("app not ready")
	}
	wailsruntime.BrowserOpenURL(ctx, u)
	return nil
}

// OpenPath 用系统默认程序打开一个本地文件（PDF / Excel / 图片等）。
//
// 安全前提：路径必须绝对、存在且是常规文件（links.OpenWithSystem 强制校验）；
// 前端在此之前还应完成"非文本文件是否打开"的二次确认。
func (a *App) OpenPath(path string) error {
	return links.OpenWithSystem(path)
}

// ReadLocalAsset 读取本地图片为 data URL，供预览区的 <img src> 回填。
//
// 相对路径图片在 wails.localhost 源下会被解析成不存在的 HTTP 路径而破图，
// 这里返回 data:image/…;base64,… 让本地图片正常显示。
// 限制：仅白名单图片扩展名、单文件 ≤ links.MaxAssetBytes（10MB）。
func (a *App) ReadLocalAsset(path string) (string, error) {
	return links.ReadAssetDataURL(path)
}

// ============================================================================
// 配置绑定
// ============================================================================

// GetConfig 返回当前完整配置。
func (a *App) GetConfig() (config.Config, error) {
	return a.store.Load()
}

// SetConfig 用传入的配置整体替换。
//
// 设计上走整体替换而非 diff 写入，简单可靠。如未来字段增多可改为 merge。
func (a *App) SetConfig(cfg config.Config) error {
	return a.store.Save(cfg)
}

// PushRecent 推入最近文件并持久化。
//
// #5 修复：经 store.Mutate 在锁内完成读-改-写全序列，消除旧版
// Load/Save 分离时的并发丢更新窗口（快速连续保存多个文件时，
// 两个 PushRecent 可能基于同一份旧配置互相覆盖）。
func (a *App) PushRecent(path string) (config.Config, error) {
	cfg, err := a.store.Mutate(func(c config.Config) config.Config {
		return config.PushRecent(c, path, 10)
	})
	if err != nil {
		return config.Default(), err
	}
	return cfg, nil
}

// ============================================================================
// 元信息与工具
// ============================================================================

// AppInfo 描述应用自身的元数据。
type AppInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Os      string `json:"os"`
}

// AppInfo 返回应用元信息。
func (a *App) AppInfo() AppInfo {
	return AppInfo{
		Name:    "LiteMD",
		Version: AppVersion,
		Os:      runtime.GOOS + "-" + runtime.GOARCH,
	}
}

// CopyImageAsset 把 base64 编码的图片数据持久化到当前文档所在目录的 assets/ 下。
//
// P0-2 修复：旧签名 (targetPath, base64Data) 让前端指定任意绝对路径，等价于
// 「任意文件写入原语」——前端被注入时可以往启动目录/配置文件写任意字节。
// 现改为 (baseFile, assetName, base64Data)：写入位置由后端从文档目录推导
// （<文档目录>/assets/<assetName>），assetName 校验纯文件名 + 图片扩展名
// 白名单 + 128 字符上限，解码内容限 20MB（fileio.MaxAssetWriteSize）。
// 前端失去指定写入位置的能力，写入范围被结构性限死在 assets/ 内。
//
// 返回最终写入的绝对路径（供前端生成 markdown 引用）。
func (a *App) CopyImageAsset(baseFile, assetName, base64Data string) (string, error) {
	if base64Data == "" {
		return "", errors.New("base64 data is empty")
	}
	target, err := fileio.AssetWritePath(baseFile, assetName)
	if err != nil {
		return "", err
	}
	if err := fileio.WriteBase64File(target, base64Data); err != nil {
		return "", err
	}
	return target, nil
}

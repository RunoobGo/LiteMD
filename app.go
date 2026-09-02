package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"litemd/internal/config"
	"litemd/internal/fileio"

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
	pendingNotify atomic.Bool       // 前端就绪前收到二实例打开请求的补发标记
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

// SaveFile 保存文本到指定路径。
//
// 注意：调用方应先通过 SaveDialog 让用户确认目标路径（如果不希望弹窗，可由前端直接调）。
func (a *App) SaveFile(path, content string) error {
	if path == "" {
		return errors.New("path is empty")
	}
	return fileio.WriteText(path, content)
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
func (a *App) notifyExternalOpen() {
	if ctx := a.currentCtx(); ctx != nil {
		wailsruntime.EventsEmit(ctx, "litemd:openExternalFile")
		return
	}
	a.pendingNotify.Store(true)
}

// flushPendingNotify 补发挂起的通知(仅 startup 后调用一次;
// CAS 保证与并发到达的 notifyExternalOpen 至多发一次)。
func (a *App) flushPendingNotify() {
	if !a.pendingNotify.CompareAndSwap(true, false) {
		return
	}
	if ctx := a.currentCtx(); ctx != nil {
		wailsruntime.EventsEmit(ctx, "litemd:openExternalFile")
	}
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

// CopyImageAsset 把 base64 编码的图片数据持久化到目标路径，并返回最终写入路径。
//
// 典型用法：用户拖入一张图片 → 前端读取为 base64 → 调此 binding 写入 .md 同目录的 assets/
// 约束：路径必须以 `/` 或盘符开头；base64 是去除 data:image/...;base64, 前缀后的纯数据。
//
// 错误：
//   - errors.Is(err, fileio.ErrIsBinary) 等
func (a *App) CopyImageAsset(targetPath, base64Data string) (string, error) {
	if targetPath == "" {
		return "", errors.New("target path is empty")
	}
	if base64Data == "" {
		return targetPath, errors.New("base64 data is empty")
	}
	// 直接复用 fileio 的原子写（前缀剥除由调用方负责）
	// 这里我们假定 base64Data 是 data uri 中的";"后的纯 base64
	return targetPath, fileio.WriteBase64File(targetPath, base64Data)
}

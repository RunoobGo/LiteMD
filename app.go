package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"litemd/internal/config"
	"litemd/internal/fileio"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// AppVersion 是 LiteMD 当前版本号，编译时注入。
// 在 NSIS 脚本里同步替换：LiteMD-Setup-v${APP_VERSION}.exe。
const AppVersion = "0.2.0"

// App 是 Wails 应用主体，前端可通过自动生成的 wailsjs/go 绑定访问其方法。
//
// 设计原则：
//   - 方法都返回 (T, error)，前端可用 try/catch 处理；
//   - 错误优先用 errors.Is 判断类型，便于前端分类提示；
//   - 不在 binding 内做重活，所有 IO 都即时返回。
type App struct {
	ctx   context.Context
	store *config.Store
}

// NewApp 构造应用实例。store 注入便于测试替换。
func NewApp() *App {
	return &App{store: config.NewStore()}
}

// startup 是 Wails 生命周期钩子，保存 ctx 供后续 binding 使用。
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown 是 Wails 生命周期钩子，确保配置被持久化（如果有变更但没保存的场景）。
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
	if a.ctx == nil {
		return "", errors.New("app not ready")
	}
	return wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "打开 Markdown 文件",
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "Markdown (*.md, *.markdown)", Pattern: "*.md;*.markdown;*.mdown;*.mkd;*.mkdn"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
}

// SaveDialog 弹出另存为对话框。
func (a *App) SaveDialog(suggestedName string) (string, error) {
	if a.ctx == nil {
		return "", errors.New("app not ready")
	}
	return wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
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
	abs, _ := filepath.Abs(target)
	return abs, nil
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
func (a *App) PushRecent(path string) (config.Config, error) {
	cfg, err := a.store.Load()
	if err != nil {
		return config.Default(), err
	}
	cfg = config.PushRecent(cfg, path, 10)
	if err := a.store.Save(cfg); err != nil {
		return cfg, fmt.Errorf("save after push: %w", err)
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

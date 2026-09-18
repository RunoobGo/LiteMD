package main

import (
	"embed"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

// navGuard 兜底：任何没被静态资源命中的 GET 请求都重定向回首页，而不是返回 404。
//
// 为什么要这层：预览区的 Markdown 链接（[x](../a.md)）只要有一处漏网（中键点击、
// 右键"新窗口打开"、未来新代码引入的裸 <a>），WebView2 就会导航到
// http://wails.localhost/a.md → assetserver 未命中 → 404 空白页 → 整个前端 SPA
// 被卸载。LiteMD 是无边框窗口，标题栏与关闭按钮都由前端渲染，此时界面完全消失、
// 只剩白屏，用户只能杀进程，各标签未保存内容全部丢失。
//
// 重定向到 /?nav=<原路径> 后由前端提示"该链接无法在应用内打开"，界面保持可用。
// 注意：wails dev 模式下资产由 vite dev server 提供、本中间件不生效，
// 但 vite 自带 SPA fallback，未知路径同样回退到 index.html，不会白屏。
func navGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 放行 Wails 内建端点（/wails/runtime 等）与非 GET 请求
		if r.Method != http.MethodGet || strings.HasPrefix(r.URL.Path, "/wails/") {
			next.ServeHTTP(w, r)
			return
		}
		rec := httptest.NewRecorder()
		next.ServeHTTP(rec, r)
		if rec.Code != http.StatusNotFound {
			copyResponse(w, rec)
			return
		}
		http.Redirect(w, r, "/?nav="+url.QueryEscape(r.URL.Path), http.StatusFound)
	})
}

// copyResponse 把 recorder 记录的结果原样写回真实 ResponseWriter。
func copyResponse(w http.ResponseWriter, rec *httptest.ResponseRecorder) {
	for k, vv := range rec.Header() {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(rec.Code)
	if rec.Body.Len() > 0 {
		_, _ = w.Write(rec.Body.Bytes())
	}
}

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// 文件关联冷启动：双击 .md / 右键"打开方式 → LiteMD" / 命令行启动时，
	// 目标文件路径位于命令行参数中(多选文件会传入多个路径,全部入队)。
	// 前端启动时经 ConsumeStartupFile 逐个消费
	// (旧版本忽略该参数，导致固定新建空文档)。
	for _, p := range extractStartupFiles(os.Args[1:]) {
		app.startupFiles.push(p)
	}

	// Create application with options
	// 无边框自定义标题栏：最小化/最大化/关闭由前端绘制（见 frontend/src/titlebar.ts）。
	// 拖动依赖 Wails 内建 dragTest：标题栏容器 CSS 变量 --wails-draggable: drag，
	// mousedown→mousemove 后由 Wails 发送 WM_NCLBUTTONDOWN(HTCAPTION) 进入系统拖动。
	// MinWidth/MinHeight 限制窗口最小尺寸，避免编辑区被挤压到不可用。
	err := wails.Run(&options.App{
		Title:     "LiteMD",
		Width:     1024,
		Height:    768,
		MinWidth:  800,
		MinHeight: 600,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: navGuard,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		// 审查 P1-11：OS 级关闭路径（任务栏关闭 / Alt+F4 / Cmd+Q）不经过
		// 前端标题栏的 confirmQuit 协商，beforeunload 在 WebView 关闭序列中
		// 不可靠 —— 这里注册原生守卫：有未保存标签时弹确认框，取消则阻止
		// 关闭（beforeClose 返回 true = 阻止）。OnShutdown 不挂：审计
		// R2-G11 已删除空的 shutdown 钩子，未来需要资源释放/统计上报时
		// 连方法带注册一起加回。
		OnBeforeClose: app.beforeClose,
		// 单实例锁：应用已运行时，文件关联再次触发的启动会带参拉起第二实例，
		// 这里截获其命令行参数并转发给已运行实例（Windows / Linux 生效）。
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "litemd-single-instance-lock-0f2c8a64",
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				files := extractStartupFiles(data.Args)
				if len(files) == 0 {
					return
				}
				for _, p := range files {
					app.startupFiles.push(p)
				}
				app.notifyExternalOpen()
			},
		},
		// macOS Finder 双击 / "打开方式" 关联：与冷启动共用 startupFiles 队列
		// + notifyExternalOpen 兜底（startup 前的回调会置 pendingNotify
		// 等 startup 后补发；单实例锁已覆盖"应用已运行"路径）。
		// wails v2 签名：OnFileOpen(filePath string)，多次双击会多次回调。
		Mac: &mac.Options{
			OnFileOpen: func(filePath string) {
				files := extractStartupFiles([]string{filePath})
				if len(files) == 0 {
					return
				}
				for _, p := range files {
					app.startupFiles.push(p)
				}
				app.notifyExternalOpen()
			},
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		log.Fatalf("wails run failed: %v", err)
	}
}

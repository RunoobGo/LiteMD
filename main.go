package main

import (
	"embed"
	"log"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

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
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
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
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		log.Fatalf("wails run failed: %v", err)
	}
}

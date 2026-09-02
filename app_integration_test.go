package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestIntegrationFileIO 验证 Wails 绑定暴露的 App 方法（前端通过 window.go.main.App.* 调用的同一份 Go 代码）：
//   - AppInfo：元信息
//   - OpenFile：读取已存在文件
//   - SaveFile + OpenFile 往返：写入再读回
//   - OpenFile 错误处理：不存在的路径应返回 error
//
// 这些方法与 frontend/wailsjs/go/main/App.js 自动生成的绑定一一对应，
// 绑定层仅做参数透传，因此本测试等价于验证桌面端 window.go 调用链的后端逻辑。
func TestIntegrationFileIO(t *testing.T) {
	app := NewApp()

	// --- AppInfo ---
	t.Run("AppInfo", func(t *testing.T) {
		info := app.AppInfo()
		if info.Name != "LiteMD" {
			t.Fatalf("Name = %q, want LiteMD", info.Name)
		}
		if info.Version != AppVersion {
			t.Fatalf("Version = %q, want %q", info.Version, AppVersion)
		}
		if info.Os == "" {
			t.Fatal("Os 为空")
		}
		t.Logf("AppInfo OK: %+v", info)
	})

	// 准备临时目录
	dir := t.TempDir()

	// --- OpenFile 读取已存在文件 ---
	t.Run("OpenFile_read_existing", func(t *testing.T) {
		src := filepath.Join(dir, "sample.md")
		want := "# IO 验证\n\n中文 emoji 🚀 `code`\n"
		if err := os.WriteFile(src, []byte(want), 0644); err != nil {
			t.Fatal(err)
		}
		payload, err := app.OpenFile(src)
		if err != nil {
			t.Fatalf("OpenFile err: %v", err)
		}
		if payload.Content != want {
			t.Fatalf("Content mismatch\n got: %q\nwant: %q", payload.Content, want)
		}
		if payload.Path == "" {
			t.Fatal("Path 为空")
		}
		if payload.Modified == 0 {
			t.Fatal("Modified 为 0")
		}
		// 中文/emoji 不应被破坏
		if !strings.Contains(payload.Content, "🚀") {
			t.Fatal("emoji 丢失，编码异常")
		}
		t.Logf("OpenFile OK: path=%s len=%d modified=%d", payload.Path, len(payload.Content), payload.Modified)
	})

	// --- SaveFile + OpenFile 往返 ---
	t.Run("SaveFile_then_OpenFile_roundtrip", func(t *testing.T) {
		out := filepath.Join(dir, "saved-by-backend.md")
		content := "# 保存验证\n\n由后端 SaveFile 写入。\n时间: " + time.Now().Format(time.RFC3339) + "\n"
		mtime, err := app.SaveFile(out, content, 0)
		if err != nil {
			t.Fatalf("SaveFile err: %v", err)
		}
		if mtime <= 0 {
			t.Fatalf("SaveFile 返回的 mtime 异常: %d", mtime)
		}
		// OS 层确认文件确实落盘
		data, err := os.ReadFile(out)
		if err != nil {
			t.Fatalf("磁盘读回失败: %v", err)
		}
		if string(data) != content {
			t.Fatalf("磁盘内容不一致\n got: %q\nwant: %q", string(data), content)
		}
		// 通过 OpenFile 再读一次（走应用层）
		reread, err := app.OpenFile(out)
		if err != nil {
			t.Fatalf("OpenFile roundtrip err: %v", err)
		}
		if reread.Content != content {
			t.Fatalf("往返内容不一致")
		}
		t.Logf("RoundTrip OK: 写入并读回 %d 字节", len(reread.Content))
	})

	// --- OpenFile 错误处理：不存在文件应抛错 ---
	t.Run("OpenFile_not_found_error", func(t *testing.T) {
		_, err := app.OpenFile(filepath.Join(dir, "does-not-exist.md"))
		if err == nil {
			t.Fatal("期望返回 error，实际为 nil")
		}
		t.Logf("NotFound 正确抛错: %v", err)
	})

	// --- OpenFile 错误处理：空路径 ---
	t.Run("OpenFile_empty_path", func(t *testing.T) {
		_, err := app.OpenFile("")
		if err == nil {
			t.Fatal("空路径应返回 error")
		}
	})

}

package main

// startupfile_test.go — 文件关联("使用本应用打开")启动链路的单元测试：
//   1. extractStartupFile:各种参数形态(旗标/相对路径/不存在/目录/多文件)
//   2. startupFileQueue:FIFO、空取、并发安全
//   3. App.ConsumeStartupFile:消费即清除、无文件返回空载荷

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestExtractStartupFiles(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "note.md")
	second := filepath.Join(dir, "二 note.markdown") // 含空格与非 ASCII,模拟真实路径
	if err := os.WriteFile(file, []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("# two"), 0o644); err != nil {
		t.Fatal(err)
	}

	eq := func(name string, got, want []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("%s: want %v, got %v", name, want, got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s: want %v, got %v", name, want, got)
			}
		}
	}

	t.Run("无参数", func(t *testing.T) {
		eq("nil", extractStartupFiles(nil), nil)
	})
	t.Run("macOS 旗标噪音", func(t *testing.T) {
		eq("flags", extractStartupFiles([]string{"-NSDocumentRevisionsModelVersion", "1", "-psn_0123456789"}), nil)
	})
	t.Run("单个文件(绝对路径)", func(t *testing.T) {
		eq("single", extractStartupFiles([]string{file}), []string{file})
	})
	t.Run("旗标+文件混合", func(t *testing.T) {
		eq("mixed", extractStartupFiles([]string{"--flag", file}), []string{file})
	})
	t.Run("多文件全部保留且有序", func(t *testing.T) {
		eq("multi", extractStartupFiles([]string{file, second}), []string{file, second})
	})
	t.Run("不存在的路径被跳过", func(t *testing.T) {
		eq("ghost", extractStartupFiles([]string{filepath.Join(dir, "ghost.md"), second}), []string{second})
	})
	t.Run("目录不算文件", func(t *testing.T) {
		eq("dir", extractStartupFiles([]string{dir}), nil)
	})
	t.Run("相对路径基于 cwd", func(t *testing.T) {
		t.Chdir(dir) // Go 1.24+:测试结束自动恢复
		eq("rel", extractStartupFiles([]string{"note.md"}), []string{file})
	})
}

func TestStartupFileQueue_FIFOAndEmpty(t *testing.T) {
	q := &startupFileQueue{}
	if p := q.pop(); p != "" {
		t.Fatalf("空队列 pop 应返回空串,got %q", p)
	}
	q.push("/a.md")
	q.push("") // 空路径应被忽略
	q.push("/b.md")
	if p := q.pop(); p != "/a.md" {
		t.Fatalf("FIFO 顺序被破坏:want /a.md got %q", p)
	}
	if p := q.pop(); p != "/b.md" {
		t.Fatalf("want /b.md got %q", p)
	}
	if p := q.pop(); p != "" {
		t.Fatalf("取空后应返回空串,got %q", p)
	}
}

func TestStartupFileQueue_Concurrent(t *testing.T) {
	q := &startupFileQueue{}
	const producers, each = 8, 50
	var wg sync.WaitGroup
	for i := 0; i < producers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < each; j++ {
				q.push("/x.md")
			}
		}()
	}
	wg.Wait()
	for i := 0; i < producers*each; i++ {
		if q.pop() == "" {
			t.Fatalf("第 %d 次取到空,期望共 %d 项", i+1, producers*each)
		}
	}
}

func TestConsumeStartupFile_Binding(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(file, []byte("# 关联打开"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := NewApp()

	// 无待开文件:空载荷 + nil error,前端据此走"新建空文档"
	p, err := app.ConsumeStartupFile()
	if err != nil || p.Path != "" {
		t.Fatalf("空队列:want (Path:\"\", nil), got (%+v, %v)", p, err)
	}

	// 入队后消费:应读到文件内容,且路径规范化为绝对路径
	app.startupFiles.push(file)
	p, err = app.ConsumeStartupFile()
	if err != nil {
		t.Fatalf("消费失败: %v", err)
	}
	if p.Path != file || p.Content != "# 关联打开" {
		t.Fatalf("want (%q, %q), got (%q, %q)", file, "# 关联打开", p.Path, p.Content)
	}

	// 消费即清除:再次调用返回空
	p, err = app.ConsumeStartupFile()
	if err != nil || p.Path != "" {
		t.Fatalf("重复消费应返回空:got (%+v, %v)", p, err)
	}
}

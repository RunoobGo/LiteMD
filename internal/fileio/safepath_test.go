package fileio

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSafeWritePath_AbsoluteRequired(t *testing.T) {
	cases := []struct {
		in        string
		wantError bool
	}{
		{filepath.Join(t.TempDir(), "ok.md"), false},
		{"relative/file.md", true},
		{"./relative.md", true},
		{"", true},
		{"   ", true},
	}
	for _, c := range cases {
		_, err := safeWritePath(c.in)
		if c.wantError && !errors.Is(err, ErrUnsafePath) {
			t.Errorf("safeWritePath(%q) want ErrUnsafePath, got %v", c.in, err)
		}
		if !c.wantError && err != nil {
			t.Errorf("safeWritePath(%q) unexpected error: %v", c.in, err)
		}
	}
}

func TestSafeWritePath_CleansDots(t *testing.T) {
	dir := t.TempDir()
	// 含 .. 的绝对路径：Clean 后会消解；我们要求输入就是 Clean 形态或可消解的合法路径
	in := filepath.Join(dir, "..", "x.md")
	clean, err := safeWritePath(in)
	if err != nil {
		t.Fatalf("safeWritePath(%q) unexpected error: %v", in, err)
	}
	if strings.Contains(clean, "..") {
		t.Errorf("safeWritePath did not clean .. : got %q", clean)
	}
}

func TestSafeWritePath_WindowsReserved(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-specific check; safeWritePath only enforces on Windows")
	}
	for _, name := range []string{`C:\foo\NUL.md`, `D:\CON`, `E:\path\COM1.txt`, `F:aux`} {
		if _, err := safeWritePath(name); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("safeWritePath(%q) should reject, got %v", name, err)
		}
	}
}

// TestWindowsBaseName 不依赖 GOOS，直接验证 #15 修复的扩展名截断规则。
func TestWindowsBaseName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{`C:\foo\NUL.md`, "NUL"},
		{`C:\foo\CON.x.txt`, "CON"}, // #15 回归：第一个点截断，保留名不再漏拦
		{`E:\path\COM1.txt`, "COM1"},
		{`C:\notes.v2.md`, "NOTES"},        // 多点文件名取主干
		{`E:\plain`, "PLAIN"},              // 无扩展名
		{`F:\.CON`, ".CON"},                // 点开头不是扩展名分隔，不截断（Windows 不视 .CON 为设备名）
		{`F:\a.b.c`, "A"},                  // 第一个点即截断
		{`D:/mixed/slash/lpt9.md`, "LPT9"}, // 正斜杠混排
		{"", ""},
	}
	for _, c := range cases {
		if got := windowsBaseName(c.in); got != c.want {
			t.Errorf("windowsBaseName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

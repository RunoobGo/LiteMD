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

// TestSafeWritePath_DotDotBackstop 审查 G1（v0.2.11）：补上注释早已承诺、
// 但代码里一直缺失的 ".." 段兜底检查，同时确认它不误伤含点的合法文件名。
func TestSafeWritePath_DotDotBackstop(t *testing.T) {
	dir := t.TempDir()

	// 不误伤：兜底检查按段比对，而不是笼统的 strings.Contains("..")
	allow := []string{
		filepath.Join(dir, "笔记..备份.md"), // 文件名内含连续两个点
		filepath.Join(dir, "..gitignore.md"),
		filepath.Join(dir, "a.b.c.md"),
		filepath.Join(dir, "sub", "..", "x.md"), // Clean 可消解
	}
	for _, in := range allow {
		if _, err := safeWritePath(in); err != nil {
			t.Errorf("safeWritePath(%q) 不应拒绝（兜底检查误伤）, got %v", in, err)
		}
	}

	// 真正触发兜底：Unix 上反斜杠不是路径分隔符，filepath.Clean 折叠不掉
	// ".." 段，此时只能靠兜底检查拦住（Windows 上 Clean 会消解，分支不可达）。
	if runtime.GOOS == "windows" {
		t.Skip("Windows 上 Clean 会消解该形态，兜底分支不可达")
	}
	if _, err := safeWritePath(`/tmp/a\..\b.md`); !errors.Is(err, ErrUnsafePath) {
		t.Errorf(`safeWritePath("/tmp/a\..\b.md") 应被 ".." 兜底检查拒绝, got %v`, err)
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

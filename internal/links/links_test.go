package links

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// 说明：Resolve 的路径计算刻意不依赖 filepath.IsAbs，因此 Windows 形态的
// 路径（C:/vault/a.md、//server/share）在 Linux CI 上也能得到一致结果。

func TestResolveRelative(t *testing.T) {
	cases := []struct {
		name     string
		base     string
		href     string
		wantPath string
		wantAnc  string
	}{
		{"上级两级", "/vault/notes/a/b.md", "../../文档名", "/vault/文档名", ""},
		{"上级一级", "/vault/notes/a.md", "../parent.md", "/vault/parent.md", ""},
		{"同级点斜杠", "/vault/notes/a.md", "./sibling.md", "/vault/notes/sibling.md", ""},
		{"裸文件名", "/vault/notes/a.md", "note.md", "/vault/notes/note.md", ""},
		{"子目录", "/vault/a.md", "sub/note.md", "/vault/sub/note.md", ""},
		{"百分号编码中文", "/vault/notes/a.md", "../../%E6%96%87%E6%A1%A3.md", "/文档.md", ""},
		{"标准查询锚点顺序", "/vault/a.md", "sub/b.md?x=1#sec", "/vault/sub/b.md", "sec"},
		{"锚点内的问号按规范保留", "/vault/a.md", "sub/b.md#sec?x=1", "/vault/sub/b.md", "sec?x=1"},
		{"Windows 基准上级", "C:/vault/notes/a.md", "../c.md", "C:/vault/c.md", ""},
		{"Windows 反斜杠", "C:/vault/a.md", "sub\\note.md", "C:/vault/sub/note.md", ""},
		{"file 协议本地文件", "/vault/a.md", "file:///C:/docs/x.md", "C:/docs/x.md", ""},
		{"file 协议 UNC", "/vault/a.md", "file://server/share/x.md", "//server/share/x.md", ""},
		{"越出根目录的点点", "/vault/a.md", "../../../../etc/x.md", "/etc/x.md", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Resolve(c.base, c.href)
			if err != nil {
				t.Fatalf("Resolve(%q, %q) 出错: %v", c.base, c.href, err)
			}
			if got.Path != c.wantPath {
				t.Fatalf("路径 = %q, 期望 %q", got.Path, c.wantPath)
			}
			if got.Anchor != c.wantAnc {
				t.Fatalf("锚点 = %q, 期望 %q", got.Anchor, c.wantAnc)
			}
		})
	}
}

func TestResolveErrors(t *testing.T) {
	if _, err := Resolve("/vault/a.md", ""); !errors.Is(err, ErrEmptyTarget) {
		t.Fatalf("空 href 期望 ErrEmptyTarget, 得到 %v", err)
	}
	if _, err := Resolve("", "../x.md"); !errors.Is(err, ErrNoBase) {
		t.Fatalf("未保存文档 + 相对链接期望 ErrNoBase, 得到 %v", err)
	}
	for _, href := range []string{"https://example.com", "mailto:a@b.com", "ftp://x/y", "javascript:alert(1)"} {
		if _, err := Resolve("/vault/a.md", href); !errors.Is(err, ErrNotLocal) {
			t.Fatalf("href=%q 期望 ErrNotLocal, 得到 %v", href, err)
		}
	}
}

func TestResolveAnchorOnly(t *testing.T) {
	got, err := Resolve("/vault/a.md", "#%E6%A0%87%E9%A2%98")
	if err != nil {
		t.Fatalf("纯锚点不应报错: %v", err)
	}
	if got.Path != "" || got.Kind != KindMissing {
		t.Fatalf("纯锚点应返回空路径 + missing, 得到 %+v", got)
	}
}

func TestResolveKinds(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "note.md"), "# x")
	writeFile(t, filepath.Join(dir, "plain.txt"), "x")
	writeFile(t, filepath.Join(dir, "img.png"), "\x89PNG")
	writeFile(t, filepath.Join(dir, "文档名"), "# 无扩展名的 Obsidian 风格笔记\n")
	writeFile(t, filepath.Join(dir, "bindata"), "\x00\x01\x02binary")
	if err := os.MkdirAll(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(dir, "note.md")

	cases := []struct {
		href     string
		wantKind Kind
		exists   bool
	}{
		{"note.md", KindMarkdown, true},
		{"plain.txt", KindText, true},
		{"img.png", KindOther, true},
		{"subdir", KindDir, true},
		{"missing.pdf", KindMissing, false},
		// Obsidian 约定：无扩展名链接指向同库笔记，嗅探为 UTF-8 文本后按 Markdown 归类
		{"文档名", KindMarkdown, true},
		{"bindata", KindOther, true},
	}
	for _, c := range cases {
		got, err := Resolve(base, c.href)
		if err != nil {
			t.Fatalf("Resolve(%q) 出错: %v", c.href, err)
		}
		if got.Kind != c.wantKind || got.Exists != c.exists {
			t.Fatalf("href=%q: kind=%s exists=%v, 期望 %s/%v", c.href, got.Kind, got.Exists, c.wantKind, c.exists)
		}
	}
}

func TestValidateExternalURL(t *testing.T) {
	for _, u := range []string{"https://example.com", "http://a.b/c?d=1", "mailto:a@b.com", "tel:+8613800000000"} {
		if _, err := ValidateExternalURL(u); err != nil {
			t.Fatalf("白名单 URL %q 被拒: %v", u, err)
		}
	}
	for _, u := range []string{"file:///C:/x.pdf", "javascript:alert(1)", "ftp://x/y", "data:text/html,hi", ""} {
		if _, err := ValidateExternalURL(u); !errors.Is(err, ErrSchemeNotAllowed) {
			t.Fatalf("危险 URL %q 应被拒, 得到 %v", u, err)
		}
	}
}

func TestOpenWithSystemRejectsNonFile(t *testing.T) {
	dir := t.TempDir()
	// 不存在的文件：必须被拒，且不能启动任何外部进程
	if err := OpenWithSystem(filepath.Join(dir, "nope.pdf")); !errors.Is(err, ErrNotFile) {
		t.Fatalf("不存在文件期望 ErrNotFile, 得到 %v", err)
	}
	// 目录：同样拒绝
	if err := OpenWithSystem(dir); !errors.Is(err, ErrNotFile) {
		t.Fatalf("目录期望 ErrNotFile, 得到 %v", err)
	}
	// 相对路径：拒绝（历史 bug 类：相对路径在 WebView 下基准不确定）
	if err := OpenWithSystem("rel.pdf"); !errors.Is(err, ErrNotFile) {
		t.Fatalf("相对路径期望 ErrNotFile, 得到 %v", err)
	}
}

func TestOpenWithSystemDetached(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "doc.pdf")
	writeFile(t, target, "%PDF-1.4")

	var gotName string
	var gotArgs []string
	runDetached = func(name string, args ...string) error {
		gotName, gotArgs = name, args
		return nil
	}
	t.Cleanup(func() { runDetached = defaultRunDetached }) // 恢复，避免污染后续测试

	if err := OpenWithSystem(target); err != nil {
		t.Fatalf("OpenWithSystem 出错: %v", err)
	}
	if gotName == "" || len(gotArgs) == 0 {
		t.Fatal("未调用进程启动")
	}
	if gotArgs[len(gotArgs)-1] != target {
		t.Fatalf("末位参数应为目标路径, 得到 %q", gotArgs[len(gotArgs)-1])
	}
	if runtime.GOOS != "windows" && gotName == "rundll32" {
		t.Fatalf("非 Windows 平台不该用 rundll32")
	}
}

func TestReadAssetDataURL(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "pic.png")
	writeFile(t, png, "\x89PNG\r\n\x1a\n fake")

	got, err := ReadAssetDataURL(png)
	if err != nil {
		t.Fatalf("读取图片出错: %v", err)
	}
	if !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Fatalf("data URL 前缀异常: %.40s", got)
	}

	// 非图片扩展名：拒绝
	exe := filepath.Join(dir, "a.exe")
	writeFile(t, exe, "MZ")
	if _, err := ReadAssetDataURL(exe); err == nil {
		t.Fatal("非图片类型应被拒")
	}
	// 不存在：拒绝
	if _, err := ReadAssetDataURL(filepath.Join(dir, "nope.png")); err == nil {
		t.Fatal("不存在的图片应被拒")
	}
	// 超限：拒绝（10MB 上限）
	big := filepath.Join(dir, "big.png")
	writeFile(t, big, strings.Repeat("x", MaxAssetBytes+1))
	if _, err := ReadAssetDataURL(big); err == nil {
		t.Fatal("超上限图片应被拒")
	}
}

// TestOpenWithSystemRejectsExecutable 审查 P1-4：
// "交给系统默认程序打开"对可执行类型等同于执行，Go 侧必须有硬拦截。
func TestOpenWithSystemRejectsExecutable(t *testing.T) {
	dir := t.TempDir()
	// 替换启动接缝，确保被拒时没有真的拉起外部进程
	called := false
	runDetached = func(string, ...string) error { called = true; return nil }
	t.Cleanup(func() { runDetached = defaultRunDetached })

	for _, name := range []string{"run.exe", "install.bat", "x.cmd", "s.ps1", "s.scr", "short.lnk", "a.sh", "b.app"} {
		target := filepath.Join(dir, name)
		writeFile(t, target, "fake")
		if err := OpenWithSystem(target); !errors.Is(err, ErrExecutableType) {
			t.Fatalf("%s 期望 ErrExecutableType, 得到 %v", name, err)
		}
	}
	if called {
		t.Fatal("被拒的类型不该启动任何外部进程")
	}
}

// TestNonRegularFileRejected 审查 P1-4/P1-5：
// FIFO / 设备 / 目录都必须被拒 —— 它们的 Size() 为 0，能绕过大小预检。
func TestNonRegularFileRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 POSIX FIFO")
	}
	dir := t.TempDir()
	fifo := filepath.Join(dir, "fifo.png")
	if err := mkfifo(fifo); err != nil {
		t.Skipf("无法创建 FIFO: %v", err)
	}
	for _, fn := range []func(string) error{
		func(p string) error { _, err := ReadAssetDataURL(p); return err },
		func(p string) error { return OpenWithSystem(p) },
	} {
		if err := fn(fifo); !errors.Is(err, ErrNotFile) {
			t.Fatalf("FIFO 期望 ErrNotFile, 得到 %v", err)
		}
	}
}

// TestReadAssetDataURLSVGDisabled 审查 P1-5：.svg 默认关闭，显式开启后可读。
func TestReadAssetDataURLSVGDisabled(t *testing.T) {
	dir := t.TempDir()
	svg := filepath.Join(dir, "pic.svg")
	writeFile(t, svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")

	if _, err := ReadAssetDataURL(svg); !errors.Is(err, ErrSVGDisabled) {
		t.Fatalf("默认应拒绝 svg, 得到 %v", err)
	}
	SetAllowSVG(true)
	t.Cleanup(func() { SetAllowSVG(false) })
	got, err := ReadAssetDataURL(svg)
	if err != nil {
		t.Fatalf("开启后应可读 svg: %v", err)
	}
	if !strings.HasPrefix(got, "data:image/svg+xml;base64,") {
		t.Fatalf("svg data URL 前缀异常: %.40s", got)
	}
}

// TestAllowSVG_ConcurrentReadWrite 审计 R2-G2：原子切换 .svg 支持
// 与并发读 ReadAssetDataURL 不应触发 -race 告警。
func TestAllowSVG_ConcurrentReadWrite(t *testing.T) {
	dir := t.TempDir()
	svg := filepath.Join(dir, "pic.svg")
	writeFile(t, svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")
	t.Cleanup(func() { SetAllowSVG(false) })

	const writers = 4
	const readers = 8
	const iters = 200
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(off bool) {
			defer wg.Done()
			for j := 0; j < iters; j++ {
				SetAllowSVG(off)
			}
		}(i%2 == 0)
	}
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iters; j++ {
				// 读 ReadAssetDataURL 内部读 allowSVG，与上面写并发
				_, _ = ReadAssetDataURL(svg)
			}
		}()
	}
	wg.Wait()
}

// TestResolveMalformedPath 审计 R2-G6：链接 href 百分号编码损坏时返
// ErrMalformedPath（不再静默回退原文），前端可针对性提示"URL 解析失败"。
func TestResolveMalformedPath(t *testing.T) {
	// "%E6" 是不完整的 percent encoding，PathUnescape 会失败
	_, err := Resolve("", "doc%E6%.md")
	if err == nil {
		t.Fatal("应返 ErrMalformedPath，实际为 nil")
	}
	if !errors.Is(err, ErrMalformedPath) {
		t.Fatalf("want ErrMalformedPath, got %v", err)
	}
}

// TestCheckEditable 审查 P1-9：OpenFile 的扩展名兜底。
func TestCheckEditable(t *testing.T) {
	allow := []string{
		"/vault/note.md", "/vault/note.markdown", "/vault/a.mdown",
		"/vault/data.json", "/vault/log.txt", "/vault/c.csv",
		"/vault/Obsidian 笔记", // 无扩展名（Obsidian 约定）
	}
	for _, p := range allow {
		if err := CheckEditable(p); err != nil {
			t.Fatalf("%s 应允许在编辑器打开, 得到 %v", p, err)
		}
	}
	deny := []string{
		"/home/u/.ssh/id_rsa", "/home/u/.ssh/id_ed25519",
		// v0.2.11（Y3）：新增凭据 / 历史类
		"/home/u/.ssh/id_ecdsa_sk", "/home/u/.ssh/id_ed25519_sk",
		"/home/u/.git-credentials", "/home/u/.dockercfg",
		"/home/u/.aws/credentials", "/proj/.yarnrc", "/proj/.pypirc",
		"/home/u/.zsh_history", "/home/u/.psql_history",
		"/home/u/.mysql_history", "/home/u/.python_history",
		"/home/u/.my.cnf",
		// v0.2.11（Y3）：.env 变体走前缀判定
		"/proj/.env.development", "/proj/.env.production",
		"/proj/.env.staging.local",
		"/proj/.env", "/proj/.env.local", "/home/u/.netrc",
		"/home/u/cert.pem", "/home/u/server.key", "/home/u/vault.kdbx",
		"/home/u/.bash_history",
		"/proj/main.go", "/proj/app.py", // 源码类：不在文本白名单内
	}
	for _, p := range deny {
		if err := CheckEditable(p); !errors.Is(err, ErrNotEditable) {
			t.Fatalf("%s 应被拒, 得到 %v", p, err)
		}
	}
}

// TestCheckEditable_ObsidianNoExtStillAllowed v0.2.11（审查 Y3）：
// 敏感名单扩充**不得**收紧「无扩展名放行」的 Obsidian 约定。
//
// 该约定由 links.go 注释、CHANGELOG（v0.2.6 链接重构段）、TECHNICAL.md 与
// Resolve/looksLikeText 的同一口径共同钉死，一旦误伤，会出现"链接能打开、
// 手动打开却被拒"的自相矛盾行为。这里作为反向守卫锁住。
func TestCheckEditable_ObsidianNoExtStillAllowed(t *testing.T) {
	allow := []string{
		"/vault/文档名", // 无扩展名的 Obsidian 风格笔记
		"/vault/Obsidian 笔记",
		"/vault/我的 日记 2026",
		"/vault/environment", // 不以 ".env" 开头（前缀规则不应误伤）
		"/vault/env 配置说明",    // 中文名 + 空格，前缀不匹配
		"/vault/notes/todo",  // 子目录下的无扩展名笔记
	}
	for _, p := range allow {
		if err := CheckEditable(p); err != nil {
			t.Fatalf("%s 应放行（无扩展名 Obsidian 约定被名单扩充误伤）, 得到 %v", p, err)
		}
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写入 %s 失败: %v", path, err)
	}
}

package main

// app_bindings_test.go — 链接解析 / 外链 / 本地资产 binding 的单元测试。
//
// 背景：审查发现主包覆盖率仅 66.5%，其中 ResolveLocalPath、OpenExternal、
// OpenPath、ReadLocalAsset、OpenDialog、SaveDialog 六个对前端暴露的方法
// 覆盖率为 0——它们正是"预览区点链接不白屏"这条主链路的入口，一旦回归
// 没有任何测试会报警。
//
// 约束：wailsruntime 的对话框 / 事件 / 浏览器调用在测试 ctx 下会 log.Fatal
// 终止进程，因此这些路径只验证「进入 runtime 之前」的前置校验（nil ctx、
// scheme 白名单、路径校验），不触碰真实 runtime。
//
// links.runDetached 是 links 包私有接缝，主包无法替换，故 OpenPath 只覆盖
// 在进程启动之前就返回的拒绝分支（不存在 / 目录 / 非绝对 / 可执行类型），
// 绝不真的拉起系统程序。

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"litemd/internal/fileio"
	"litemd/internal/links"
)

// ============================================================================
// ResolveLocalPath
// ============================================================================

// wantSlash 构造 ResolveLocalPath 的期望路径。
//
// links.Resolve 的输出经 toSlashes 归一（结果要喂给 WebView 与前端做路径比较，
// Windows 盘符后的反斜杠会破坏 file:// 与字符串比对），所以契约是「恒为正斜杠」。
// 测试若直接用 filepath.Join 当期望值，Windows runner 上会假失败（曾因此在 CI
// 挂掉 TestResolveLocalPath_RelativeMarkdown / _StripsQueryAndAnchor）。
func wantSlash(elem ...string) string { return filepath.ToSlash(filepath.Join(elem...)) }

func TestResolveLocalPath_RelativeMarkdown(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "note.md")
	if err := os.WriteFile(base, []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 目标不存在：Path 仍是"应该在哪"的绝对路径，Kind=missing，供前端提示
	got, err := NewApp().ResolveLocalPath(base, "./other.md")
	if err != nil {
		t.Fatalf("相对链接解析失败: %v", err)
	}
	if want := wantSlash(dir, "other.md"); got.Path != want {
		t.Fatalf("Path: got %q want %q", got.Path, want)
	}
	if got.Exists || got.Kind != string(links.KindMissing) {
		t.Fatalf("不存在的目标应 Exists=false Kind=missing，实际 %+v", got)
	}

	// 目标存在 → markdown
	if err := os.WriteFile(filepath.Join(dir, "other.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err = NewApp().ResolveLocalPath(base, "other.md")
	if err != nil {
		t.Fatalf("%v", err)
	}
	if !got.Exists || got.Kind != string(links.KindMarkdown) {
		t.Fatalf("存在的 .md 应 Exists=true Kind=markdown，实际 %+v", got)
	}
}

func TestResolveLocalPath_AnchorOnly(t *testing.T) {
	// 纯锚点：路径为空、锚点保留，前端据此做页内跳转
	got, err := NewApp().ResolveLocalPath("", "#标题")
	if err != nil {
		t.Fatalf("纯锚点不应报错: %v", err)
	}
	if got.Path != "" {
		t.Fatalf("纯锚点 Path 应为空，got %q", got.Path)
	}
	if got.Anchor != "标题" {
		t.Fatalf("Anchor: got %q want %q", got.Anchor, "标题")
	}
}

func TestResolveLocalPath_StripsQueryAndAnchor(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "note.md")
	if err := os.WriteFile(filepath.Join(dir, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := NewApp().ResolveLocalPath(base, "a.md?v=1#top")
	if err != nil {
		t.Fatalf("%v", err)
	}
	if got.Anchor != "top" {
		t.Fatalf("Anchor: got %q want top", got.Anchor)
	}
	if want := wantSlash(dir, "a.md"); got.Path != want {
		t.Fatalf("查询串应被裁掉，Path: got %q want %q", got.Path, want)
	}
}

func TestResolveLocalPath_Errors(t *testing.T) {
	a := NewApp()
	cases := []struct {
		name    string
		base    string
		href    string
		wantErr error
	}{
		{"空 href", "/tmp/note.md", "", links.ErrEmptyTarget},
		{"相对链接但文档未保存", "", "./a.md", links.ErrNoBase},
		{"http 外链", "/tmp/note.md", "https://example.com/a.md", links.ErrNotLocal},
		{"javascript 伪协议", "/tmp/note.md", "javascript:alert(1)", links.ErrNotLocal},
		{"损坏的百分号编码", "/tmp/note.md", "../%zz.md", links.ErrMalformedPath},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := a.ResolveLocalPath(c.base, c.href); !errors.Is(err, c.wantErr) {
				t.Fatalf("want %v, got %v", c.wantErr, err)
			}
		})
	}
}

// TestResolveLocalPath_MalformedPathHasCode 审计 R2-G6 引入的
// ErrMalformedPath 必须带 [code] 前缀，否则前端 errCode() 解出 null，
// 该分支退化成通用错误弹窗。
func TestResolveLocalPath_MalformedPathHasCode(t *testing.T) {
	_, err := NewApp().ResolveLocalPath("/tmp/note.md", "../%zz.md")
	if got := CodeOf(err); got != links.CodeMalformedPath {
		t.Fatalf("CodeOf: got %q want %q", got, links.CodeMalformedPath)
	}
}

// ============================================================================
// OpenExternal（只覆盖进入 runtime 之前的校验）
// ============================================================================

func TestOpenExternal_RejectsDangerousScheme(t *testing.T) {
	a := NewApp()
	for _, raw := range []string{
		"file:///etc/passwd",
		"javascript:alert(1)",
		"ftp://example.com/x",
		"data:text/html,<script>alert(1)</script>",
	} {
		t.Run(raw, func(t *testing.T) {
			if err := a.OpenExternal(raw); !errors.Is(err, links.ErrSchemeNotAllowed) {
				t.Fatalf("want ErrSchemeNotAllowed, got %v", err)
			}
		})
	}
}

// TestOpenExternal_NilCtx App 未 startup 时拒绝调用，且不 panic。
func TestOpenExternal_NilCtx(t *testing.T) {
	if err := NewApp().OpenExternal("https://example.com"); !errors.Is(err, ErrAppNotReady) {
		t.Fatalf("want ErrAppNotReady, got %v", err)
	}
}

// ============================================================================
// OpenPath（只覆盖进程启动前的拒绝分支）
// ============================================================================

func TestOpenPath_RejectsNonOpenable(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "run.sh")
	if err := os.WriteFile(script, []byte("echo hi"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	cases := []struct {
		name, path string
	}{
		{"不存在", filepath.Join(dir, "nope.pdf")},
		{"目录", dir},
		{"相对路径", "relative.png"},
		{"空路径", ""},
		{"可执行类型", script},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := a.OpenPath(c.path); err == nil {
				t.Fatalf("应被拒绝，path=%q", c.path)
			}
		})
	}
}

// TestOpenPath_RejectsExecutableBeforeSpawn 可执行类型必须在拉起系统程序
// 之前被拒——否则一个文档里的 [x](./payload.bat) 就是"运行任意程序"。
func TestOpenPath_RejectsExecutableBeforeSpawn(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a.bat", "b.exe", "c.command", "d.sh"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := NewApp().OpenPath(p); !errors.Is(err, links.ErrExecutableType) {
			t.Fatalf("%s: want ErrExecutableType, got %v", name, err)
		}
	}
}

// ============================================================================
// ReadLocalAsset
// ============================================================================

func TestReadLocalAsset_PNGDataURL(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "pic.png")
	raw := []byte("\x89PNG\r\n\x1a\n fake")
	if err := os.WriteFile(png, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := NewApp().ReadLocalAsset(png)
	if err != nil {
		t.Fatalf("%v", err)
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
	if got != want {
		t.Fatalf("data URL 不符:\n got: %q\nwant: %q", got, want)
	}
}

func TestReadLocalAsset_Rejects(t *testing.T) {
	dir := t.TempDir()
	txt := filepath.Join(dir, "note.md")
	if err := os.WriteFile(txt, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	cases := []struct {
		name, path string
	}{
		{"非图片扩展名", txt},
		{"不存在", filepath.Join(dir, "missing.png")},
		{"相对路径", "pic.png"},
		{"目录", dir},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := a.ReadLocalAsset(c.path); err == nil {
				t.Fatalf("应被拒绝，path=%q", c.path)
			}
		})
	}
}

// TestReadLocalAsset_SVGDefaultOff SVG 是带脚本能力的文档，默认必须关闭；
// 显式开启后才可读（审查 P1-5）。
func TestReadLocalAsset_SVGDefaultOff(t *testing.T) {
	dir := t.TempDir()
	svg := filepath.Join(dir, "x.svg")
	if err := os.WriteFile(svg, []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := NewApp()

	if _, err := a.ReadLocalAsset(svg); !errors.Is(err, links.ErrSVGDisabled) {
		t.Fatalf("默认应拒绝 svg，got %v", err)
	}
	links.SetAllowSVG(true)
	t.Cleanup(func() { links.SetAllowSVG(false) })
	got, err := a.ReadLocalAsset(svg)
	if err != nil {
		t.Fatalf("开启后应可读: %v", err)
	}
	if !strings.HasPrefix(got, "data:image/svg+xml;base64,") {
		t.Fatalf("svg data URL 前缀不符: %q", got)
	}
}

// ============================================================================
// 对话框 binding（只覆盖 nil ctx 前置校验）
// ============================================================================

func TestDialogs_NilCtx(t *testing.T) {
	t.Run("OpenDialog", func(t *testing.T) {
		if _, err := NewApp().OpenDialog(); !errors.Is(err, ErrAppNotReady) {
			t.Fatalf("want ErrAppNotReady, got %v", err)
		}
	})
	t.Run("SaveDialog", func(t *testing.T) {
		if _, err := NewApp().SaveDialog("a.md"); !errors.Is(err, ErrAppNotReady) {
			t.Fatalf("want ErrAppNotReady, got %v", err)
		}
	})
	t.Run("SaveFileAs", func(t *testing.T) {
		if _, err := NewApp().SaveFileAs("a.md", "x"); !errors.Is(err, ErrAppNotReady) {
			t.Fatalf("want ErrAppNotReady, got %v", err)
		}
	})
}

// ============================================================================
// 敏感文件防护（读 / 写 两侧必须同口径）
// ============================================================================

// TestSaveFile_RejectsSecretTarget 写入侧必须与读取侧同口径。
//
// 审查发现的不对称：OpenFile 有 links.CheckEditable 白名单（读不到
// id_rsa / .env），SaveFile 却只过 safeWritePath 的「绝对路径 + 非遍历」，
// 等于保留了一个"覆写任意敏感文件"的原语 —— 读取被拦、写入放行，
// 防护形同虚设。
func TestSaveFile_RejectsSecretTarget(t *testing.T) {
	dir := t.TempDir()
	a := NewApp()
	for _, name := range []string{"id_rsa", ".env", "id_ed25519", ".env.production"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("SECRET"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := a.SaveFile(p, "OVERWRITTEN", 0); !errors.Is(err, links.ErrNotEditable) {
			t.Fatalf("%s: want ErrNotEditable, got %v", name, err)
		}
		if b, err := os.ReadFile(p); err != nil || string(b) != "SECRET" {
			t.Fatalf("%s: 敏感文件被覆写，内容=%q err=%v", name, string(b), err)
		}
	}
}

// TestSaveFile_AllowsNormalMarkdown 上面的加固不能误伤正常保存路径。
func TestSaveFile_AllowsNormalMarkdown(t *testing.T) {
	dir := t.TempDir()
	a := NewApp()
	for _, name := range []string{"note.md", "note.markdown", "draft.txt", "README"} {
		p := filepath.Join(dir, name)
		if _, err := a.SaveFile(p, "hello", 0); err != nil {
			t.Fatalf("%s 应可保存，got %v", name, err)
		}
	}
}

// TestOpenFile_RejectsSymlinkToSecret CheckEditable 只按路径字符串判定，
// 一个名为 note.md 却指向 ~/.ssh/id_rsa 的软链能绕过读取白名单。
// 修复后对解析出的真实目标再判一次；用户用软链组织笔记库
// （note.md -> 真实笔记.md）不受影响，因为真实目标仍是 Markdown。
func TestOpenFile_RejectsSymlinkToSecret(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "id_rsa")
	if err := os.WriteFile(secret, []byte("PRIVATE KEY"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "note.md")
	if err := os.Symlink(secret, link); err != nil {
		t.Skip("当前文件系统不支持符号链接")
	}
	if _, err := NewApp().OpenFile(link); !errors.Is(err, links.ErrNotEditable) {
		t.Fatalf("软链绕过了读取白名单，读到私钥内容；want ErrNotEditable, got %v", err)
	}
}

// TestOpenFile_AllowsSymlinkToMarkdown 软链指向真实笔记时必须照常打开
// （用户刻意用软链组织笔记库的用法不能被上面的加固打断）。
func TestOpenFile_AllowsSymlinkToMarkdown(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.md")
	if err := os.WriteFile(real, []byte("# note"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "alias.md")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("当前文件系统不支持符号链接")
	}
	got, err := NewApp().OpenFile(link)
	if err != nil {
		t.Fatalf("软链指向真实笔记应放行，got %v", err)
	}
	if got.Content != "# note" {
		t.Fatalf("内容不符: %q", got.Content)
	}
}

// TestCopyImageAsset_RejectsNonEditableBase 资产写入的目录由 baseFile 推导，
// 若锚点不做校验，"<任意绝对路径>/assets/" 都会成为合法落点。这里要求锚点
// 与 OpenFile 同口径（可编辑文本文件）。
func TestCopyImageAsset_RejectsNonEditableBase(t *testing.T) {
	dir := t.TempDir()
	a := NewApp()
	// 1x1 png 的最小合法 base64（内容不校验，够触发写入路径即可）
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

	for _, name := range []string{"id_rsa", ".env"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("SECRET"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := a.CopyImageAsset(p, "x.png", png); !errors.Is(err, links.ErrNotEditable) {
			t.Fatalf("%s 锚点应被拒: %v", name, err)
		}
		if _, statErr := os.Stat(filepath.Join(dir, "assets")); !os.IsNotExist(statErr) {
			t.Fatalf("%s 锚点不应产生 assets 目录", name)
		}
	}
	// 正常锚点仍可写入
	doc := filepath.Join(dir, "note.md")
	if err := os.WriteFile(doc, []byte("#"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := a.CopyImageAsset(doc, "x.png", png)
	if err != nil {
		t.Fatalf("Markdown 锚点应放行: %v", err)
	}
	if want := filepath.Join(dir, "assets", "x.png"); got != want {
		t.Fatalf("落点: got %q want %q", got, want)
	}
}

// ============================================================================
// 错误码契约
// ============================================================================

// TestErrorCodeContract_AllSentinels 钉死「所有对外哨兵都带 [code] 前缀且
// CodeOf 可解出」这条契约。新增哨兵忘了加前缀时，前端 errCode() 返回 null，
// 对应分支静默退化——本测试让它在 CI 阶段立刻失败。
func TestErrorCodeContract_AllSentinels(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code string
	}{
		{"fileio.ErrNotFound", fileio.ErrNotFound, fileio.CodeNotFound},
		{"fileio.ErrIsBinary", fileio.ErrIsBinary, fileio.CodeIsBinary},
		{"fileio.ErrTooLarge", fileio.ErrTooLarge, fileio.CodeTooLarge},
		{"fileio.ErrNotRegular", fileio.ErrNotRegular, fileio.CodeNotRegular},
		{"fileio.ErrExternalModified", fileio.ErrExternalModified, fileio.CodeExternalModified},
		{"fileio.ErrInvalidAsset", fileio.ErrInvalidAsset, fileio.CodeInvalidAsset},
		{"links.ErrEmptyTarget", links.ErrEmptyTarget, links.CodeEmptyTarget},
		{"links.ErrNoBase", links.ErrNoBase, links.CodeNoBase},
		{"links.ErrNotLocal", links.ErrNotLocal, links.CodeNotLocal},
		{"links.ErrNotFile", links.ErrNotFile, links.CodeNotFile},
		{"links.ErrNotEditable", links.ErrNotEditable, links.CodeNotEditable},
		{"links.ErrMalformedPath", links.ErrMalformedPath, links.CodeMalformedPath},
		{"links.ErrSVGDisabled", links.ErrSVGDisabled, links.CodeSVGDisabled},
		{"ErrEmptyPath", ErrEmptyPath, CodeEmptyPath},
		{"ErrAppNotReady", ErrAppNotReady, CodeAppNotReady},
		{"ErrEmptyImageData", ErrEmptyImageData, CodeEmptyImageData},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !strings.HasPrefix(c.err.Error(), "["+c.code+"]") {
				t.Fatalf("哨兵缺少 [%s] 前缀: %q", c.code, c.err.Error())
			}
			if got := CodeOf(c.err); got != c.code {
				t.Fatalf("CodeOf: got %q want %q", got, c.code)
			}
		})
	}
}

// TestAppInfo_VersionMatchesConst 前端顶部与打包脚本都以 AppVersion 为事实源，
// 这里钉死 binding 返回的正是它（防有人改了常量忘了改返回值）。
func TestAppInfo_VersionMatchesConst(t *testing.T) {
	info := NewApp().AppInfo()
	if info.Version != AppVersion {
		t.Fatalf("AppInfo.Version: got %q want %q", info.Version, AppVersion)
	}
	if info.Name != "LiteMD" {
		t.Fatalf("AppInfo.Name: got %q", info.Name)
	}
	// 版本号必须是 x.y.z 形态（打包脚本按此解析）
	parts := strings.Split(info.Version, ".")
	if len(parts) != 3 {
		t.Fatalf("版本号形态不符 x.y.z: %q", info.Version)
	}
}

// ============================================================================
// navGuard 补充
// ============================================================================

// serveNavGuard 用恒返 404 的下游跑一次 navGuard，返回记录结果。
func serveNavGuard(method, path string) *httptest.ResponseRecorder {
	h := navGuard(http.NotFoundHandler())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

// TestNavGuard_RedirectTargetIsEscaped 重定向目标携带原路径但必须编码：
// 未编码时含 & / ? / 空格的路径会污染首页的 query 串，前端取到的
// nav 参数与实际链接不符。
func TestNavGuard_RedirectTargetIsEscaped(t *testing.T) {
	rec := serveNavGuard(http.MethodGet, "/a%20b.md?x=1&y=2")
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "/?nav=") {
		t.Fatalf("应重定向到 /?nav=，got %q", loc)
	}
	// 原路径整段被编码进单个 nav 参数：不能再出现裸的 & / 空格
	raw := strings.TrimPrefix(loc, "/?nav=")
	if strings.ContainsAny(raw, " &") {
		t.Fatalf("nav 参数未正确编码: %q", raw)
	}
	if got := strings.TrimSpace(raw); got == "" {
		t.Fatalf("nav 参数为空: %q", loc)
	}
}

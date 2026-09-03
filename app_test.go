package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"litemd/internal/config"
	"litemd/internal/fileio"
	"litemd/internal/links"
)

// 注意：本文件测试 App 的 binding 方法。
// 由于 binding 直接调用 fileio/config 包，stub 不需要外部依赖，
// 但 ctx 是 nil 时部分方法会失败，正好可以借此验证 nil 安全。

// TestErrorTextContractForFrontend 钉死前端 main.ts 依赖的 Go 错误文案。
//
// Wails v2 把 binding error 序列化为字符串传到前端，前端无法 errors.Is，
// 只能对 message 做子串匹配（保存冲突检测、未保存引导等分支依赖此）。
// Go 侧任何人改写这些 sentinel 文案，前端对应功能会静默退化为通用错误
// 弹窗——本测试让这类改动在 CI 阶段立刻失败，而不是等到用户报障。
//
// 审计 R2-F1：error 文案改为 `[code] message` 形态，前端经 errCode 解
// 析后做精确 switch；本测试同时钉死 code 字段，确保前端切到错误码后
// 后端改 code 也立刻暴露。
func TestErrorTextContractForFrontend(t *testing.T) {
	cases := []struct {
		name    string
		got     error
		want    string // 全文：必须 == "[code] message"
		wantCode string // 错误码：必须 == 紧跟 [ 后到 ] 前的部分
	}{
		{"ErrExternalModified（保存冲突检测）", fileio.ErrExternalModified, "[" + fileio.CodeExternalModified + "] file modified by another program", fileio.CodeExternalModified},
		{"ErrNoBase（未保存文档引导）", links.ErrNoBase, "[" + links.CodeNoBase + "] base file path is empty", links.CodeNoBase},
		{"ErrNotLocal（外链兜底分流）", links.ErrNotLocal, "[" + links.CodeNotLocal + "] link target is not a local path", links.CodeNotLocal},
		// 审计 R2-G9：提为 package-level 哨兵后，钉死字符串 + 配套断言
		// errors.Is 双保险。前端 main.ts includes("empty") / includes("app not ready")
		// 分支依赖这些文案。
		{"ErrEmptyPath（空路径）", ErrEmptyPath, "[" + CodeEmptyPath + "] path is empty", CodeEmptyPath},
		{"ErrAppNotReady（ctx 未就绪）", ErrAppNotReady, "[" + CodeAppNotReady + "] app not ready", CodeAppNotReady},
		{"ErrEmptyImageData（空 base64）", ErrEmptyImageData, "[" + CodeEmptyImageData + "] base64 data is empty", CodeEmptyImageData},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.got.Error() != c.want {
				t.Fatalf("错误文案被修改，前端 main.ts 的子串匹配将失效：\n  got:  %q\n  want: %q", c.got.Error(), c.want)
			}
			if got := CodeOf(c.got); got != c.wantCode {
				t.Fatalf("错误码被修改，前端 errCode 切换会失效：\n  got:  %q\n  want: %q", got, c.wantCode)
			}
		})
	}
}

// TestErrorCodeOf_Wrapped 审计 R2-F1：错误码穿透 wrap 链。SaveFile 实际
// 返回的 err 是 fmt.Errorf("%w: %s (disk %d, expected %d)", ErrExternalModified, ...)，
// 必须能从 wrap 后的错误反解出 code。
func TestErrorCodeOf_Wrapped(t *testing.T) {
	wrapped := fmt.Errorf("%w: /tmp/x.md (disk 100, expected 50)", fileio.ErrExternalModified)
	if got := CodeOf(wrapped); got != fileio.CodeExternalModified {
		t.Fatalf("wrap 后 code 解析失败：got=%q want=%q", got, fileio.CodeExternalModified)
	}
	// 多层 wrap 也要穿透
	doubled := fmt.Errorf("save failed: %w", wrapped)
	if got := CodeOf(doubled); got != fileio.CodeExternalModified {
		t.Fatalf("双层 wrap 后 code 解析失败：got=%q", got)
	}
	// 无码错误返回空串
	plain := errors.New("just a plain error")
	if got := CodeOf(plain); got != "" {
		t.Fatalf("无码错误应返空串，got=%q", got)
	}
	if got := CodeOf(nil); got != "" {
		t.Fatalf("nil err 应返空串，got=%q", got)
	}
}

func TestAppOpenFile_NotFound(t *testing.T) {
	a := NewApp()
	_, err := a.OpenFile(filepath.Join(t.TempDir(), "missing.md"))
	if !errors.Is(err, fileio.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestAppOpenFile_EmptyPath(t *testing.T) {
	a := NewApp()
	_, err := a.OpenFile("")
	if !errors.Is(err, ErrEmptyPath) {
		t.Fatalf("want ErrEmptyPath, got %v", err)
	}
}

func TestAppOpenFile_HappyPath(t *testing.T) {
	a := NewApp()
	p := filepath.Join(t.TempDir(), "ok.md")
	if err := fileio.WriteText(p, "# hi\n"); err != nil {
		t.Fatal(err)
	}
	out, err := a.OpenFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if out.Content != "# hi\n" {
		t.Fatalf("content mismatch: %q", out.Content)
	}
	if !strings.HasSuffix(out.Path, "ok.md") {
		t.Fatalf("abs path odd: %q", out.Path)
	}
}

func TestAppSaveFile_HappyPath(t *testing.T) {
	a := NewApp()
	p := filepath.Join(t.TempDir(), "save.md")
	if _, err := a.SaveFile(p, "abc", 0); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if string(got) != "abc" {
		t.Fatalf("want abc got %q", got)
	}
}

func TestAppSaveFile_EmptyPath(t *testing.T) {
	a := NewApp()
	_, err := a.SaveFile("", "x", 0)
	if !errors.Is(err, ErrEmptyPath) {
		t.Fatalf("want ErrEmptyPath, got %v", err)
	}
}

func TestAppGetSetConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := NewApp()
	cfg, err := a.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Theme = "dark"
	cfg.FontSize = 20
	if err := a.SetConfig(cfg); err != nil {
		t.Fatal(err)
	}
	got, err := a.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Theme != "dark" || got.FontSize != 20 {
		t.Fatalf("config not persisted: %+v", got)
	}
}

func TestAppPushRecent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := NewApp()
	cfg, err := a.PushRecent("/a.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.RecentFiles) != 1 || cfg.RecentFiles[0] != "/a.md" {
		t.Fatalf("want [/a.md], got %+v", cfg.RecentFiles)
	}
	// 再推一次，去重
	cfg, err = a.PushRecent("/a.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.RecentFiles) != 1 {
		t.Fatalf("dedup failed: %+v", cfg.RecentFiles)
	}
}

func TestAppInfo(t *testing.T) {
	a := NewApp()
	info := a.AppInfo()
	if info.Name != "LiteMD" {
		t.Fatalf("name mismatch: %+v", info)
	}
}

// SaveFileAs 在 Wails ctx 未注入时（早期 IPC 不可用）必须按"app not ready"契约返回。
// 契约要求两条都满足才视为通过：
//   1. err 必须非空；
//   2. err 必须显式提示 ctx 不可用（"app not ready"）。
// 之前实现塞了 `t.Logf; return` 把"任何 err"都判通过——这是恒过测试，
// 任何错误的破坏（路径校验错 / I/O 错 / Wails API 签名变更）都不会被发现。
func TestAppSaveFileAs_NilCtxSafe(t *testing.T) {
	a := NewApp()
	gotPath, err := a.SaveFileAs("hello.md", "abc")
	if err == nil {
		t.Fatalf("nil ctx 下 SaveFileAs 应返回 err，实际为 nil（gotPath=%q）——契约破坏", gotPath)
	}
	if gotPath != "" {
		t.Fatalf("nil ctx 下 gotPath 必须为空字符串，实际为 %q", gotPath)
	}
	if !strings.Contains(err.Error(), "app not ready") {
		t.Fatalf("err 必须含 \"app not ready\"，实际为 %q——ctx 检查可能已被旁路", err.Error())
	}
}

// ============================================================================
// T9 修复：补 PushRecent happy-path + 去重 + 持久化读回 集成测试
// （不依赖 Wails runtime，只要 HOME 隔离，纯 store 层面即可验证）

func TestAppPushRecent_HappyPath_PersistAndDedup(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := NewApp()

	// 1) 连续推入 3 个文件
	cfg1, err := a.PushRecent("/docs/a.md")
	if err != nil {
		t.Fatalf("PushRecent a: %v", err)
	}
	if len(cfg1.RecentFiles) != 1 || cfg1.RecentFiles[0] != "/docs/a.md" {
		t.Fatalf("after push 1: RecentFiles=%+v", cfg1.RecentFiles)
	}
	_, _ = a.PushRecent("/docs/b.md")
	cfg3, _ := a.PushRecent("/docs/c.md")
	if !reflect.DeepEqual(cfg3.RecentFiles, []string{"/docs/c.md", "/docs/b.md", "/docs/a.md"}) {
		t.Fatalf("after 3 pushes: RecentFiles=%+v", cfg3.RecentFiles)
	}

	// 2) 推入重复项（/docs/b.md）——应被移到最前（去重 + LRU）
	cfg4, err := a.PushRecent("/docs/b.md")
	if err != nil {
		t.Fatalf("PushRecent dup: %v", err)
	}
	if !reflect.DeepEqual(cfg4.RecentFiles, []string{"/docs/b.md", "/docs/c.md", "/docs/a.md"}) {
		t.Fatalf("after dedup push: RecentFiles=%+v", cfg4.RecentFiles)
	}

	// 3) 持久化后读回（跨 App 实例，验证真的写盘了）
	a2 := NewApp()
	cfgBack, err := a2.store.Load()
	if err != nil {
		t.Fatalf("Load after PushRecent failed: %v", err)
	}
	if !reflect.DeepEqual(cfgBack.RecentFiles, cfg4.RecentFiles) {
		t.Fatalf("读回 RecentFiles 不一致:\n got=%+v\nwant=%+v", cfgBack.RecentFiles, cfg4.RecentFiles)
	}
}

// T9 附加：PushRecent 推入 15 个 → 只保留最近 10 条（config.PushRecent 的 limit 参数）
func TestAppPushRecent_Limit10(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := NewApp()
	var lastCfg config.Config
	var err error
	for i := 0; i < 15; i++ {
		// 双位十进制填充：i>=10 时旧实现 string(rune('0'+i)) 会产出 ':;' 等
		// 字符（unicode '.'/'/'/'0'+10 之后），导致断言"前 5 条被挤掉"
		// 在没有 SetEnv HOME 的隔离下仍可能因路径不可比而误判。
		p := filepath.Join("/notes", fmt.Sprintf("n%02d.md", i))
		lastCfg, err = a.PushRecent(p)
		if err != nil {
			t.Fatalf("push %d: %v", i, err)
		}
	}
	if len(lastCfg.RecentFiles) != 10 {
		t.Fatalf("limit=10 got len=%d  list=%+v", len(lastCfg.RecentFiles), lastCfg.RecentFiles)
	}
	// 最新的一条应是 i=14 推入的 n14.md（去重 + LRU 后置顶）
	first := lastCfg.RecentFiles[0]
	if first != "/notes/n14.md" {
		t.Fatalf("first recent 期望 /notes/n14.md，实际为 %q（去重/LRU 顺序错）", first)
	}
	// 最旧的那条应是 i=5 的 n05.md（前 5 条 i=0..4 应被挤出）
	last := lastCfg.RecentFiles[len(lastCfg.RecentFiles)-1]
	if last != "/notes/n05.md" {
		t.Fatalf("last recent 期望 /notes/n05.md，实际为 %q（limit=10 边界错）", last)
	}
}

// TestOnFileOpen_PushAndNotify 验证 macOS Finder 双击路径：
//  1. 合法 .md 路径入 startupFiles 队 + 发出 litemd:openExternalFile 事件
//  2. 非 Markdown 后缀 / 不存在 / 空路径被 extractStartupFiles 滤掉，不入队
//  3. "回调先于 startup"的真实场景：pendingNotify 置位 + startup 后 flush 补发
//
// 复用 emitEvent 接缝（与 OnSecondInstanceLaunch 测试同套路），无需启动 wails。
func TestOnFileOpen_PushAndNotify(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	mdPath := filepath.Join(dir, "clicked.md")
	if err := os.WriteFile(mdPath, []byte("hello"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	// 审计 R2-G3：把非 Markdown 后缀的真实文件落盘，让
	// extractStartupFiles 经「存在 + 常规文件 + 扩展名白名单」三道关
	// 才能拒掉；之前 fixture 不落盘让测试"恒过"。
	badPath := filepath.Join(dir, "clicked.exe")
	if err := os.WriteFile(badPath, []byte("not really an exe"), 0o644); err != nil {
		t.Fatalf("write bad fixture: %v", err)
	}

	t.Run("合法 .md 路径：入队 + startup 后补发事件", func(t *testing.T) {
		a := NewApp()
		// 替换 emitEvent 接缝
		var calls int
		emitEvent = func(_ context.Context, _ string) { calls++ }
		t.Cleanup(func() { emitEvent = defaultEmitEvent })

		// 1) OnFileOpen 在 startup 之前到达（真实 macOS 启动序列）
		files := extractStartupFiles([]string{mdPath})
		if len(files) != 1 {
			t.Fatalf("extractStartupFiles 滤掉了合法路径：files=%v", files)
		}
		for _, p := range files {
			a.startupFiles.push(p)
		}
		a.notifyExternalOpen() // ctx==nil → pendingNotify=true，不发事件
		if calls != 0 {
			t.Fatalf("ctx==nil 时不应发事件，实际 calls=%d", calls)
		}
		a.ctxMu.RLock()
		if !a.pendingNotify {
			a.ctxMu.RUnlock()
			t.Fatal("预期 pendingNotify=true（startup 前的补发位）")
		}
		a.ctxMu.RUnlock()

		// 2) startup 注入 ctx → flushPendingNotify 应补发一次事件
		a.startup(context.Background())
		if calls != 1 {
			t.Fatalf("startup 后预期补发 1 次，实际 calls=%d", calls)
		}
		// 路径在队列里仍可被 ConsumeStartupFile 取到
		if got := a.startupFiles.pop(); got != mdPath {
			t.Fatalf("队首 = %q, want %q", got, mdPath)
		}
	})

	t.Run("非 Markdown 后缀：被 extractStartupFiles 拒，不入队", func(t *testing.T) {
		a := NewApp()
		var calls int
		emitEvent = func(_ context.Context, _ string) { calls++ }
		t.Cleanup(func() { emitEvent = defaultEmitEvent })

		// 文件已落盘（见 fixture），存在 + 常规文件检查会放行；扩展名
		// 才是真正拒它的关。
		files := extractStartupFiles([]string{badPath})
		if len(files) != 0 {
			t.Fatalf("非 Markdown 路径应被扩展名白名单拒，实际 files=%v", files)
		}
		// 不调用 notifyExternalOpen（与 main.go 的 OnFileOpen 行为一致）
		a.startup(context.Background())
		if calls != 0 {
			t.Fatalf("拒绝路径不应触发事件，calls=%d", calls)
		}
		if got := a.startupFiles.pop(); got != "" {
			t.Fatalf("队首 = %q, want 空（拒绝路径不入队）", got)
		}
	})

	t.Run("空路径：被拒", func(t *testing.T) {
		files := extractStartupFiles([]string{""})
		if len(files) != 0 {
			t.Fatalf("空路径应被拒，实际 files=%v", files)
		}
	})
}

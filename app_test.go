package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"litemd/internal/config"
	"litemd/internal/fileio"
)

// 注意：本文件测试 App 的 binding 方法。
// 由于 binding 直接调用 fileio/config 包，stub 不需要外部依赖，
// 但 ctx 是 nil 时部分方法会失败，正好可以借此验证 nil 安全。

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
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("want empty-path error, got %v", err)
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
	if _, err := a.SaveFile("", "x", 0); err == nil {
		t.Fatal("want error")
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

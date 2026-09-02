package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestStoreLoadDefault(t *testing.T) {
	// 临时 HOME 目录避免污染真实用户配置
	t.Setenv("HOME", t.TempDir())
	s := NewStore()
	cfg, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	def := Default()
	if cfg.Theme != def.Theme || cfg.FontSize != def.FontSize {
		t.Fatalf("not default: %+v", cfg)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()
	in := Default()
	in.Theme = "dark"
	in.FontSize = 18
	in.RecentFiles = []string{"/tmp/a.md", "/tmp/b.md"}
	if err := s.Save(in); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Theme != "dark" || got.FontSize != 18 || len(got.RecentFiles) != 2 {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}
}

func TestPathCreatesDir(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()
	p, err := s.Path()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(p)); err != nil {
		t.Fatalf("cfg dir not created: %v", err)
	}
}

func TestSaveAtomicNoLeftover(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()
	if err := s.Save(Default()); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Path()
	dir := filepath.Dir(p)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") && strings.HasSuffix(name, ".tmp") {
			t.Fatalf("leftover tmp: %s", name)
		}
	}
}

func TestDefaultJSONEncodable(t *testing.T) {
	data, err := json.Marshal(Default())
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 {
		t.Fatal("empty marshal")
	}
}

func TestPushRecent_DedupAndLimit(t *testing.T) {
	cfg := Default()
	cfg.RecentFiles = []string{"/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h", "/i"}
	cfg = PushRecent(cfg, "/b", 10) // 已有 → 移到首位
	if len(cfg.RecentFiles) != 9 || cfg.RecentFiles[0] != "/b" {
		t.Fatalf("dedup wrong: %+v", cfg.RecentFiles)
	}
	cfg = PushRecent(cfg, "/z", 5) // 新增 → 截断
	if len(cfg.RecentFiles) != 5 || cfg.RecentFiles[0] != "/z" {
		t.Fatalf("limit wrong: %+v", cfg.RecentFiles)
	}
}

func TestLoadCorruptJSONFallsBackToDefault(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()
	p, err := s.Path()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("not json {{{"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := s.Load()
	if err == nil {
		t.Fatal("want error from corrupt json")
	}
	// T10 修复：用 reflect.DeepEqual 与 Default() 全字段比较，
	// 避免之前只比较 Theme 漏检 FontFamily/FontSize/WindowSize/RecentFiles 等被污染的情况。
	want := Default()
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("fallback to default failed:\n got=%+v\nwant=%+v", cfg, want)
	}
}

// TestStoreMutate_Concurrent 是 #5 修复的回归守卫：Mutate 在锁内完成
// 读-改-写全序列，并发推入不丢更新。旧版（Load/Save 分离）在相同负载下
// 最终列表会少于推送的不重复路径数（后写者覆盖前写者）。
func TestStoreMutate_Concurrent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()

	const workers, each = 8, 12 // 96 个不重复路径，上限设 200 避免截断干扰断言
	seen := make(map[string]bool, workers*each)
	for w := 0; w < workers; w++ {
		for i := 0; i < each; i++ {
			seen[pathFor(w, i)] = true
		}
	}

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				if _, err := s.Mutate(func(c Config) Config {
					return PushRecent(c, pathFor(w, i), workers*each+10)
				}); err != nil {
					t.Errorf("mutate %s: %v", pathFor(w, i), err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RecentFiles) != len(seen) {
		t.Fatalf("丢失更新: got %d 条, want %d 条（Mutate 未保证读改写原子）\n%+v",
			len(got.RecentFiles), len(seen), got.RecentFiles)
	}
	for _, p := range got.RecentFiles {
		if !seen[p] {
			t.Fatalf("出现未知路径 %q", p)
		}
	}
}

// TestStoreMutate_HealsCorruptedConfig 是审查 🟡-4 的回归守卫：
// config.json 损坏后 Mutate 应以 Default 继续（而非中断），
// 落盘覆盖损坏文件；下一次 Load 读到合法 JSON。
func TestStoreMutate_HealsCorruptedConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()
	p, err := s.Path()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("not json {{{"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := s.Mutate(func(c Config) Config {
		return PushRecent(c, "/healed/a.md", 10)
	})
	if err != nil {
		t.Fatalf("mutate on corrupted config should self-heal, got err: %v", err)
	}
	if len(cfg.RecentFiles) != 1 || cfg.RecentFiles[0] != "/healed/a.md" {
		t.Fatalf("mutate result wrong: %+v", cfg.RecentFiles)
	}
	// 落盘后文件应已被合法 JSON 覆盖
	if _, err := s.Load(); err != nil {
		t.Fatalf("config should be healed after mutate: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RecentFiles) != 1 || got.RecentFiles[0] != "/healed/a.md" {
		t.Fatalf("healed config lost the mutation: %+v", got.RecentFiles)
	}
}

func pathFor(w, i int) string {
	return "/notes/w" + strconv.Itoa(w) + "-f" + strconv.Itoa(i) + ".md"
}

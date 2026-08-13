package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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


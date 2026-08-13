package updater

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseSemver(t *testing.T) {
	cases := []struct {
		in   string
		maj  int
		min  int
		pat  int
		pre  string
		isOk bool
	}{
		{"v1.2.3", 1, 2, 3, "", true},
		{"0.10.0", 0, 10, 0, "", true},
		{"1.2.3-rc1", 1, 2, 3, "rc1", true},
		{"1.2.3+build.1", 1, 2, 3, "", true},
		{"v0.2.0", 0, 2, 0, "", true},
		{"abc", 0, 0, 0, "", false},
		// 两段式版本号：patch 缺失视为 0（GitHub 常见 v1.0 风格 tag）
		{"v1.0", 1, 0, 0, "", true},
		{"1.2", 1, 2, 0, "", true},
		{"v2", 0, 0, 0, "", false}, // 单段仍非法
	}
	for _, c := range cases {
		maj, min, pat, pre, err := parseSemver(c.in)
		if c.isOk && err != nil {
			t.Errorf("parseSemver(%q) unexpected err: %v", c.in, err)
			continue
		}
		if !c.isOk && err == nil {
			t.Errorf("parseSemver(%q) expected err, got nil", c.in)
			continue
		}
		if maj != c.maj || min != c.min || pat != c.pat || pre != c.pre {
			t.Errorf("parseSemver(%q) = (%d,%d,%d,%q), want (%d,%d,%d,%q)", c.in, maj, min, pat, pre, c.maj, c.min, c.pat, c.pre)
		}
	}
}

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v1.0.0", "v0.9.0", true},
		{"v1.0.0", "v1.0.0", false},
		{"v1.0.0", "v1.0.1", false},
		{"v0.2.0", "v0.2.0", false},
		{"v0.2.0", "v0.1.0", true},
		// B11 修复：正式版 > 预发布版（同版本号）
		{"v0.2.0", "v0.2.0-rc1", true},
		{"v0.2.0-rc1", "v0.2.0", false},
		{"v0.2.0-rc2", "v0.2.0-rc1", true}, // 同为预发布，字典序比较
		{"0.10.0", "0.9.5", true},
		// 两段式版本号（GitHub v1.0 tag）应能正确比较
		{"v1.0", "v0.2.0", true},
		{"v1.0", "v1.0", false},
	}
	for _, c := range cases {
		got, err := IsNewer(c.latest, c.current)
		if err != nil {
			t.Errorf("IsNewer(%q,%q) err: %v", c.latest, c.current, err)
			continue
		}
		if got != c.want {
			t.Errorf("IsNewer(%q,%q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestPickWindowsAsset(t *testing.T) {
	release := map[string]any{
		"assets": []any{
			map[string]any{"name": "LiteMD-Setup-v1.0.0.exe", "browser_download_url": "https://x/setup.exe"},
			map[string]any{"name": "LiteMD-source-v1.0.0.tar.gz", "browser_download_url": "https://x/src.tar.gz"},
			map[string]any{"name": "SHA256SUMS-v1.0.0.txt", "browser_download_url": "https://x/sha.txt"},
		},
	}
	url := pickWindowsAsset(release)
	if url != "https://x/setup.exe" {
		t.Errorf("pickWindowsAsset setup = %q", url)
	}
}

func TestPickWindowsAsset_Fallback(t *testing.T) {
	release := map[string]any{
		"assets": []any{
			map[string]any{"name": "LiteMD.exe", "browser_download_url": "https://x/lite.exe"},
		},
	}
	url := pickWindowsAsset(release)
	if url != "https://x/lite.exe" {
		t.Errorf("pickWindowsAsset fallback = %q", url)
	}
}

func TestPickWindowsAsset_Empty(t *testing.T) {
	url := pickWindowsAsset(map[string]any{})
	if url != "" {
		t.Errorf("pickWindowsAsset empty = %q, want empty", url)
	}
}

// B13 修复验证：放宽匹配 — 支持 LiteMD-Pro-Setup / LiteMD-Enterprise-Setup 等变体，
// 且不会误匹配 source tarball。同时 fallback 支持 portable.exe 等变体。
func TestPickWindowsAsset_LooseMatch(t *testing.T) {
	release := map[string]any{
		"assets": []any{
			map[string]any{
				"name":                 "LiteMD-source-v1.0.0.tar.gz",
				"browser_download_url": "https://x/src.tar.gz",
			},
			map[string]any{
				"name":                 "SHA256SUMS-v1.0.0.txt",
				"browser_download_url": "https://x/sums.txt",
			},
			map[string]any{
				"name":                 "LiteMD-Pro-Setup-v1.0.0.exe",
				"browser_download_url": "https://x/pro-setup.exe",
			},
			map[string]any{
				"name":                 "LiteMD-portable.exe",
				"browser_download_url": "https://x/portable.exe",
			},
		},
	}
	// 应优先选择 Setup
	if got := pickWindowsAsset(release); got != "https://x/pro-setup.exe" {
		t.Errorf("LooseMatch pick = %q, want pro-setup.exe", got)
	}
	// 去掉 Setup，fallback 到 portable.exe
	release2 := map[string]any{
		"assets": []any{
			map[string]any{
				"name":                 "LiteMD-source-v1.0.0.tar.gz",
				"browser_download_url": "https://x/src.tar.gz",
			},
			map[string]any{
				"name":                 "LiteMD-portable.exe",
				"browser_download_url": "https://x/portable.exe",
			},
		},
	}
	if got := pickWindowsAsset(release2); got != "https://x/portable.exe" {
		t.Errorf("LooseMatch fallback = %q, want portable.exe", got)
	}
	// 只有 source tarball — 返回空（不应误匹配 source）
	release3 := map[string]any{
		"assets": []any{
			map[string]any{
				"name":                 "LiteMD-source-v1.0.0.exe",
				"browser_download_url": "https://x/src.exe",
			},
		},
	}
	if got := pickWindowsAsset(release3); got != "" {
		t.Errorf("source exe should NOT match, got %q", got)
	}
}

// TestFetchLatest_Success 修复 B9/T1：真实调用 FetchLatest 走 mock server 路径。
func TestFetchLatest_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write([]byte(`{
			"tag_name": "v0.5.0",
			"name": "Release 0.5.0",
			"html_url": "https://github.com/litemd/litemd/releases/tag/v0.5.0",
			"published_at": "2026-08-12T10:00:00Z",
			"prerelease": false,
			"assets": [
				{"name": "LiteMD-Setup-v0.5.0.exe", "browser_download_url": "https://x/setup.exe"}
			]
		}`))
	}))
	defer srv.Close()

	// 临时替换 fetchBaseURL 指向 mock server
	oldURL := fetchBaseURL
	fetchBaseURL = srv.URL + "/repos/%s/releases/latest"
	defer func() { fetchBaseURL = oldURL }()

	info, err := FetchLatest(2 * time.Second)
	if err != nil {
		t.Fatalf("FetchLatest failed: %v", err)
	}
	if info.TagName != "v0.5.0" {
		t.Errorf("TagName = %q, want v0.5.0", info.TagName)
	}
	if info.Name != "Release 0.5.0" {
		t.Errorf("Name = %q", info.Name)
	}
	if info.HTMLURL != "https://github.com/litemd/litemd/releases/tag/v0.5.0" {
		t.Errorf("HTMLURL = %q", info.HTMLURL)
	}
	if info.Prerelease != false {
		t.Errorf("Prerelease = %v", info.Prerelease)
	}
	if info.AssetURL != "https://x/setup.exe" {
		t.Errorf("AssetURL = %q, want https://x/setup.exe", info.AssetURL)
	}
	if info.PublishedAt.IsZero() {
		t.Errorf("PublishedAt not parsed")
	}
}

// TestFetchLatest_404 覆盖 404 错误路径（mock server 返回 404）。
func TestFetchLatest_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"message": "Not Found"}`))
	}))
	defer srv.Close()

	oldURL := fetchBaseURL
	fetchBaseURL = srv.URL + "/repos/%s/releases/latest"
	defer func() { fetchBaseURL = oldURL }()

	_, err := FetchLatest(2 * time.Second)
	if err == nil {
		t.Fatal("expected error on 404")
	}
	if !strings.Contains(err.Error(), "no releases found") {
		t.Errorf("err = %v, want contains 'no releases found'", err)
	}
}

// TestFetchLatest_500 覆盖 5xx 错误路径。
func TestFetchLatest_500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`server error`))
	}))
	defer srv.Close()

	oldURL := fetchBaseURL
	fetchBaseURL = srv.URL + "/repos/%s/releases/latest"
	defer func() { fetchBaseURL = oldURL }()

	_, err := FetchLatest(2 * time.Second)
	if err == nil {
		t.Fatal("expected error on 500")
	}
	if !strings.Contains(err.Error(), "HTTP 500") {
		t.Errorf("err = %v, want contains 'HTTP 500'", err)
	}
}

// TestCheck_NoUpdate 用 mock server 验证 Check 完整流程（版本相同 → 无更新）。
func TestCheck_NoUpdate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"v0.2.0","name":"R","html_url":"https://x","published_at":"2026-08-12T10:00:00Z","prerelease":false,"assets":[]}`))
	}))
	defer srv.Close()

	oldURL := fetchBaseURL
	fetchBaseURL = srv.URL + "/repos/%s/releases/latest"
	defer func() { fetchBaseURL = oldURL }()

	r := Check("v0.2.0", 2*time.Second)
	if r.HasUpdate {
		t.Errorf("same version should not report update")
	}
	if r.Error != "" {
		t.Errorf("unexpected error: %s", r.Error)
	}
	if r.CurrentVersion != "v0.2.0" {
		t.Errorf("CurrentVersion = %q", r.CurrentVersion)
	}
}

// TestCheck_HasUpdate 用 mock server 验证 Check 完整流程（有新版本）。
func TestCheck_HasUpdate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"v1.0.0","name":"R","html_url":"https://x","published_at":"2026-08-12T10:00:00Z","prerelease":false,"assets":[{"name":"LiteMD-Setup-v1.0.0.exe","browser_download_url":"https://x/setup.exe"}]}`))
	}))
	defer srv.Close()

	oldURL := fetchBaseURL
	fetchBaseURL = srv.URL + "/repos/%s/releases/latest"
	defer func() { fetchBaseURL = oldURL }()

	r := Check("v0.2.0", 2*time.Second)
	if !r.HasUpdate {
		t.Errorf("should report update")
	}
	if r.Latest.TagName != "v1.0.0" {
		t.Errorf("TagName = %q", r.Latest.TagName)
	}
	if r.Latest.AssetURL != "https://x/setup.exe" {
		t.Errorf("AssetURL = %q", r.Latest.AssetURL)
	}
}

// TestCheck_InvalidVersion 验证版本号解析失败的错误处理。
func TestCheck_InvalidVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"v0.5.0","name":"R","html_url":"https://x","published_at":"2026-08-12T10:00:00Z","prerelease":false,"assets":[]}`))
	}))
	defer srv.Close()

	oldURL := fetchBaseURL
	fetchBaseURL = srv.URL + "/repos/%s/releases/latest"
	defer func() { fetchBaseURL = oldURL }()

	r := Check("not-a-version", 2*time.Second)
	if r.HasUpdate {
		t.Errorf("invalid current should not report update")
	}
	if r.Error == "" {
		t.Errorf("should set error")
	}
	if r.CurrentVersion != "not-a-version" {
		t.Errorf("CurrentVersion = %q", r.CurrentVersion)
	}
}

func TestStringBoolOf(t *testing.T) {
	if stringOf("a") != "a" {
		t.Error("stringOf")
	}
	if stringOf(nil) != "" {
		t.Error("stringOf nil")
	}
	if !boolOf(true) {
		t.Error("boolOf true")
	}
	if boolOf("nope") {
		t.Error("boolOf non-bool")
	}
}

func TestCheckResultHasAllFields(t *testing.T) {
	r := CheckResult{
		HasUpdate:      true,
		CurrentVersion: "v0.2.0",
		Latest: ReleaseInfo{
			TagName:  "v0.3.0",
			AssetURL: "https://x.exe",
		},
	}
	if !r.HasUpdate || r.Latest.TagName != "v0.3.0" {
		t.Error("CheckResult struct")
	}
	if !strings.Contains(`HasUpdate`, "HasUpdate") {
		t.Error("json tag")
	}
}

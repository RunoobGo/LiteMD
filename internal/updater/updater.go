// Package updater 负责 LiteMD 的自动更新检查。
//
// 流程：
//  1. 启动时延迟 5s 异步调用一次（不阻塞主流程）
//  2. 用户在菜单手动「检查更新」时立即调用
//  3. 比较本地版本与最新 tag，按 semver 语义判断是否有新版本
//  4. 返回结构化结果给前端，由前端决定弹窗/静默/下载
//
// 数据源：GitHub Releases API（不鉴权 endpoint）
//
//	GET https://api.github.com/repos/{owner}/{repo}/releases/latest
//	返回 JSON：{ tag_name, name, html_url, published_at, assets: [{browser_download_url,...}] }
package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GitHubRepo 是 GitHub 仓库坐标（变量而非常量，便于测试替换为 mock server）。
var GitHubRepo = "litemd/litemd"

// ReleaseInfo 是 GitHub release 的最小信息子集。
type ReleaseInfo struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	HTMLURL     string    `json:"html_url"`
	PublishedAt time.Time `json:"published_at"`
	Prerelease  bool      `json:"prerelease"`
	AssetURL    string    `json:"asset_url"` // Windows 安装包 URL（最匹配的 .exe）
}

// CheckResult 是一次更新检查的结果。
type CheckResult struct {
	HasUpdate      bool        `json:"hasUpdate"`
	CurrentVersion string      `json:"currentVersion"`
	Latest         ReleaseInfo `json:"latest"`
	Error          string      `json:"error,omitempty"`
}

// versionRE 解析 semver：v1.2.3 / 1.2.3 / 1.2.3-rc1 / 1.2.3+build.1
// 兼容两段式版本号（如 v1.0 / 1.2），缺失的 patch 视为 0。
// 第 4 组捕获预发布标识（如 -rc1），用于判断是否预发布版本。
var versionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

// fetchBaseURL 是 GitHub Releases API 的基础 URL，变量便于测试替换为 mock server。
var fetchBaseURL = "https://api.github.com/repos/%s/releases/latest"

// parseSemver 从 "v1.2.3" / "1.2.3" / "1.2.3-rc1" 提取 major/minor/patch 与预发布标识。
// preRelease 为空串表示正式版，非空（如 "rc1"）表示预发布版本。
func parseSemver(v string) (maj, min, pat int, preRelease string, err error) {
	m := versionRE.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return 0, 0, 0, "", fmt.Errorf("not a semver: %q", v)
	}
	maj, _ = strconv.Atoi(m[1])
	min, _ = strconv.Atoi(m[2])
	if m[3] != "" {
		pat, _ = strconv.Atoi(m[3])
	} // 两段式版本号（如 v1.0）patch 默认为 0
	preRelease = m[4] // 可能为空串
	return maj, min, pat, preRelease, nil
}

// IsNewer 当 latest > current 时返回 true。
//
// semver 语义：
//   - 先按 major/minor/patch 数值比较；
//   - 版本号相同时，正式版 > 预发布版（如 1.2.3 > 1.2.3-rc1）；
//   - 同为预发布时，按预发布标识字典序比较（够用，不严格遵循 semver 规范的数值比较）。
func IsNewer(latest, current string) (bool, error) {
	aMaj, aMin, aPat, aPre, err := parseSemver(latest)
	if err != nil {
		return false, fmt.Errorf("latest: %w", err)
	}
	bMaj, bMin, bPat, bPre, err := parseSemver(current)
	if err != nil {
		return false, fmt.Errorf("current: %w", err)
	}
	if aMaj != bMaj {
		return aMaj > bMaj, nil
	}
	if aMin != bMin {
		return aMin > bMin, nil
	}
	if aPat != bPat {
		return aPat > bPat, nil
	}
	// 版本号相同：正式版（preRelease=="") > 预发布版（preRelease!="")
	if aPre == "" && bPre != "" {
		return true, nil
	}
	if aPre != "" && bPre == "" {
		return false, nil
	}
	// 同为预发布或同为正式版：按字典序比较（不严格但够用）
	if aPre != bPre {
		return aPre > bPre, nil
	}
	return false, nil
}

// pickWindowsAsset 从 release assets 里挑出 Windows 安装包（优先 Setup，其次裸 exe）。
//
// GitHub asset 列表通常包括：
//   - LiteMD-Setup-v1.0.0.exe    ← 优先匹配
//   - LiteMD-Pro-Setup-v1.0.0.exe  ← 也会匹配（B13 修复：放宽 HasPrefix → 关键字 + 扩展名双条件）
//   - LiteMD.exe / LiteMD-portable.exe  ← fallback
//   - LiteMD-source-v1.0.0.tar.gz
//   - SHA256SUMS-v1.0.0.txt
func pickWindowsAsset(release map[string]any) string {
	assets, ok := release["assets"].([]any)
	if !ok {
		return ""
	}
	var setupURL, plainURL string
	for _, a := range assets {
		m, ok := a.(map[string]any)
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		url, _ := m["browser_download_url"].(string)
		if name == "" || url == "" {
			continue
		}
		lname := strings.ToLower(name)
		// B13 修复：放宽匹配。只要含 "litemd" + "setup" + 后缀 .exe，即视为目标安装包；
		// 支持未来 LiteMD-Pro-Setup / LiteMD-Setup / LiteMD-Enterprise-Setup 等变体。
		if strings.HasSuffix(lname, ".exe") && strings.Contains(lname, "litemd") && strings.Contains(lname, "setup") {
			setupURL = url
		} else if strings.HasSuffix(lname, ".exe") && strings.Contains(lname, "litemd") && !strings.Contains(lname, "source") {
			plainURL = url
		}
	}
	if setupURL != "" {
		return setupURL
	}
	return plainURL
}

// FetchLatest 拉取最新 release 信息。
func FetchLatest(timeout time.Duration) (ReleaseInfo, error) {
	url := fmt.Sprintf(fetchBaseURL, GitHubRepo)
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return ReleaseInfo{}, err
	}
	req.Header.Set("User-Agent", "LiteMD-Updater/1.0")
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return ReleaseInfo{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return ReleaseInfo{}, errors.New("no releases found")
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<10)) // 2KB，便于排查
		return ReleaseInfo{}, fmt.Errorf("github API: HTTP %d: %s", resp.StatusCode, string(body))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return ReleaseInfo{}, err
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ReleaseInfo{}, fmt.Errorf("parse: %w", err)
	}
	info := ReleaseInfo{
		TagName:    stringOf(raw["tag_name"]),
		Name:       stringOf(raw["name"]),
		HTMLURL:    stringOf(raw["html_url"]),
		Prerelease: boolOf(raw["prerelease"]),
		AssetURL:   pickWindowsAsset(raw),
	}
	if t, err := time.Parse(time.RFC3339, stringOf(raw["published_at"])); err == nil {
		info.PublishedAt = t
	}
	return info, nil
}

// Check 完整流程：拉取最新 + 比较 + 得出结果。
func Check(currentVersion string, timeout time.Duration) CheckResult {
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	latest, err := FetchLatest(timeout)
	if err != nil {
		return CheckResult{
			HasUpdate:      false,
			CurrentVersion: currentVersion,
			Error:          err.Error(),
		}
	}
	newer, cmpErr := IsNewer(latest.TagName, currentVersion)
	if cmpErr != nil {
		// 版本号解析失败时保守返回不更新，但仍然带 latest 信息
		return CheckResult{
			HasUpdate:      false,
			CurrentVersion: currentVersion,
			Latest:         latest,
			Error:          cmpErr.Error(),
		}
	}
	return CheckResult{
		HasUpdate:      newer,
		CurrentVersion: currentVersion,
		Latest:         latest,
	}
}

func stringOf(v any) string {
	s, _ := v.(string)
	return s
}

func boolOf(v any) bool {
	b, _ := v.(bool)
	return b
}

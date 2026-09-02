package links

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// ErrSchemeNotAllowed URL 协议不在白名单内（file://、javascript: 等）。
var ErrSchemeNotAllowed = errors.New("url scheme not allowed")

// allowedSchemes 允许交给系统默认程序处理的 URL 协议白名单。
//
// 刻意不包含 file:// —— 本地文件一律走 OpenWithSystem（可校验存在性与路径形态），
// 不让外部浏览器/程序去解释一个来路不明的 file URL。
var allowedSchemes = map[string]bool{
	"http": true, "https": true, "mailto": true, "tel": true,
}

// ValidateExternalURL 校验外链 URL 并返回规范化形式。
//
// 只放行 http/https/mailto/tel：预览区的链接文本完全由被打开的 .md 文件
// 决定，未校验就把 URL 丢给系统浏览器等同于给文档作者一个"打开任意
// 本地文件"的原语（file:///C:/… 会被系统程序直接执行）。
func ValidateExternalURL(rawURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", fmt.Errorf("invalid url: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if !allowedSchemes[scheme] {
		return "", fmt.Errorf("%w: %s", ErrSchemeNotAllowed, scheme)
	}
	return u.String(), nil
}

// requireExistingFile 校验路径是绝对路径且指向存在的常规文件。
//
// 用本包的 isAbsolute 而非 filepath.IsAbs：后者在跨平台构建下会把
// Windows 盘符路径判成相对路径，导致真机上的绝对路径被误拒。
func requireExistingFile(path string) (string, error) {
	p := strings.TrimSpace(path)
	if p == "" {
		return "", fmt.Errorf("%w: empty path", ErrNotFile)
	}
	if !isAbsolute(p) {
		return "", fmt.Errorf("%w: not absolute: %s", ErrNotFile, p)
	}
	clean := filepath.Clean(p)
	st, err := os.Stat(clean)
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrNotFile, clean)
	}
	if st.IsDir() {
		return "", fmt.Errorf("%w: is a directory: %s", ErrNotFile, clean)
	}
	return clean, nil
}

// OpenWithSystem 用系统默认程序打开一个本地文件（不阻塞等待其退出）。
//
// 前置条件由 requireExistingFile 强制：路径绝对、存在、且是常规文件。
// 调用方（前端）在此之前还应完成"非文本文件二次确认"的交互确认。
func OpenWithSystem(path string) error {
	clean, err := requireExistingFile(path)
	if err != nil {
		return err
	}
	var args []string
	var name string
	switch runtime.GOOS {
	case "windows":
		// rundll32 + FileProtocolHandler：不弹控制台窗口，且能正确处理
		// 含空格与非 ASCII 的路径（cmd /c start 需要额外的空标题参数才安全）
		name, args = "rundll32", []string{"url.dll,FileProtocolHandler", clean}
	case "darwin":
		name, args = "open", []string{clean}
	default:
		name, args = "xdg-open", []string{clean}
	}
	// Start 而非 Run：外部程序生命周期与 LiteMD 无关，等待会卡住 binding 调用
	return runDetached(name, args...)
}

// runDetached 是进程启动接缝，测试可替换以避免真的拉起外部程序。
var runDetached = func(name string, args ...string) error {
	return exec.Command(name, args...).Start()
}

// defaultRunDetached 保存真实实现，供测试替换后还原。
var defaultRunDetached = runDetached

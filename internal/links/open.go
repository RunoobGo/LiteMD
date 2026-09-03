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

// ErrExecutableType 目标是可执行/脚本类型，"交给系统默认程序打开"在三大系统上
// 都等同于直接执行（审查 P1-4）。文档里一个看似普通的链接不该有执行能力。
var ErrExecutableType = errors.New("refuse to open executable file type")

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

// execExts 一律拒绝交给系统默认程序的扩展名（审查 P1-4）。
//
// 这些类型在三大系统上都会被"打开"解释成"运行"：
//   - Windows：.exe/.bat/.cmd/.com/.scr/.msi/.vbs/.js/.hta 双击即执行，
//     .lnk 还能指向任意命令行；
//   - macOS：.app/.command/.action/.workflow 是可执行包或脚本；
//   - Linux：xdg-open 对 .sh/.desktop/.run 按可执行处理。
//
// 前端的"非文本文件二次确认"只是 UI 提示，Go 侧必须有不可绕过的兜底。
var execExts = map[string]bool{
	".exe": true, ".com": true, ".bat": true, ".cmd": true, ".scr": true, ".pif": true,
	".msi": true, ".vbs": true, ".vbe": true, ".js": true, ".jse": true,
	".wsf": true, ".wsh": true, ".hta": true, ".lnk": true, ".reg": true,
	".ps1": true, ".psm1": true, ".dll": true, ".sys": true, ".cpl": true,
	".app": true, ".command": true, ".action": true, ".workflow": true,
	".sh": true, ".bash": true, ".zsh": true, ".run": true, ".desktop": true,
}

// requireExistingFile 校验路径是绝对路径且指向存在的常规文件。
//
// 用本包的 isAbsolute 而非 filepath.IsAbs：后者在跨平台构建下会把
// Windows 盘符路径判成相对路径，导致真机上的绝对路径被误拒。
func requireExistingFile(path string) (string, error) {
	clean, _, err := statExistingFile(path)
	return clean, err
}

// statExistingFile 是 requireExistingFile 的带 FileInfo 版本。
//
// 返回 Stat 当时的 FileInfo 而非让调用方二次 Stat：先判大小再 ReadFile 会
// 留下 TOCTOU 窗口（审查 P1-5 —— 名为 x.png 的 FIFO 或指向 /dev/zero 的
// 软链能绕过大小预检），调用方应基于同一个 FileInfo 决策并用 LimitReader
// 给读取量兜底。
func statExistingFile(path string) (string, os.FileInfo, error) {
	p := strings.TrimSpace(path)
	if p == "" {
		return "", nil, fmt.Errorf("%w: empty path", ErrNotFile)
	}
	if !isAbsolute(p) {
		return "", nil, fmt.Errorf("%w: not absolute: %s", ErrNotFile, p)
	}
	clean := filepath.Clean(p)
	st, err := os.Stat(clean)
	if err != nil {
		return "", nil, fmt.Errorf("%w: %s", ErrNotFile, clean)
	}
	if st.IsDir() {
		return "", nil, fmt.Errorf("%w: is a directory: %s", ErrNotFile, clean)
	}
	// 审查 P1-4/P1-5：只放行常规文件。FIFO / 设备（/dev/zero）/ socket 的
	// Size() 通常为 0 能绕过大小预检，读取时会永久阻塞或无限增长。
	if !st.Mode().IsRegular() {
		return "", nil, fmt.Errorf("%w: not a regular file: %s", ErrNotFile, clean)
	}
	return clean, st, nil
}

// OpenWithSystem 用系统默认程序打开一个本地文件（不阻塞等待其退出）。
//
// 前置条件由 statExistingFile 强制：路径绝对、存在、且是常规文件；
// 再叠加可执行类型黑名单（审查 P1-4）。调用方（前端）在此之前还应完成
// "非文本文件二次确认"的交互确认。
func OpenWithSystem(path string) error {
	clean, _, err := statExistingFile(path)
	if err != nil {
		return err
	}
	if ext := strings.ToLower(filepath.Ext(clean)); execExts[ext] {
		return fmt.Errorf("%w: %s", ErrExecutableType, ext)
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

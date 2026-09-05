package fileio

import (
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

// ErrUnsafePath 当写入路径不满足安全约束时返回。
//
// 设计目的：WriteText / WriteBase64File 暴露给前端的 binding 直接把 path 落地，
// 在前端 XSS 绕过或远程内容场景下会成为任意写入原语。本守卫把「绝对路径 +
// Clean + Windows 保留设备名」三类最危险的形态拦在 fileio 入口，作为 defense
// in-depth 的一层（不依赖前端调用方自觉）。
var ErrUnsafePath = errors.New("unsafe path")

// windowsReservedNames Windows 上不可作为文件名的保留设备名（不带扩展名）。
// 写入这些名字会被解析到设备（CON/NUL）甚至挂起（COM/LPT）。
var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true,
	"COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true,
	"LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// windowsBaseName 提取路径末段文件名并去扩展名，全大写化用于保留设备名比对。
//
// #15 修复：扩展名截断取「第一个点」而非最后一个点。Windows 对 CON.x.txt
// 同样按设备名 CON 解析；旧实现用 LastIndex 得到 "CON.x"，集合比对落空，
// 造成保留名绕过。点开头的名字（.CON）不截断——它不是设备名形态，不应误拦。
//
// 纯字符串函数、不依赖 GOOS，任何平台可直接表驱动测试。
func windowsBaseName(p string) string {
	upper := strings.ToUpper(strings.ReplaceAll(p, "/", "\\"))
	base := upper[strings.LastIndex(upper, "\\")+1:]
	if dot := strings.Index(base, "."); dot > 0 {
		base = base[:dot]
	}
	return base
}

// safeWritePath 校验写入路径：必须是绝对路径、Clean 后不含 ..，且不是
// Windows 保留设备名。软链接暂不拒绝（影响用户刻意用软链接组织笔记库）
// —— 但调用方应当意识到 WriteText 跟随软链接的目标。
//
// 返回 Clean 后的路径供后续使用。
func safeWritePath(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("%w: not absolute: %s", ErrUnsafePath, p)
	}
	clean := filepath.Clean(p)
	// 拒绝 `..` 残余（Clean 在绝对路径上通常已规范化，这里兜底）。
	//
	// 审查 G1（v0.2.11）：这段代码原先只有上面这行注释，**并没有真正的检查**，
	// 注释会误导维护者以为存在第二道闸。现按分隔符切段精确比对补上：
	// 绝对路径经 Clean 后理论上不会出现 ".." 段，此检查属纵深防御，目的是
	// 让注释成立；按段比对而非 strings.Contains，避免误伤
	// "笔记..备份.md"、".gitignore" 这类含点的合法文件名。
	for _, seg := range strings.FieldsFunc(clean, func(r rune) bool {
		return r == '/' || r == '\\'
	}) {
		if seg == ".." {
			return "", fmt.Errorf("%w: path traversal: %s", ErrUnsafePath, p)
		}
	}
	if runtime.GOOS == "windows" {
		if windowsReservedNames[windowsBaseName(clean)] {
			return "", fmt.Errorf("%w: reserved device name: %s", ErrUnsafePath, p)
		}
	}
	return clean, nil
}

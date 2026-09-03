package links

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// MaxAssetBytes 单张本地图片允许读入预览的上限（10MB）。
//
// 预览用的是 data URL（base64 体积 ×1.37），过大的图会让渲染管线与内存
// 一起爆炸。超限直接报错，前端保留破图并给出提示——比卡住整个 UI 好。
const MaxAssetBytes = 10 << 20

// imageExts 允许作为预览资源读取的扩展名白名单。
//
// 走白名单而非"能读就读"：避免把 .exe/.dll 之类读进内存再塞进 DOM。
var imageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".bmp": true, ".svg": true, ".ico": true, ".avif": true,
}

// ErrSVGDisabled .svg 在 AllowSVG 关闭时的拒绝错误（审查 P1-5）。
var ErrSVGDisabled = errors.New("svg assets are disabled by default")

// AllowSVG 是否允许把 .svg 读成 data URL 回填预览（审查 P1-5）。
//
// 默认 false：SVG 是带脚本能力的文档，不是纯图片。以
// <img src="data:image/svg+xml;base64,…"> 加载时脚本确实不会执行，但这份
// 安全完全依赖"调用方只用 <img>"——哪天被塞进 <iframe>/<object> 或另开
// 窗口就是 XSS。默认关闭后前端退化为破图（resolveAssetSrc 返回 null 不打断
// 渲染）；确需支持时在此显式打开，而不是靠对调用方的隐含假设。
var AllowSVG = false

// ReadAssetDataURL 读取本地图片并返回可直接赋给 <img src> 的 data URL。
//
// 用途：预览区的相对路径图片（![](../assets/x.png)）在 wails.localhost 源下
// 会被解析成不存在的 HTTP 路径 → 破图。这里把磁盘上的真实文件读成 data URL
// 回填，本地图片即可正常显示。
//
// 错误：路径非绝对、不是常规文件、不是白名单图片类型、.svg 未显式开启、
// 文件超限或读取失败。
func ReadAssetDataURL(path string) (string, error) {
	// 用 statExistingFile 而非 requireExistingFile：拿到 Stat 当时的
	// FileInfo，消除"判大小 → ReadFile"之间的 TOCTOU 窗口（审查 P1-5）。
	clean, st, err := statExistingFile(path)
	if err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(clean))
	if !imageExts[ext] {
		return "", fmt.Errorf("unsupported asset type: %s", ext)
	}
	if ext == ".svg" && !AllowSVG {
		return "", fmt.Errorf("%w: %s", ErrSVGDisabled, clean)
	}
	if st.Size() > MaxAssetBytes {
		return "", fmt.Errorf("asset too large: %d bytes (limit %d)", st.Size(), MaxAssetBytes)
	}
	// 即便 Stat 之后文件被换成 FIFO/设备，LimitReader 也保证读取量有界，
	// 不会被 /dev/zero 之类的伪文件打爆内存。
	data, err := readBounded(clean, MaxAssetBytes)
	if err != nil {
		return "", fmt.Errorf("read asset: %w", err)
	}
	return "data:" + detectMime(clean, data) + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// readBounded 读取文件且硬性限制最多 max+1 字节（超界即报错）。
func readBounded(path string, max int64) ([]byte, error) {
	f, err := os.Open(path) // #nosec G304 -- 调用方已完成绝对/常规文件校验
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("file larger than %d bytes", max)
	}
	return data, nil
}

// detectMime 先用扩展名查表（svg/webp 等标准库表项更准），
// 查不到再用内容嗅探兜底。
func detectMime(path string, data []byte) string {
	if m := mime.TypeByExtension(filepath.Ext(path)); m != "" {
		// TypeByExtension 可能带 "; charset=utf-8" 后缀（svg 等），data URL 里去掉
		if i := strings.Index(m, ";"); i >= 0 {
			m = m[:i]
		}
		return m
	}
	if m := http.DetectContentType(data); m != "" {
		if i := strings.Index(m, ";"); i >= 0 {
			m = m[:i]
		}
		return m
	}
	return "application/octet-stream"
}

package links

import (
	"encoding/base64"
	"fmt"
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
// 走白名单而非"能读就读"：一是避免把 .exe/.dll 之类读进内存再塞进 DOM，
// 二是 svg 虽可执行脚本，但以 <img src="data:image/svg+xml;base64,…">
// 形式加载时脚本不会执行，风险可控。
var imageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".bmp": true, ".svg": true, ".ico": true, ".avif": true,
}

// ReadAssetDataURL 读取本地图片并返回可直接赋给 <img src> 的 data URL。
//
// 用途：预览区的相对路径图片（![](../assets/x.png)）在 wails.localhost 源下
// 会被解析成不存在的 HTTP 路径 → 破图。这里把磁盘上的真实文件读成 data URL
// 回填，本地图片即可正常显示。
//
// 错误：路径非绝对、不是白名单图片类型、文件超限或读取失败。
func ReadAssetDataURL(path string) (string, error) {
	clean, err := requireExistingFile(path)
	if err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(clean))
	if !imageExts[ext] {
		return "", fmt.Errorf("unsupported asset type: %s", ext)
	}
	st, err := os.Stat(clean)
	if err != nil {
		return "", fmt.Errorf("stat asset: %w", err)
	}
	if st.Size() > MaxAssetBytes {
		return "", fmt.Errorf("asset too large: %d bytes (limit %d)", st.Size(), MaxAssetBytes)
	}
	data, err := os.ReadFile(clean)
	if err != nil {
		return "", fmt.Errorf("read asset: %w", err)
	}
	return "data:" + detectMime(clean, data) + ";base64," + base64.StdEncoding.EncodeToString(data), nil
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

// Package links 处理 Markdown 中指向「本地资源」的链接：路径解析、类型判定、
// 本地资源读取，以及交给系统默认程序打开。
//
// 背景：LiteMD 前端跑在 WebView2 的 http://wails.localhost 源上。预览区的
// [文本](../../文档名) 若不做处理，点击会让 WebView 就地导航到
// http://wails.localhost/文档名 —— assetserver 查无此资源直接返回 404，
// 整个前端 SPA 被卸载（界面卡死、所有标签的未保存内容丢失）。
//
// 因此前端把所有链接点击拦截下来交给本包解析后再决定动作：
// Markdown / 文本在应用内打开，其他已存在文件交系统默认程序，不存在则提示。
//
// 分工约定：本包只做「路径计算 + 元信息判定 + 读取」，不决定 UI 行为；
// 是否弹确认框、是否新建标签由前端决定。
package links

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Kind 描述链接目标的类型，前端据此决定打开方式。
type Kind string

const (
	KindMarkdown Kind = "markdown" // .md 类：在应用内编辑器打开
	KindText     Kind = "text"     // .txt 等纯文本：在应用内编辑器打开
	KindOther    Kind = "other"    // 二进制/未知：交系统默认程序
	KindDir      Kind = "dir"      // 目录：提示不可打开
	KindMissing  Kind = "missing"  // 不存在
)

var (
	// ErrEmptyTarget 链接目标为空（href="#" 之外的空串）。
	ErrEmptyTarget = errors.New("link target is empty")
	// ErrNoBase 相对链接缺少基准文件（当前文档尚未保存到磁盘）。
	ErrNoBase = errors.New("base file path is empty")
	// ErrNotLocal 目标不是本地路径（带 http/mailto 等协议），应走外部打开分支。
	ErrNotLocal = errors.New("link target is not a local path")
	// ErrNotFile 目标不是常规文件（目录或不存在），不能交给系统程序打开。
	ErrNotFile = errors.New("target is not a regular file")
)

// markdownExts 在应用内编辑器打开的 Markdown 扩展名。
var markdownExts = map[string]bool{
	".md": true, ".markdown": true, ".mdown": true, ".mkd": true, ".mkdn": true,
}

// textExts 同样在应用内编辑器打开的纯文本扩展名。
var textExts = map[string]bool{
	".txt": true, ".text": true, ".log": true, ".csv": true, ".json": true, ".yaml": true, ".yml": true,
}

// Target 是一个链接目标的解析结果。
//
// Path 恒为绝对路径（不存在时也是"应该在哪"的绝对路径，供前端提示展示）。
type Target struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	Kind   Kind   `json:"kind"`
	Anchor string `json:"anchor"` // 目标文件内的锚点（无则空串）
}

// Resolve 把 Markdown 链接里的 href 解析为本地绝对路径并判定类型。
//
// baseFile 是当前文档的绝对路径（相对链接以它所在目录为基准）；
// href 是渲染后 <a> 上的原始 href（可能带百分号编码、#锚点、?查询）。
//
// 错误语义：
//   - ErrEmptyTarget：href 为空
//   - ErrNoBase：相对链接但当前文档未保存（前端应引导先保存）
//   - ErrNotLocal：href 带 http/mailto 等协议，不应走本函数
func Resolve(baseFile, href string) (Target, error) {
	raw := strings.TrimSpace(href)
	if raw == "" {
		return Target{}, ErrEmptyTarget
	}
	path, anchor := splitAnchor(raw)
	// 顺序要紧：先剥 file:// 再判协议，否则 "file:///C:/x.md" 会被
	// hasURLScheme 当成外部协议误拒（它是本地路径的一种写法）。
	path = stripFileURL(strings.TrimSpace(path))
	if hasURLScheme(path) {
		return Target{}, fmt.Errorf("%w: %s", ErrNotLocal, path)
	}
	// 再解码百分号编码（%E6%96%87%E6%A1%A3.md → 文档名.md），
	// 失败则保留原串（路径里出现裸 % 的极端情况）。
	if dec, err := decodePath(path); err == nil {
		path = dec
	}
	path = toSlashes(path)
	if path == "" {
		// 纯锚点（"#标题"）：前端已分流处理，这里返回空路径 + 锚点
		return Target{Anchor: anchor, Kind: KindMissing}, nil
	}

	if isAbsolute(path) {
		// 盘符/UNC 路径在跨平台构建下不能被 filepath.Abs 处理
		//（Linux 上会把 "C:/x" 当成相对路径拼到 cwd 前），故自行 Clean。
		path = cleanAbsolute(path)
	} else {
		base := strings.TrimSpace(baseFile)
		if base == "" {
			return Target{}, ErrNoBase
		}
		path = filepath.Join(filepath.Dir(base), path)
	}

	t := Target{Path: path, Anchor: anchor}
	st, err := os.Stat(path)
	if err != nil {
		t.Kind = KindMissing
		return t, nil
	}
	t.Exists = true
	if st.IsDir() {
		t.Kind = KindDir
		return t, nil
	}
	ext := strings.ToLower(filepath.Ext(path))
	switch {
	case markdownExts[ext]:
		t.Kind = KindMarkdown
	case textExts[ext]:
		t.Kind = KindText
	case ext == "":
		// 无扩展名目标：Obsidian 约定 `[x](../文档名)` 指向的是同库笔记
		//（链接里通常省略 .md）。嗅探文件头确认是 UTF-8 文本后才按
		// Markdown 归类——既不让用户点一个断链般的"其他文件"，也避免把
		// 恰好没扩展名的二进制误送进编辑器。
		if looksLikeText(path) {
			t.Kind = KindMarkdown
		} else {
			t.Kind = KindOther
		}
	default:
		t.Kind = KindOther
	}
	return t, nil
}

// sniffMax 无扩展名文件的内容嗅探上限（8KB 头部足够区分文本与二进制）。
const sniffMax = 8 << 10

// looksLikeText 判断文件头部是否为 UTF-8 文本：不含 NUL 字节且整体是合法 UTF-8。
func looksLikeText(path string) bool {
	f, err := os.Open(path) // #nosec G304 -- path 来自 Resolve 的规范化结果，调用方已确认存在
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, sniffMax)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return false
	}
	data := buf[:n]
	if bytes.IndexByte(data, 0) >= 0 {
		return false // NUL 字节几乎必为二进制
	}
	return utf8.Valid(data)
}

// splitAnchor 按 URL 语法切出 fragment 与 query，返回路径部分和锚点。
//
// 顺序遵循 path?query#fragment：先取 # 之后为锚点，再裁掉 ? 之后的查询串。
// Windows 文件名不允许 # 与 ?，故不会出现"路径里的 # 被误切"。
func splitAnchor(raw string) (path, anchor string) {
	if i := strings.Index(raw, "#"); i >= 0 {
		anchor = raw[i+1:]
		raw = raw[:i]
	}
	if i := strings.Index(raw, "?"); i >= 0 {
		raw = raw[:i]
	}
	return raw, anchor
}

// hasURLScheme 判断 s 是否带 URL 协议头（http:、mailto:、javascript: …）。
//
// 单字母后跟冒号的形态（"C:/x"）视为 Windows 盘符而非协议，返回 false。
func hasURLScheme(s string) bool {
	i := strings.Index(s, ":")
	if i <= 0 {
		return false
	}
	if i > 1 {
		return true
	}
	// 形如 "x:" —— 单字母只可能是盘符
	return false
}

// decodePath 对百分号编码做解码。用 PathUnescape 而非 QueryUnescape：
// 链接路径里的 "+" 是字面加号，不应被解成空格。
func decodePath(s string) (string, error) {
	if !strings.Contains(s, "%") {
		return s, nil
	}
	return url.PathUnescape(s)
}

// normalizePath 归一路径形态：剥 file:// 前缀、反斜杠转正斜杠。
//
//   - file:///C:/docs/a.md → C:/docs/a.md
//   - file://server/share/a.md → //server/share/a.md（UNC）
func normalizePath(s string) string {
	return toSlashes(stripFileURL(strings.TrimSpace(s)))
}

// stripFileURL 把 file:// 形态还原成本地路径写法（不含斜杠归一）。
func stripFileURL(s string) string {
	if len(s) >= 7 && strings.EqualFold(s[:7], "file://") {
		rest := s[7:]
		if strings.HasPrefix(rest, "/") {
			// file:///C:/x → /C:/x → C:/x
			return strings.TrimPrefix(rest, "/")
		}
		return "//" + rest // UNC：file://server/share
	}
	return s
}

// toSlashes 反斜杠统一为正斜杠（Windows 路径写法归一）。
func toSlashes(s string) string {
	return strings.ReplaceAll(s, "\\", "/")
}

// isAbsolute 跨平台判定绝对路径：UNC（//server/share）、Windows 盘符（C:/）、
// 或 Unix 根（/）。刻意不用 filepath.IsAbs —— 后者在 Linux 构建下对
// "C:/vault/a.md" 返回 false，会让 Windows 路径被误当成相对路径。
func isAbsolute(p string) bool {
	if strings.HasPrefix(p, "\\\\") || strings.HasPrefix(p, "//") {
		return true // UNC
	}
	if len(p) >= 3 && isDriveLetter(p[0]) && p[1] == ':' && (p[2] == '/' || p[2] == '\\') {
		return true
	}
	return strings.HasPrefix(p, "/")
}

func isDriveLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// cleanAbsolute 规范化绝对路径，并保住 UNC 的前导双斜杠。
//
// 不能直接 filepath.Clean：POSIX 下会把 "//server/share" 折叠成 "/server/share"，
// 而 Windows 下会保留 —— 同一份代码在两套系统上结果不一致，测试也会飘。
// 这里剥离前导斜杠、Clean 主体后再拼回 "//"，跨平台结果统一为正斜杠 UNC。
func cleanAbsolute(p string) string {
	if strings.HasPrefix(p, "//") || strings.HasPrefix(p, "\\\\") {
		rest := strings.TrimLeft(p, "/\\")
		return "//" + filepath.ToSlash(filepath.Clean(filepath.FromSlash(rest)))
	}
	return filepath.Clean(p)
}

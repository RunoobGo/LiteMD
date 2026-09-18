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

// 错误码（审计 R2-F1）：见 fileio.go 顶部约定。
const (
	CodeEmptyTarget    = "empty_target"
	CodeNoBase         = "no_base"
	CodeNotLocal       = "not_local"
	CodeNotFile        = "not_file"
	CodeNotEditable    = "not_editable"
	CodeMalformedPath  = "malformed_path"
)

var (
	// ErrEmptyTarget 链接目标为空（href="#" 之外的空串）。
	ErrEmptyTarget = errors.New("[" + CodeEmptyTarget + "] link target is empty")
	// ErrNoBase 相对链接缺少基准文件（当前文档尚未保存到磁盘）。
	ErrNoBase = errors.New("[" + CodeNoBase + "] base file path is empty")
	// ErrNotLocal 目标不是本地路径（带 http/mailto 等协议），应走外部打开分支。
	ErrNotLocal = errors.New("[" + CodeNotLocal + "] link target is not a local path")
	// ErrNotFile 目标不是常规文件（目录或不存在），不能交给系统程序打开。
	ErrNotFile = errors.New("[" + CodeNotFile + "] target is not a regular file")
	// ErrMalformedPath 审计 R2-G6：链接 href 百分号编码损坏，原本
	// decodePath 静默回退原文让用户看到 KindMissing 时无"链接损坏"线索。
	ErrMalformedPath = errors.New("[" + CodeMalformedPath + "] link path is malformed (invalid percent encoding)")
)

// markdownExts 在应用内编辑器打开的 Markdown 扩展名。
var markdownExts = map[string]bool{
	".md": true, ".markdown": true, ".mdown": true, ".mkd": true, ".mkdn": true,
}

// textExts 同样在应用内编辑器打开的纯文本扩展名。
var textExts = map[string]bool{
	".txt": true, ".text": true, ".log": true, ".csv": true, ".json": true, ".yaml": true, ".yml": true,
}

// ErrNotEditable 目标不是允许在编辑器中打开的文本类型（审查 P1-9）。
//
// 打开对话框带 "All Files (*.*)" 过滤器，等于给了"读任意 UTF-8 明文"的口子：
// ~/.ssh/id_rsa、.env、.pem 私钥都是合法 UTF-8，ReadText 会照读不误，随后
// 内容进编辑器、进预览、可能随文档一起被保存或外发。
var ErrNotEditable = errors.New("[" + CodeNotEditable + "] file type is not openable in the editor")

// secretExts 即便扩展名"看起来像文本"也一律拒绝的类型：密钥/凭据类。
var secretExts = map[string]bool{
	".pem": true, ".key": true, ".p12": true, ".pfx": true, ".jks": true,
	".keystore": true, ".kdbx": true, ".gpg": true, ".pgp": true, ".asc": true,
}

// secretNames 无扩展名（或扩展名不在管控内）的敏感文件名。
//
// 这些文件在三大系统上都没有扩展名，靠扩展名白名单拦不住，只能按名字判。
//
// v0.2.11（审查 Y3）：原名单是"想到一个加一个"，遗漏面随时间累积（例如
// .git-credentials 明文存 git 凭据、.dockercfg 存 registry 凭据、各类 shell
// 历史文件会记录带密码的命令行）。现补齐常见形态，并把变体极多的 .env.*
// 交给 secretNamePrefixes 按前缀判定，避免逐个穷举。
//
// 注意：本名单**只**用于拦"敏感文件"，不代表收紧放行策略——无扩展名文件
// 依旧按 Obsidian 约定放行（见下方 CheckEditable 注释）。
var secretNames = map[string]bool{
	// SSH / 私钥类
	"id_rsa": true, "id_dsa": true, "id_ecdsa": true, "id_ed25519": true,
	"id_ecdsa_sk": true, "id_ed25519_sk": true,
	// 凭据 / token 类
	".netrc": true, ".npmrc": true, ".yarnrc": true, ".pypirc": true,
	".htpasswd": true, ".gitconfig": true, ".git-credentials": true,
	".dockercfg": true, "credentials": true,
	// 数据库凭据
	".pgpass": true, ".my.cnf": true,
	// shell / 交互历史（会记录带密码的命令行）
	".bash_history": true, ".zsh_history": true, ".fish_history": true,
	".psql_history": true, ".mysql_history": true, ".python_history": true,
	// .env 及其变体走前缀判定（见 secretNamePrefixes），此处保留 .env/.env.local
	// 仅为可读性，前缀规则已覆盖。
	".env": true, ".env.local": true,
}

// secretNamePrefixes 需要按前缀判定的敏感文件名前缀。
//
// .env 的变体（.env.development / .env.production / .env.staging.local /…）
// 在实践中由框架与团队约定自由扩展，穷举名单必然落后，改按前缀判定。
// 代价：名为 .environment 之类的文件会被一并拦下——这类误拒成本极低，
// 而漏放一个 .env.production 的代价是密钥泄露，不对称。
var secretNamePrefixes = []string{".env"}

// hasSecretNamePrefix 判定小写文件名是否命中敏感前缀。
func hasSecretNamePrefix(name string) bool {
	for _, p := range secretNamePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// CheckEditable 判定 path 是否允许在编辑器中打开（审查 P1-9）。
//
// 放行：Markdown 扩展名、纯文本扩展名，以及"无扩展名且不在敏感名单内"
// （Obsidian 习惯用 [[文档名]] 省略 .md，Resolve 已按同样口径把无扩展名的
// 文本文件归为 KindMarkdown，这里必须保持一致，否则链接能打开、手动打开
// 却被拒，行为自相矛盾）。
//
// 其余一律 ErrNotEditable。返回 nil 表示允许。
func CheckEditable(path string) error {
	ext := strings.ToLower(filepath.Ext(path))
	if secretExts[ext] {
		return fmt.Errorf("%w: %s", ErrNotEditable, ext)
	}
	// v0.2.11：名单命中 或 前缀命中（.env.* 变体）都拒
	if name := strings.ToLower(filepath.Base(path)); secretNames[name] || hasSecretNamePrefix(name) {
		return fmt.Errorf("%w: %s", ErrNotEditable, name)
	}
	switch {
	case markdownExts[ext], textExts[ext]:
		return nil
	case ext == "":
		// 无扩展名：放行（Obsidian 约定），敏感文件名已在上一步拦掉
		return nil
	default:
		return fmt.Errorf("%w: %s", ErrNotEditable, ext)
	}
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
	// 再解码百分号编码（%E6%96%87%E6%A1%A3.md → 文档名.md）。
	// 审计 R2-G6：原失败时静默回退原文，错误链里没有"链接损坏"线索。
	// 现返 ErrMalformedPath，前端可针对性提示"URL 解析失败"。
	if dec, err := decodePath(path); err == nil {
		path = dec
	} else {
		return Target{}, fmt.Errorf("%w: %s", ErrMalformedPath, path)
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
	// 输出统一为正斜杠：filepath.Join/Clean 在 Windows 会引入反斜杠，而
	// LiteMD 的路径最终喂给 WebView（前端按 / 解析），跨平台一致性与测试
	// 也都期望正斜杠（见本文件顶部说明）。cleanAbsolute 已对 UNC 做了
	// 正斜杠处理，这里对相对分支补齐同样的归一。
	path = toSlashes(path)

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

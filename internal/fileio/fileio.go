// Package fileio 封装文件读写操作，提供 Markdown 编辑器所需的基础 IO 能力。
//
// 设计目标：
//   - 区分"文件不存在"与"权限不足"，便于前端提示;
//   - 对 UTF-8 文本做最小校验，避免读入二进制破坏编辑器;
//   - 写操作采用临时文件 + rename 模式，防止崩溃导致原文件损坏。
//
// 错误码约定（审计 R2-F1）：所有对外暴露的 error 都在文案前挂 `[code]`
// 前缀，前端经 errCode(err) 解析后做精确 switch。错误哨兵仍可
// errors.Is 判别，contract_test.go 的 TestErrorTextContractForFrontend
// 钉死文案 + 新增 TestErrorCodePrefix 钉死 code 前缀。
package fileio

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"
)

// 错误码（前端 errCode 解析用；保持下划线命名，新增先入此清单再写到 var）
const (
	CodeNotFound         = "file_not_found"
	CodeIsBinary         = "is_binary"
	CodeTooLarge         = "too_large"
	CodeNotRegular       = "not_regular"
	CodeExternalModified = "external_modified"
	CodeInvalidAsset     = "invalid_asset"
)

// ErrNotFound 当目标文件不存在时返回。前端可据此打开"新建文件"流程而非报错。
var ErrNotFound = errors.New("[" + CodeNotFound + "] file not found")

// ErrIsBinary 当文件包含无效 UTF-8 序列时返回。Markdown 编辑器拒绝打开二进制文件。
var ErrIsBinary = errors.New("[" + CodeIsBinary + "] file contains invalid UTF-8 (binary?)")

// ErrTooLarge 当文件超过 MaxReadSize 时返回。防止超大文件导致 OOM。
var ErrTooLarge = errors.New("[" + CodeTooLarge + "] file too large to read")

// ErrNotRegular 当目标是 FIFO / 设备 / socket / /proc 等非普通文件时返回。
// 读取伪文件（/dev/zero、FIFO 等）会永久挂起或无限增长，必须在 Stat 阶段拒绝。
var ErrNotRegular = errors.New("[" + CodeNotRegular + "] not a regular file")

// ErrExternalModified 当磁盘文件的 mtime 与调用方预期不符时返回。
// 语义：文件在「打开/上次保存」之后被其他程序改过，直接写入会静默覆盖
// 外部修改（P0-5）。前端应弹冲突确认，用户坚持时以 expectMtime=0 强制写。
var ErrExternalModified = errors.New("[" + CodeExternalModified + "] file modified by another program")

// MaxReadSize 是 ReadText 允许读取的最大文件大小（50MB）。
const MaxReadSize = 50 << 20

// 审计 R2-G1：error 文案只露 basename（`filepath.Base`），完整路径走
// 日志/留底，不外发到 toast / IPC 序列化。`~/.ssh/id_rsa` 之类敏感
// 路径不会被显示在错误信息里——文件已被 CheckEditable 拦截时无 path
// 暴露，但本兜底防"open 任意 UTF-8 明文"残留信息泄露。
func publicPath(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Base(p)
}

// ReadText 读取整个文件为 UTF-8 文本。
//
// 行为契约：
//   - 文件不存在 → 返回 ErrNotFound
//   - 文件超过 MaxReadSize（50MB）→ 返回 ErrTooLarge
//   - 文件包含 NUL 字节或无效 UTF-8 → 返回 ErrIsBinary
//   - 目标是 FIFO / 设备 / socket / /proc 等非普通文件 → 返回 ErrNotRegular
//     （保护：避免打开对话框选 All Files 时选中伪文件导致永久挂起或 OOM）
//   - 自动剥除 UTF-8 BOM（\xEF\xBB\xBF）
//   - 其他错误原样返回（权限、IO 等）
func ReadText(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("%w: %s", ErrNotFound, publicPath(path))
		}
		return "", err
	}
	// 拒绝非普通文件（FIFO / 设备 / socket / /proc）。这些文件的 Size() 通常为 0，
	// 能绕过预检；读取会无限增长（/dev/zero）或永久阻塞（FIFO）。
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("%w: %s", ErrNotRegular, publicPath(path))
	}
	if st.Size() > MaxReadSize {
		return "", fmt.Errorf("%w: %s (%d bytes)", ErrTooLarge, publicPath(path), st.Size())
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	// LimitReader 兜底：即便 Stat 之后文件被换/增长，也保证读到的字节数有界。
	data, err := io.ReadAll(io.LimitReader(f, MaxReadSize+1))
	if err != nil {
		return "", err
	}
	if len(data) > MaxReadSize {
		return "", fmt.Errorf("%w: %s", ErrTooLarge, publicPath(path))
	}
	// 剥除 UTF-8 BOM
	data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF"))
	if !utf8.Valid(data) {
		return "", fmt.Errorf("%w: %s", ErrIsBinary, publicPath(path))
	}
	// NUL 字节检测（审查 P1-9）：NUL 是合法 UTF-8，utf8.Valid 拦不住，
	// 但函数契约一直承诺"含 NUL → ErrIsBinary"，此前注释与实现不符。
	// UTF-16/32 编码的文本、带 padding 的二进制都以大量 NUL 为特征，
	// 读进编辑器是一堆不可见字符，保存时还可能写坏原编码。
	//
	// 顺序要紧：先 Valid 再查 NUL —— 两类文件都会命中 NUL，但无效 UTF-8
	// 应该报更具体的"非法 UTF-8"。
	if bytes.IndexByte(data, 0) >= 0 {
		return "", fmt.Errorf("%w: contains NUL byte: %s", ErrIsBinary, publicPath(path))
	}
	return string(data), nil
}

// WriteText 将文本写入 path。存在则覆盖。
//
// 实现见 writeAtomic：同目录临时文件 → fsync → 原子 rename → 目录 fsync。
func WriteText(path, content string) error {
	clean, err := safeWritePath(path)
	if err != nil {
		return err
	}
	// 统一以 Clean 后的路径落盘（审查 🟢-1）：safeWritePath 返回值此前被
	// 丢弃，tmp 与 rename 目标仍用原始拼写——同一路径的两种写法最终指向
	// 同一文件，但返回口径不一致。统一后写入目标唯一确定。
	return writeAtomic(clean, []byte(content))
}

// writeAtomic 是全项目唯一的原子写实现（P0-3：此前 WriteText 与
// WriteBase64File 各持一份重复实现，且都有两个缺口）：
//
//  1. 权限丢失：CreateTemp 固定 0600，覆盖已有文件时原权限被永久改写——
//     Windows 上 ACL 继承的读权限被抹掉后，同步工具/其他账户会读不到笔记。
//     现覆盖已有文件时沿用其原 mode 位。
//  2. 目录 fsync：rename 后未刷父目录，掉电时可能出现「旧的没了、新的
//     也没有」。POSIX 上对目录句柄 Sync；Windows 不支持目录句柄 Sync，
//     依赖 NTFS 元数据日志保证 rename 原子性，显式跳过。
//
// 失败路径由 defer 统一清理临时文件；rename 成功后清理调用会失败，无害。
func writeAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	// 权限保留：目标已存在时沿用原 mode（跟随符号链接的场景由调用方知晓）
	perm := os.FileMode(0o644)
	if st, serr := os.Stat(path); serr == nil && st.Mode().IsRegular() {
		perm = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(dir, ".litemd-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = os.Remove(tmpPath)
	}()
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write: %w", err)
	}
	// 数据先落盘：仅 Close + Rename 不够，rename 的元数据可能先于数据持久化。
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	// rename 元数据落盘（见函数注释：Windows 跳过）
	if runtime.GOOS != "windows" {
		if d, derr := os.Open(dir); derr == nil {
			_ = d.Sync()
			_ = d.Close()
		}
	}
	return nil
}

// WriteBase64File 解码 base64 数据并写入文件（用于图片资产复制）。
//
// 使用场景：用户在 LiteMD 中拖入图片 → 前端把图片转为 Base64 → 调用此方法。
// 失败会返回原始错误（包含 decode/io 失败的具体上下文）。
//
// 大小上限（P0-2）：解码后超过 MaxAssetWriteSize（20MB）拒绝。解码前先按
// base64 膨胀率（4 字符 → 3 字节）做入参长度预检，避免超大入参先被完整
// 解码进内存才被拒（内存放大）。
func WriteBase64File(path, base64Data string) error {
	clean, err := safeWritePath(path)
	if err != nil {
		return err
	}
	path = clean // 与 WriteText 同源：统一以 Clean 后路径落盘（审查 🟢-1）
	if strings.TrimSpace(base64Data) == "" {
		// 审查（R2-F1 契约补漏）：原为裸 errors.New，文案无 [code] 前缀，
		// 前端 errCode() 解出 null，该分支静默退化成通用错误弹窗。
		// 归入 ErrInvalidAsset——前端已有该码的分支，无需新增常量。
		return fmt.Errorf("%w: empty base64 data", ErrInvalidAsset)
	}
	// 兼容带 data URI 前缀的情况。
	// B16 修复：data URI 格式为 `data:[mediatype][;base64],<payload>`，仅第一个逗号分隔头和内容；
	// 但理论上 payload（尤其是 base64 解码后可能包含逗号的 URL/文本场景）也可能包含逗号，
	// 此处额外加 `strings.HasPrefix(data:")` 判定保证 data URI，同时用 LastIndex 取最后一个逗号更鲁棒。
	if idx := strings.LastIndex(base64Data, ","); idx >= 0 && strings.HasPrefix(base64Data, "data:") {
		base64Data = base64Data[idx+1:]
	}
	// 解码前预检：base64 长度上限 ≈ (cap+2)/3*4，超出直接拒绝，不做无效解码
	if maxB64 := (MaxAssetWriteSize + 2) / 3 * 4; len(base64Data) > maxB64 {
		return fmt.Errorf("%w: base64 payload %d chars exceeds asset limit (%d bytes decoded)",
			ErrTooLarge, len(base64Data), MaxAssetWriteSize)
	}
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return fmt.Errorf("decode base64: %w", err)
	}
	if len(data) > MaxAssetWriteSize {
		return fmt.Errorf("%w: decoded %d bytes exceeds asset limit (%d)", ErrTooLarge, len(data), MaxAssetWriteSize)
	}
	return writeAtomic(path, data)
}

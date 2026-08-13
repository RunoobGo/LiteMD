// Package fileio 封装文件读写操作，提供 Markdown 编辑器所需的基础 IO 能力。
//
// 设计目标：
//   - 区分"文件不存在"与"权限不足"，便于前端提示;
//   - 对 UTF-8 文本做最小校验，避免读入二进制破坏编辑器;
//   - 写操作采用临时文件 + rename 模式，防止崩溃导致原文件损坏。
package fileio

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// ErrNotFound 当目标文件不存在时返回。前端可据此打开"新建文件"流程而非报错。
var ErrNotFound = errors.New("file not found")

// ErrIsBinary 当文件包含无效 UTF-8 序列时返回。Markdown 编辑器拒绝打开二进制文件。
var ErrIsBinary = errors.New("file contains invalid UTF-8 (binary?)")

// ErrTooLarge 当文件超过 MaxReadSize 时返回。防止超大文件导致 OOM。
var ErrTooLarge = errors.New("file too large to read")

// MaxReadSize 是 ReadText 允许读取的最大文件大小（50MB）。
const MaxReadSize = 50 << 20

// FileMeta 描述一个 Markdown 文件的元信息。
type FileMeta struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	IsNew bool   `json:"isNew"`
}

// ReadText 读取整个文件为 UTF-8 文本。
//
// 行为契约：
//   - 文件不存在 → 返回 ErrNotFound
//   - 文件超过 MaxReadSize（50MB）→ 返回 ErrTooLarge
//   - 文件包含 NUL 字节或无效 UTF-8 → 返回 ErrIsBinary
//   - 自动剥除 UTF-8 BOM（\xEF\xBB\xBF）
//   - 其他错误原样返回（权限、IO 等）
func ReadText(path string) (string, error) {
	// 预检文件大小，避免读取超大文件导致 OOM
	if st, err := os.Stat(path); err == nil && st.Size() > MaxReadSize {
		return "", fmt.Errorf("%w: %s (%d bytes)", ErrTooLarge, path, st.Size())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return "", err
	}
	// 剥除 UTF-8 BOM
	data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF"))
	if !utf8.Valid(data) {
		return "", fmt.Errorf("%w: %s", ErrIsBinary, path)
	}
	return string(data), nil
}

// WriteText 将文本写入 path。存在则覆盖。
//
// 实现：写入同目录下的临时文件，再原子 rename，避免半写状态。
func WriteText(path, content string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("empty path")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".litemd-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	// 不论成功失败都尝试清理 tmp 文件
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	if _, err := tmp.WriteString(content); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// FileExists 简单判断文件是否存在。
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// IsMarkdown 简单判断扩展名是否属于 Markdown 家族。
func IsMarkdown(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".md", ".markdown", ".mdown", ".mkd", ".mkdn":
		return true
	}
	return false
}

// WriteBase64File 解码 base64 数据并写入文件（用于图片资产复制）。
//
// 使用场景：用户在 LiteMD 中拖入图片 → 前端把图片转为 Base64 → 调用此方法。
// 失败会返回原始错误（包含 decode/io 失败的具体上下文）。
func WriteBase64File(path, base64Data string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("empty path")
	}
	if strings.TrimSpace(base64Data) == "" {
		return errors.New("empty base64 data")
	}
	// 兼容带 data URI 前缀的情况。
	// B16 修复：data URI 格式为 `data:[mediatype][;base64],<payload>`，仅第一个逗号分隔头和内容；
	// 但理论上 payload（尤其是 base64 解码后可能包含逗号的 URL/文本场景）也可能包含逗号，
	// 此处额外加 `strings.HasPrefix(data:")` 判定保证 data URI，同时用 LastIndex 取最后一个逗号更鲁棒。
	if idx := strings.LastIndex(base64Data, ","); idx >= 0 && strings.HasPrefix(base64Data, "data:") {
		base64Data = base64Data[idx+1:]
	}
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return fmt.Errorf("decode base64: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".litemd-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

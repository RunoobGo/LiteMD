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
	"io"
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

// ErrNotRegular 当目标是 FIFO / 设备 / socket / /proc 等非普通文件时返回。
// 读取伪文件（/dev/zero、FIFO 等）会永久挂起或无限增长，必须在 Stat 阶段拒绝。
var ErrNotRegular = errors.New("not a regular file")

// MaxReadSize 是 ReadText 允许读取的最大文件大小（50MB）。
const MaxReadSize = 50 << 20

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
			return "", fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return "", err
	}
	// 拒绝非普通文件（FIFO / 设备 / socket / /proc）。这些文件的 Size() 通常为 0，
	// 能绕过预检；读取会无限增长（/dev/zero）或永久阻塞（FIFO）。
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("%w: %s", ErrNotRegular, path)
	}
	if st.Size() > MaxReadSize {
		return "", fmt.Errorf("%w: %s (%d bytes)", ErrTooLarge, path, st.Size())
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
		return "", fmt.Errorf("%w: %s", ErrTooLarge, path)
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
// 实现：写入同目录下的临时文件 → 强制刷盘（Sync）→ 原子 rename。
// Sync 是关键：缺少时掉电/内核 panic 可能让 rename 之后的元数据先于
// 数据落盘，导致目标文件长度正确但内容为空或半截（违背本函数
// 「防止崩溃导致原文件损坏」的设计目标）。
func WriteText(path, content string) error {
	if _, err := safeWritePath(path); err != nil {
		return err
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
	return nil
}

// WriteBase64File 解码 base64 数据并写入文件（用于图片资产复制）。
//
// 使用场景：用户在 LiteMD 中拖入图片 → 前端把图片转为 Base64 → 调用此方法。
// 失败会返回原始错误（包含 decode/io 失败的具体上下文）。
func WriteBase64File(path, base64Data string) error {
	if _, err := safeWritePath(path); err != nil {
		return err
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
	// 数据先落盘：避免断电后 rename 的元数据先于数据持久化
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
	return nil
}

package fileio

import (
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

// P0-2：CopyImageAsset 原先直接接受前端传入的完整 targetPath + 任意内容，
// 等价于「任意文件写入原语」——前端被 XSS 注入或逻辑被滥用时，可以往
// 用户磁盘的任何绝对路径（启动目录、配置文件、可执行文件）写任意字节。
//
// 收敛后的模型：前端只传「当前文档路径 + 资产文件名」，assets 目录由后端
// 从文档目录推导，扩展名白名单 + 大小上限 + 名称合法性在这里统一把关。
// 前端失去指定写入位置的能力，写入范围被结构性限制在 <文档目录>/assets/ 内。

// MaxAssetWriteSize 是单个资产文件解码后的大小上限（20MB）。
const MaxAssetWriteSize = 20 << 20

// ErrInvalidAsset 资产名或写入目标不满足约束时返回。
// 错误码见 fileio.go CodeInvalidAsset。
var ErrInvalidAsset = errors.New("[" + CodeInvalidAsset + "] invalid asset target")

// allowedAssetExts 资产扩展名白名单。CopyImageAsset 只服务「图片资产」场景，
// 写 .exe/.bat/.md 等一律拒绝——即使写入范围已限死在 assets/ 内，
// 也不该给「往磁盘放任意类型文件」留口子。
var allowedAssetExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".svg": true, ".avif": true, ".bmp": true, ".ico": true,
}

// AssetWritePath 由「文档绝对路径 + 资产文件名」推导并校验资产写入路径。
//
// 校验链（任一失败返回 ErrInvalidAsset / ErrUnsafePath）：
//  1. baseFile 必须是绝对路径（复用 safeWritePath 的 Clean + 保留名守卫）；
//  2. assetName 必须是纯文件名：不含路径分隔符、不是 . / ..、
//     非 Windows 保留设备名、长度 ≤ 128、扩展名在白名单内；
//  3. 最终路径 = <baseFile 目录>/assets/<assetName>，Join 后再次确认
//     所在目录未变（防 Clean/大小写/分隔符形态造成的逃逸）。
func AssetWritePath(baseFile, assetName string) (string, error) {
	baseClean, err := safeWritePath(baseFile)
	if err != nil {
		return "", fmt.Errorf("%w: bad base file: %v", ErrInvalidAsset, err)
	}
	name := strings.TrimSpace(assetName)
	if name == "" {
		return "", fmt.Errorf("%w: empty asset name", ErrInvalidAsset)
	}
	if len(name) > 128 {
		return "", fmt.Errorf("%w: asset name too long", ErrInvalidAsset)
	}
	if name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
		return "", fmt.Errorf("%w: asset name must be a bare file name: %q", ErrInvalidAsset, name)
	}
	if runtime.GOOS == "windows" && windowsReservedNames[windowsBaseName(name)] {
		return "", fmt.Errorf("%w: reserved device name: %q", ErrInvalidAsset, name)
	}
	if !allowedAssetExts[strings.ToLower(filepath.Ext(name))] {
		return "", fmt.Errorf("%w: extension not allowed: %q", ErrInvalidAsset, name)
	}
	dir := filepath.Join(filepath.Dir(baseClean), "assets")
	final := filepath.Join(dir, name)
	// 兜底：Join+Clean 之后目录必须仍是推导出的 assets 目录
	if filepath.Dir(final) != dir {
		return "", fmt.Errorf("%w: path escapes assets dir: %q", ErrInvalidAsset, name)
	}
	return final, nil
}

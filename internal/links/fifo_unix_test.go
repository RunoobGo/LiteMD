//go:build !windows

package links

import "syscall"

// mkfifo 创建命名管道，用于验证"非普通文件一律拒绝"（审查 P1-4/P1-5）。
//
// 单独拆文件是构建约束需要：syscall.Mkfifo 在 Windows 上不存在，
// 交叉编译（GOOS=windows go vet ./...）时不能让主测试文件引用它。
func mkfifo(path string) error {
	return syscall.Mkfifo(path, 0o600)
}

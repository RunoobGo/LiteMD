//go:build windows

package links

import "errors"

// mkfifo 的 Windows 桩：Windows 无 POSIX FIFO，TestNonRegularFileRejected
// 在运行时已 t.Skip 跳过，此处仅保证跨平台编译通过
// （GOOS=windows go vet/test 时主测试文件对 mkfifo 的符号引用必须存在）。
func mkfifo(path string) error {
	return errors.New("mkfifo not supported on windows")
}

package main

// startupfile.go — "使用本应用打开"（文件关联）支持
//
// 背景：用户在文件管理器中双击 .md 文件（或右键"打开方式 → LiteMD"）时，
// 操作系统会以命令行参数携带目标路径启动应用：
//   - Windows：新进程 argv 含文件路径；若应用已在运行且未启用单实例锁，
//     会再启动一个空白实例（旧版 bug 根因之一）。
//   - Linux：同 Windows，argv 携带路径。
//   - macOS：Launch Services 通过 Apple Event 而非 argv 传递（Wails v2 未
//     暴露 openFile 回调，为已知限制）；但直接执行二进制 ./LiteMD a.md 时路径在 argv。
//
// 本文件提供两个原语：
//   1. extractStartupFile：从任意 args 中解析出第一个"存在的常规文件"；
//   2. startupFileQueue：待开文件队列（启动参数与二实例回调两个来源共用），
//      前端启动时经 ConsumeStartupFile 绑定一次性消费。

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// extractStartupFiles 从参数列表中提取全部"待打开文件"的绝对路径（保持参数顺序）。
//
// 规则：
//   - 跳过空串与以 '-' 开头的旗标（macOS 启动服务会附加
//     -NSDocumentRevisionsModelVersion / -psn_* 等，且值可能紧跟旗标，
//     因此要求路径必须是磁盘上真实存在的文件，天然过滤掉这类噪音）
//   - 相对路径基于进程工作目录规范化
//   - 仅接受存在的常规文件（目录、设备等一律跳过）
//
// 文件管理器多选后"打开"会传入多个路径,全部入队逐个打开。
// 未找到返回 nil。
func extractStartupFiles(args []string) []string {
	var files []string
	for _, arg := range args {
		if arg == "" || strings.HasPrefix(arg, "-") {
			continue
		}
		p := arg
		if !filepath.IsAbs(p) {
			if abs, err := filepath.Abs(p); err == nil {
				p = abs
			}
		}
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			files = append(files, p)
		}
	}
	return files
}

// startupFileQueue 是并发安全的待开文件 FIFO 队列。
// 消费方唯一（前端启动 + litemd:openExternalFile 事件处理器），生产方
// 可能是主 goroutine（启动参数）或 Wails 二实例回调 goroutine。
type startupFileQueue struct {
	mu    sync.Mutex
	files []string
}

// push 追加一个待打开路径，空路径忽略。
func (q *startupFileQueue) push(path string) {
	if path == "" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.files = append(q.files, path)
}

// pop 取出最早入队的路径；队列空时返回 ""。
func (q *startupFileQueue) pop() string {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.files) == 0 {
		return ""
	}
	p := q.files[0]
	q.files = q.files[1:]
	return p
}

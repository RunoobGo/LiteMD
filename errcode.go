package main

// errcode.go — 错误码提取辅助
//
// 审计 R2-F1：Go 侧所有 binding error 在文案前挂 `[code]` 前缀；前端
// 配套在 file-ops.ts / main.ts 用 errCode(err) 正则解出。本文件
// 提供 Go 侧等价的 CodeOf(err) 辅助，供服务端日志/测试/未来的
// 错误码路由使用。
//
// 用法：
//
//	if main.CodeOf(err) == fileio.CodeExternalModified { … }
//
// 或对跨包错误：
//
//	if main.CodeOf(err) == fileio.CodeNotFound { … }
//
// 实现：用 errors.Unwrap 穿透 wrap 链，直到找到 err.Error() 以
// `[code]` 开头的层级；都找不到返回空串。

import (
	"errors"
	"regexp"
)

// codePrefixRE 匹配错误文案开头的 `[code]` 块。
var codePrefixRE = regexp.MustCompile(`^\[([a-z][a-z0-9_]*)\]`)

// CodeOf 返回 err 文案首个 `[code]` 块（穿透 wrap 链）。无码返回空串。
func CodeOf(err error) string {
	if err == nil {
		return ""
	}
	for cur := err; cur != nil; cur = errors.Unwrap(cur) {
		if m := codePrefixRE.FindStringSubmatch(cur.Error()); len(m) == 2 {
			return m[1]
		}
	}
	return ""
}

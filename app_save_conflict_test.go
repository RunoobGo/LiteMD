package main

// app_save_conflict_test.go — SaveFile expectMtime 冲突检测的 runtime 回归
//
// 审计 R2-G8：P0-5 外部修改冲突检测的"语义"由 TestErrorTextContractForFrontend
// 钉死了（"file modified by another program" 文案），但 runtime 行为从未被
// 直接断言。本文件补 3 用例：mtime 不符→ErrExternalModified（关键守护）、
// mtime 符合→正常写入、expectMtime=0 强制覆盖。

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"litemd/internal/fileio"
)

// TestSaveFile_ExpectMtimeMismatch 审计 R2-G8 关键守护：磁盘 mtime 与
// expectMtime 不符 → 抛 ErrExternalModified，文件内容不变。
func TestSaveFile_ExpectMtimeMismatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "doc.md")
	// 写入初版
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	originalMtime := st.ModTime().Unix()
	originalContent, _ := os.ReadFile(p)

	// 模拟"文件被外部修改"：把 mtime 推后 1 秒
	if err := os.Chtimes(p, st.ModTime().Add(time.Second), st.ModTime().Add(time.Second)); err != nil {
		t.Fatal(err)
	}

	a := NewApp()
	_, err = a.SaveFile(p, "v2_attempted_overwrite", originalMtime)
	if err == nil {
		t.Fatal("冲突时应返回 err，实际为 nil")
	}
	// 错误链应挂上 fileio.ErrExternalModified
	if !errors.Is(err, fileio.ErrExternalModified) {
		t.Fatalf("err 应含 ErrExternalModified，实际 %v", err)
	}
	// 文案应与契约一致（防 wrap 丢失）
	if !strings.Contains(err.Error(), "file modified by another program") {
		t.Fatalf("err 文案应含 'file modified by another program'，实际 %q", err)
	}
	// 关键守护：文件内容必须未被覆盖
	nowContent, _ := os.ReadFile(p)
	if string(nowContent) != string(originalContent) {
		t.Fatalf("冲突时不应写入，原文=%q 现文=%q", originalContent, nowContent)
	}
}

// TestSaveFile_ExpectMtimeMatch 审计 R2-G8 配套：mtime 匹配 → 正常写入。
func TestSaveFile_ExpectMtimeMatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(p)
	a := NewApp()
	mtime, err := a.SaveFile(p, "v2", st.ModTime().Unix())
	if err != nil {
		t.Fatalf("匹配时不应报错: %v", err)
	}
	if mtime == 0 {
		t.Fatal("应返回非零 mtime")
	}
	got, _ := os.ReadFile(p)
	if string(got) != "v2" {
		t.Fatalf("内容写入失败: %q", got)
	}
}

// TestSaveFile_ForceOverwrite 审计 R2-G8 配套：expectMtime=0 → 强制覆盖
// （用户已确认场景），不应走 mtime 检测。
func TestSaveFile_ForceOverwrite(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	// expectMtime=0 强制覆盖（不管磁盘 mtime 是什么）
	if _, err := a.SaveFile(p, "v2_forced", 0); err != nil {
		t.Fatalf("强制覆盖应成功: %v", err)
	}
	got, _ := os.ReadFile(p)
	if string(got) != "v2_forced" {
		t.Fatalf("强制覆盖未生效: %q", got)
	}
}

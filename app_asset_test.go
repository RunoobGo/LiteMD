package main

// app_asset_test.go — CopyImageAsset binding 的安全与功能回归
//
// 审计 R2-G7：CopyImageAsset 是 P0-2 收敛后的"受限资产写入"入口，
// 写入位置由后端从 baseFile 推导（仅 assets/ 内）+ 资产名白名单 +
// 128 字符上限 + 20MB 解码后上限。之前 0 测试覆盖，相当于"任意
// 写入原语"被信任即可；本文件补 ≥4 用例守护该契约。
//
// 配套 app_save_conflict_test.go 覆盖 SaveFile expectMtime 冲突的
// runtime 路径（审计 R2-G8）。

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"litemd/internal/fileio"
)

// TestCopyImageAsset_HappyPath 审计 R2-G7：合法 base64 + 合法扩展名
// 写入文档目录的 assets/ 下，路径与内容正确。
func TestCopyImageAsset_HappyPath(t *testing.T) {
	dir := t.TempDir()
	baseFile := filepath.Join(dir, "note.md")
	if err := os.WriteFile(baseFile, []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 1×1 transparent PNG
	payload := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
	a := NewApp()
	got, err := a.CopyImageAsset(baseFile, "clip.png", payload)
	if err != nil {
		t.Fatalf("happy path: %v", err)
	}
	wantPath := filepath.Join(dir, "assets", "clip.png")
	if got != wantPath {
		t.Fatalf("写入路径 = %q, want %q", got, wantPath)
	}
	// 落盘内容与 base64 解码结果一致
	data, _ := os.ReadFile(got)
	if base64.StdEncoding.EncodeToString(data) != payload {
		t.Fatalf("落盘内容与传入 base64 不一致")
	}
}

// TestCopyImageAsset_RejectsTraversal 审计 R2-G7：资产名含 ../ 必拒
// （结构上不可能"逃出 assets/"）。
func TestCopyImageAsset_RejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	baseFile := filepath.Join(dir, "note.md")
	if err := os.WriteFile(baseFile, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	payload := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
	a := NewApp()
	for _, name := range []string{"../evil.png", "..\\evil.png", "sub/x.png", "a.exe", "a.bat", "a.md", "evil", ""} {
		_, err := a.CopyImageAsset(baseFile, name, payload)
		if err == nil {
			t.Fatalf("资产名 %q 应被拒", name)
		}
		if !errors.Is(err, fileio.ErrInvalidAsset) {
			t.Fatalf("资产名 %q 期望 ErrInvalidAsset，实际 %v", name, err)
		}
	}
}

// TestCopyImageAsset_RejectsBadBase64 审计 R2-G7：非 base64 字符必拒，
// 文件未生成。
func TestCopyImageAsset_RejectsBadBase64(t *testing.T) {
	dir := t.TempDir()
	baseFile := filepath.Join(dir, "note.md")
	if err := os.WriteFile(baseFile, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	got, err := a.CopyImageAsset(baseFile, "x.png", "!!!not base64!!!")
	if err == nil {
		t.Fatalf("坏 base64 应报错，got=%q", got)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "assets", "x.png")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("失败路径不应落盘: %v", statErr)
	}
}

// TestCopyImageAsset_RejectsOversize 审计 R2-G7：超过 20MB 解码上限必拒。
func TestCopyImageAsset_RejectsOversize(t *testing.T) {
	dir := t.TempDir()
	baseFile := filepath.Join(dir, "note.md")
	if err := os.WriteFile(baseFile, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	big := make([]byte, fileio.MaxAssetWriteSize+1)
	payload := base64.StdEncoding.EncodeToString(big)
	a := NewApp()
	_, err := a.CopyImageAsset(baseFile, "big.png", payload)
	if !errors.Is(err, fileio.ErrTooLarge) {
		t.Fatalf("超大应 ErrTooLarge，实际 %v", err)
	}
}

// TestCopyImageAsset_EmptyData 审计 R2-G7：空 base64 必拒，固定文案
// 钉死（与"app not ready"同类，给前端 switch 用）。
func TestCopyImageAsset_EmptyData(t *testing.T) {
	a := NewApp()
	_, err := a.CopyImageAsset("/anywhere/note.md", "x.png", "")
	if err == nil {
		t.Fatal("空数据应报错")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Fatalf("err 应含 'empty'，实际 %q", err)
	}
}

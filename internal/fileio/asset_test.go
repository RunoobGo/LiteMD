package fileio

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================================
// AssetWritePath（P0-2：任意写入原语收敛）
// ============================================================================

func TestAssetWritePath_OK(t *testing.T) {
	base := filepath.Join(t.TempDir(), "note.md")
	got, err := AssetWritePath(base, "abc123_photo.png")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := filepath.Join(filepath.Dir(base), "assets", "abc123_photo.png")
	if got != want {
		t.Fatalf("want %s, got %s", want, got)
	}
}

func TestAssetWritePath_RejectsBadBaseFile(t *testing.T) {
	// 相对路径 baseFile：未保存文档场景必须被拒
	if _, err := AssetWritePath("relative/note.md", "a.png"); !errors.Is(err, ErrInvalidAsset) {
		t.Fatalf("want ErrInvalidAsset for relative base, got %v", err)
	}
	if _, err := AssetWritePath("", "a.png"); !errors.Is(err, ErrInvalidAsset) {
		t.Fatalf("want ErrInvalidAsset for empty base, got %v", err)
	}
}

func TestAssetWritePath_RejectsTraversalAndNested(t *testing.T) {
	base := filepath.Join(t.TempDir(), "note.md")
	cases := []string{
		"../evil.png",
		`..\evil.png`,
		"sub/dir/a.png",
		".",
		"..",
		"",
		"  ",
	}
	for _, name := range cases {
		if _, err := AssetWritePath(base, name); err == nil {
			t.Fatalf("asset name %q should be rejected", name)
		}
	}
}

func TestAssetWritePath_RejectsBadExtension(t *testing.T) {
	base := filepath.Join(t.TempDir(), "note.md")
	for _, name := range []string{"evil.exe", "evil.bat", "evil.md", "evil.ps1", "evil", "a.png.exe"} {
		if _, err := AssetWritePath(base, name); !errors.Is(err, ErrInvalidAsset) {
			t.Fatalf("asset name %q should be rejected with ErrInvalidAsset, got %v", name, err)
		}
	}
	// 双扩展名伪装：只有最后一个扩展名参与判定，.png.exe 已被拒；
	// 白名单内的合法大小写变体应放行
	if _, err := AssetWritePath(base, "a.PNG"); err != nil {
		t.Fatalf("uppercase extension should pass: %v", err)
	}
}

func TestAssetWritePath_RejectsTooLong(t *testing.T) {
	base := filepath.Join(t.TempDir(), "note.md")
	long := strings.Repeat("a", 129-4) + ".png"
	if _, err := AssetWritePath(base, long); !errors.Is(err, ErrInvalidAsset) {
		t.Fatalf("over-length name should be rejected, got %v", err)
	}
}

func TestWriteBase64File_SizeCap(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "big.png")
	// 构造解码后 > 20MB 的 payload
	big := make([]byte, MaxAssetWriteSize+1)
	payload := base64.StdEncoding.EncodeToString(big)
	err := WriteBase64File(p, payload)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
	if _, serr := os.Stat(p); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("failed write must not leave a file behind: %v", serr)
	}
}

func TestWriteBase64File_OversizedPayloadRejectedBeforeDecode(t *testing.T) {
	// 远超上限的 base64 入参应在解码前被拒（内存放大防护）。
	// 用假 base64 字符验证确实没走到解码阶段也会因长度预检先失败。
	dir := t.TempDir()
	p := filepath.Join(dir, "x.png")
	payload := strings.Repeat("A", (MaxAssetWriteSize+2)/3*4+8)
	err := WriteBase64File(p, payload)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge from pre-decode guard, got %v", err)
	}
}

// ============================================================================
// writeAtomic（P0-3：权限保留 + 无临时残留）
// ============================================================================

func TestWriteText_PreservesExistingPermissions(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "note.md")
	if err := os.WriteFile(p, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := WriteText(p, "new"); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := st.Mode().Perm(); got != 0o640 {
		t.Fatalf("permission not preserved: want 0640, got %o", got)
	}
}

func TestWriteBase64File_DefaultPermForNewFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "img.png")
	payload := base64.StdEncoding.EncodeToString([]byte("fakepng"))
	if err := WriteBase64File(p, payload); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	// 新文件不应是 CreateTemp 默认的 0600
	if got := st.Mode().Perm(); got == 0o600 {
		t.Fatalf("new file should not be 0600, got %o", got)
	}
}

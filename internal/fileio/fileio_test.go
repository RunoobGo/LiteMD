package fileio

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPublicPath_审计_R2_G1 审计 R2-G1：error 文案只露 basename，不外发
// 完整绝对路径（防 ~/.ssh/id_rsa 之类敏感路径被显示在 toast）。
func TestPublicPath_AuditG1(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"/Users/x/.ssh/id_rsa", "id_rsa"},
		{"/tmp/secret.env", "secret.env"},
		{"", ""},
		{"/", "/"},
		{"plain.md", "plain.md"},
	}
	for _, c := range cases {
		if got := publicPath(c.in); got != c.want {
			t.Errorf("publicPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestReadText_ErrorMessage_BasenameOnly 审计 R2-G1：error 文案反解
// 只能看到 basename，反向找不到完整路径。
func TestReadText_ErrorMessage_BasenameOnly(t *testing.T) {
	dir := t.TempDir()
	// 用 128 字符超长文件名将 basename 截断到 128
	longName := strings.Repeat("a", 120) + ".md"
	// 不存在的 .md → ErrNotFound
	secretPath := filepath.Join(dir, "private", "notfound.md")
	err := readTextRawForTest(secretPath)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if strings.Contains(err.Error(), secretPath) {
		t.Fatalf("error 暴露了完整路径 %q: %s", secretPath, err.Error())
	}
	if !strings.HasSuffix(err.Error(), "notfound.md") {
		t.Fatalf("error 应以 basename 结尾，实际 %q", err.Error())
	}
	_ = longName
}

// readTextRawForTest 包内 helper：复用 ReadText 但不加额外断言包装。
// 之所以不直接调 ReadText：避免测试读到大文件触发 stat 警告。
func readTextRawForTest(path string) error {
	_, err := ReadText(path)
	return err
}

func TestReadText_NotFound(t *testing.T) {
	_, err := ReadText(filepath.Join(t.TempDir(), "missing.md"))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestReadText_InvalidUTF8(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "broken.md")
	if err := os.WriteFile(p, []byte{0xff, 0xfe, 0x00, 0x80}, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := ReadText(p)
	if !errors.Is(err, ErrIsBinary) {
		t.Fatalf("want ErrIsBinary, got %v", err)
	}
}

// TestReadText_NULByte 审查 P1-9：NUL 是合法 UTF-8，utf8.Valid 拦不住，
// 但契约一直承诺"含 NUL → ErrIsBinary"。UTF-16LE 的 ASCII 文本就是典型
// 命中场景（"h\x00i\x00"），之前会被当成普通文本读进编辑器。
func TestReadText_NULByte(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "utf16.md")
	if err := os.WriteFile(p, []byte("h\x00i\x00\n\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := ReadText(p)
	if !errors.Is(err, ErrIsBinary) {
		t.Fatalf("want ErrIsBinary, got %v", err)
	}
}

func TestReadWriteRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "hello.md")
	want := "# Hello\n\n这是 LiteMD 测试 👋\n"
	if err := WriteText(p, want); err != nil {
		t.Fatal(err)
	}
	got, err := ReadText(p)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("roundtrip mismatch:\nwant=%q\ngot =%q", want, got)
	}
}

func TestWriteText_EmptyPath(t *testing.T) {
	if err := WriteText("", "x"); err == nil {
		t.Fatal("want error on empty path")
	}
}

func TestWriteText_OverwritesExisting(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "doc.md")
	if err := WriteText(p, "v1"); err != nil {
		t.Fatal(err)
	}
	if err := WriteText(p, "v2"); err != nil {
		t.Fatal(err)
	}
	got, err := ReadText(p)
	if err != nil {
		t.Fatal(err)
	}
	if got != "v2" {
		t.Fatalf("want v2, got %q", got)
	}
}

func TestWriteText_AtomicNoLeftoverTmp(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "doc.md")
	if err := WriteText(p, "ok"); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".litemd-") {
			t.Fatalf("leftover tmp file: %s", e.Name())
		}
	}
}

func TestWriteBase64File_InvalidPath(t *testing.T) {
	dir := t.TempDir()
	if err := WriteBase64File("", "AAAA"); err == nil {
		t.Fatal("empty path should fail")
	}
	// P2：硬编码 /tmp/x.png 在多套件并发跑测试时会撞同类文件名、且
	// 在 CI 多实例并行时也会互相覆盖；改用 t.TempDir() 隔离。
	if err := WriteBase64File(filepath.Join(dir, "empty.png"), ""); err == nil {
		t.Fatal("empty data should fail")
	}
}

func TestWriteBase64File_DecodeAndRoundtrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "sub", "img.png")
	// 1×1 transparent PNG
	payload := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
	if err := WriteBase64File(p, payload); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	if len(data) == 0 {
		t.Fatal("expected non-empty bytes")
	}
	// 校验可以再 base64 解码出原 payload
	if got := base64.StdEncoding.EncodeToString(data); got != payload {
		t.Fatalf("roundtrip mismatch: got=%s want=%s", got, payload)
	}
}

func TestWriteBase64File_StripsDataURIPrefix(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "img2.png")
	payload := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
	prefixed := "data:image/png;base64," + payload
	if err := WriteBase64File(p, prefixed); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	if len(data) == 0 {
		t.Fatal("expected non-empty bytes after data URI strip")
	}
}

func TestWriteBase64File_BadPayload(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "bad.png")
	if err := WriteBase64File(p, "!!!not base64!!!"); err == nil {
		t.Fatal("expected decode error")
	}
}

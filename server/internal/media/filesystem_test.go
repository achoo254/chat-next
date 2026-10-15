package media

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
)

func TestFilesystemObjects(t *testing.T) {
	root := t.TempDir()
	f, err := NewFilesystem(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	for _, bad := range []string{"../etc/passwd", "f/../../x", "/abs", "f/a/b", "F/xx", "f/.hidden..", ""} {
		if err := f.Put(ctx, bad, []byte("x"), ""); err == nil {
			t.Errorf("key %q accepted", bad)
		}
	}
	if err := f.Put(ctx, "f/abcdef", []byte("hello world"), ""); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "objects", "f", "ab", "abcdef"))
	if err != nil || info.Mode().Perm() != fileMode {
		t.Fatalf("object file: %v %v", info, err)
	}
	r, err := f.Get(ctx, "f/abcdef", 6, 5)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r)
	_ = r.Close()
	if string(b) != "world" {
		t.Fatalf("range read %q", b)
	}
	if _, err := f.Get(ctx, "f/missing0", 0, -1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := f.Copy(ctx, "f/abcdef", "g/abcdef"); err != nil {
		t.Fatal(err)
	}
	if n, err := f.Size(ctx, "g/abcdef"); err != nil || n != 11 {
		t.Fatalf("copy size %d %v", n, err)
	}

	id, err := f.CreateMultipart(ctx, "staging/upload01")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.UploadPart(ctx, "", "../../etc", 1, strings.NewReader("x"), 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("traversal upload id: %v", err)
	}
	p1, err := f.UploadPart(ctx, "", id, 1, strings.NewReader("abc"), 3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.UploadPart(ctx, "", id, 2, strings.NewReader("de"), 3); err == nil {
		t.Fatal("short part accepted")
	}
	p2, err := f.UploadPart(ctx, "", id, 2, strings.NewReader("def"), 3)
	if err != nil {
		t.Fatal(err)
	}
	parts, err := f.ListParts(ctx, "", id)
	if err != nil || len(parts) != 2 || parts[1].ETag != p2.ETag {
		t.Fatalf("parts %v %v", parts, err)
	}
	if err := f.CompleteMultipart(ctx, "staging/upload01", id, []Part{p1, {Number: 2, ETag: `"wrong"`}}); err == nil ||
		!strings.Contains(err.Error(), "InvalidPart") {
		t.Fatalf("wrong etag: %v", err)
	}
	if err := f.CompleteMultipart(ctx, "staging/upload01", id, []Part{p1, p2}); err != nil {
		t.Fatal(err)
	}
	if n, _ := f.Size(ctx, "staging/upload01"); n != 6 {
		t.Fatalf("joined size %d", n)
	}
	if err := f.AbortMultipart(ctx, "", id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("upload left after complete: %v", err)
	}
	if free, err := f.FreeBytes(); err != nil || free <= 0 {
		t.Fatalf("free %d %v", free, err)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "tmp")); len(entries) != 0 {
		t.Fatalf("temp files left: %d", len(entries))
	}
}

func TestDiskGuard(t *testing.T) {
	st := testdb.Open(t)
	if err := st.EnsureTenant(t.Context(), "primary", "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	f, err := NewFilesystem(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{TenantID: "primary", PublicOrigin: "https://media.test", UploadMaxBytes: 1 << 30, UserQuotaBytes: 1 << 30,
		SessionKey: bytes.Repeat([]byte{7}, 32), MinFreeBytes: 1 << 62}, st.Pool(), f, allowAll{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if s.Config().UploadMode != UploadProxy {
		t.Fatal("filesystem storage must use proxy uploads")
	}
	_, err = s.CreateUpload(t.Context(), 1, &appv1.CreateUploadRequest{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Size: 10,
		FileHash: strings.Repeat("c", 64)})
	if connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatalf("disk guard: %v", err)
	}
}

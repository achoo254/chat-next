package media

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ratelimit"
	"connectrpc.com/connect"
)

func TestUploadStream(t *testing.T) {
	s, _ := newTestService(t)
	ctx := t.Context()
	pdf := []byte("%PDF-1.4\n" + strings.Repeat("x", 100))
	f, err := s.UploadStream(ctx, 9, StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, FileName: "../báo cáo.pdf", Body: bytes.NewReader(pdf)})
	if err != nil {
		t.Fatal(err)
	}
	if f.OwnerID != 9 || f.Size != int64(len(pdf)) || f.MIME != mimePDF || f.Name != "báo cáo.pdf" || f.PublicID == "" {
		t.Fatalf("file = %+v", f)
	}
	// The same bytes again: the stored file, no second copy or upload row.
	again, err := s.UploadStream(ctx, 9, StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Body: bytes.NewReader(pdf)})
	if err != nil || again.ID != f.ID {
		t.Fatalf("again = %+v, %v", again, err)
	}
	var files, pending int
	if err := s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM files WHERE owner_id = 9),
		(SELECT count(*) FROM uploads WHERE owner_id = 9 AND completed_at IS NULL)`).Scan(&files, &pending); err != nil {
		t.Fatal(err)
	}
	if files != 1 || pending != 0 {
		t.Fatalf("files %d, pending uploads %d", files, pending)
	}
	for name, in := range map[string]StreamUpload{
		"too large":     {Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Body: bytes.NewReader(pdf), MaxBytes: 50},
		"empty":         {Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Body: bytes.NewReader(nil)},
		"not the kind":  {Kind: appv1.MediaKind_MEDIA_KIND_PHOTO, Body: bytes.NewReader(pdf)},
		"no kind given": {Body: bytes.NewReader(pdf)},
	} {
		if _, err := s.UploadStream(ctx, 9, in); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Over the quota with the real size: refused, nothing left behind.
	s.cfg.UserQuotaBytes = int64(len(pdf)) + 10
	other := []byte("%PDF-1.4\n" + strings.Repeat("y", 100))
	if _, err := s.UploadStream(ctx, 9, StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Body: bytes.NewReader(other)}); connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatalf("over quota: %v", err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM uploads WHERE owner_id = 9 AND completed_at IS NULL`).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("refused uploads left %d rows, %v", pending, err)
	}
}

type denyAll struct{}

func (denyAll) Allow(ratelimit.Rule, string) bool { return false }

// An upload refused for the owner's rate is still resource_exhausted for a
// client, and says so to a caller that can wait (the bridge) before reading
// a byte of the body.
func TestUploadStreamRateLimitIsRecognisable(t *testing.T) {
	s, _ := newTestService(t)
	s.limiter = denyAll{}
	body := bytes.NewReader([]byte("%PDF-1.4\n"))
	_, err := s.UploadStream(t.Context(), 9, StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Body: body})
	if !errors.Is(err, ErrRateLimited) || connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatalf("err = %v (code %v), want ErrRateLimited with resource_exhausted", err, connect.CodeOf(err))
	}
	if body.Len() != 9 {
		t.Fatalf("the body was read before the rate check: %d bytes left", body.Len())
	}
}

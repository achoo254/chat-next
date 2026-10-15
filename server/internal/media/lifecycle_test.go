package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media/s3test"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store/testdb"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

type allowAll struct{}

func (allowAll) Allow(ratelimit.Rule, string) bool { return true }

func newTestService(t *testing.T) (*Service, *s3test.Server) {
	t.Helper()
	st := testdb.Open(t)
	if err := st.EnsureTenant(t.Context(), "primary", "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	fake := s3test.New(t, "media")
	u, _ := url.Parse(fake.URL)
	objects, err := NewS3(S3Config{Endpoint: u, Region: "r", Bucket: "media", AccessKey: "k", SecretKey: "s", PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{TenantID: "primary", PublicOrigin: "https://media.test", UploadMaxBytes: 1 << 30, UserQuotaBytes: 1 << 30,
		SessionKey: bytes.Repeat([]byte{7}, 32)}, st.Pool(), objects, allowAll{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return s, fake
}

func (s *Service) storeTestFile(t *testing.T, owner int64) *File {
	t.Helper()
	f := &File{PublicID: newPublicID(), TenantID: "primary", OwnerID: owner, Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT,
		MIME: mimeBinary, Key: "f/" + newUUID()}
	if err := s.store(t.Context(), f, []byte("payload")); err != nil {
		t.Fatal(err)
	}
	f.Sizes = []Rendition{{Type: appv1.MediaSizeType_MEDIA_SIZE_TYPE_S, Key: f.Key + ".s", Size: 1}}
	if err := s.objects.Put(t.Context(), f.Key+".s", []byte("s"), mimeJPEG); err != nil {
		t.Fatal(err)
	}
	if err := insertFile(t.Context(), s.pool, f, f.Hash); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestCollectFilesKeepsReferenced(t *testing.T) {
	s, fake := newTestService(t)
	ctx := t.Context()
	gone, kept, young := s.storeTestFile(t, 1), s.storeTestFile(t, 1), s.storeTestFile(t, 1)
	if err := IndexMessage(ctx, s.pool, "primary", 10, 1, &appv1.Message{Media: kept.Ref()}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET created_at = now() - interval '2 days' WHERE id <> $1`, young.ID); err != nil {
		t.Fatal(err)
	}
	n, err := s.CollectFiles(ctx)
	if err != nil || n != 1 {
		t.Fatalf("collected %d, %v", n, err)
	}
	for _, k := range gone.keys() {
		if _, ok := fake.Object(k); ok {
			t.Fatalf("object %s of a collected file left", k)
		}
	}
	if _, ok := fake.Object(kept.Key); !ok {
		t.Fatal("referenced file deleted")
	}
	// Recalled: unreferenced, so collected on the next pass.
	if err := UnindexMessages(ctx, s.pool, 10, []int64{1}); err != nil {
		t.Fatal(err)
	}
	if n, err := s.CollectFiles(ctx); err != nil || n != 1 {
		t.Fatalf("second pass %d, %v", n, err)
	}
}

func TestAbortExpiredUploads(t *testing.T) {
	s, fake := newTestService(t)
	ctx := t.Context()
	resp, err := s.CreateUpload(ctx, 5, &appv1.CreateUploadRequest{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Size: 100,
		FileHash: strings.Repeat("b", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if fake.PendingUploads() != 1 {
		t.Fatal("no multipart upload")
	}
	if n, err := s.AbortExpiredUploads(ctx); err != nil || n != 0 {
		t.Fatalf("fresh upload aborted: %d %v", n, err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE uploads SET expires_at = now() - interval '1 minute'`); err != nil {
		t.Fatal(err)
	}
	// An expired upload cannot be resumed.
	if _, err := s.CreateUpload(ctx, 5, &appv1.CreateUploadRequest{UploadId: resp.GetUpload().GetUploadId()}); err == nil {
		t.Fatal("expired upload resumed")
	}
	if n, err := s.AbortExpiredUploads(ctx); err != nil || n != 1 || fake.PendingUploads() != 0 {
		t.Fatalf("abort: %d %v, pending %d", n, err, fake.PendingUploads())
	}
}

func TestDownloadTokenChecks(t *testing.T) {
	s, _ := newTestService(t)
	h := s.Handler()
	get := func(token string) int {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/f/"+token, nil))
		return rec.Code
	}
	f := s.storeTestFile(t, 1)
	now := time.Now()
	grant := downloadGrant{tenant: "primary", fileID: f.ID, viewer: 1, chatID: 10, seq: 1, expires: now.Add(time.Hour)}
	if code := get(s.sign.download(grant)); code != http.StatusNotFound {
		t.Fatalf("no membership/message: %d", code)
	}
	expired := grant
	expired.expires = now.Add(-time.Second)
	if code := get(s.sign.download(expired)); code != http.StatusForbidden {
		t.Fatalf("expired: %d", code)
	}
	other := grant
	other.tenant = "inetdev"
	if code := get(s.sign.download(other)); code != http.StatusNotFound {
		t.Fatalf("other tenant: %d", code)
	}
	if code := get("not-a-token"); code != http.StatusNotFound {
		t.Fatalf("garbage: %d", code)
	}
	// Proxy part URLs are refused in direct mode.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPut, "/u/x", strings.NewReader("x")))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("proxy part in direct mode: %d", rec.Code)
	}
}

func TestPreviewPhotoCache(t *testing.T) {
	s, _ := newTestService(t)
	ctx := t.Context()
	calls := 0
	img := jpegWithExif(t, 1200, 600, 1)
	fetch := func(context.Context, string, int64) ([]byte, error) {
		calls++
		return img, nil
	}
	f, err := s.PreviewPhoto(ctx, "https://example.com/a.jpg", fetch)
	if err != nil || f == nil || f.OwnerID != 0 || len(f.Sizes) != 2 || f.Width != 1200 {
		t.Fatalf("photo = %+v, %v", f, err)
	}
	again, err := s.PreviewPhoto(ctx, "https://example.com/a.jpg", fetch)
	if err != nil || again.ID != f.ID || calls != 1 {
		t.Fatalf("cache: %v, %d calls", err, calls)
	}
	failing := func(context.Context, string, int64) ([]byte, error) {
		calls++
		return nil, errors.New("blocked")
	}
	for range 2 {
		if p, err := s.PreviewPhoto(ctx, "https://example.com/b.jpg", failing); err != nil || p != nil {
			t.Fatalf("failed fetch: %v %v", p, err)
		}
	}
	if calls != 2 {
		t.Fatalf("failure not cached: %d calls", calls)
	}
}

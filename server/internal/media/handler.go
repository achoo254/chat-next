package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// Download tuning.
const (
	// accessTTL caches a download authorization (a Range burst of one video
	// costs one query); revocation shows within it.
	accessTTL     = 5 * time.Second
	accessMax     = 10000
	ioIdleTimeout = time.Minute
	copyChunk     = 256 << 10
	// cdnMaxAge bounds how long a CDN may keep a response, so a revoked
	// file is gone from the edge within a minute (with accessTTL).
	cdnMaxAge = 50
	pingTTL   = 30 * time.Second
)

// target is what an authorized download reads.
type target struct {
	key, mime, name, hash string
	kind                  appv1.MediaKind
	size                  int64
}

type accessEntry struct {
	t       *target
	expires time.Time
}

// accessCache remembers authorizations by token for accessTTL.
type accessCache struct {
	mu      sync.Mutex
	entries map[string]accessEntry
}

func newAccessCache() *accessCache {
	return &accessCache{entries: map[string]accessEntry{}}
}

func (c *accessCache) get(token string, now time.Time) (*target, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[token]
	if !ok || now.After(e.expires) {
		return nil, false
	}
	return e.t, true
}

func (c *accessCache) put(token string, t *target, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= accessMax {
		for k, e := range c.entries {
			if now.After(e.expires) {
				delete(c.entries, k)
			}
		}
		if len(c.entries) >= accessMax {
			clear(c.entries)
		}
	}
	c.entries[token] = accessEntry{t: t, expires: now.Add(accessTTL)}
}

// Handler serves the media host: GET/HEAD /f/<token> (downloads), PUT
// /u/<token> (upload parts in proxy mode), GET /healthz. Nothing of the app
// is reachable there, and nothing here sets or reads cookies.
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz())
	mux.HandleFunc("GET /f/{token}", s.download)
	mux.HandleFunc("HEAD /f/{token}", s.download)
	mux.HandleFunc("PUT /u/{token}", s.putPart)
	mux.HandleFunc("OPTIONS /", preflight)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		h.Set("Referrer-Policy", "no-referrer")
		// Tokens in the URL are the only credential, so any origin may
		// read (the app fetches media into its cache from a worker).
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag")
		mux.ServeHTTP(w, r)
	})
}

func preflight(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Methods", "GET, HEAD, PUT")
	h.Set("Access-Control-Allow-Headers", "Range, Content-Type, If-None-Match")
	h.Set("Access-Control-Max-Age", "86400")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) healthz() http.HandlerFunc {
	var (
		mu      sync.Mutex
		checked time.Time
		lastErr error
	)
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(checked) > pingTTL {
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			lastErr = s.objects.Ping(ctx)
			cancel()
			checked = time.Now()
		}
		err := lastErr
		mu.Unlock()
		status, body := http.StatusOK, map[string]string{"status": "ok", "storage": "reachable"}
		if err != nil {
			s.logger.Warn("media storage unreachable", "err", err)
			status, body = http.StatusServiceUnavailable, map[string]string{"status": "error", "storage": "unreachable"}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
}

func plain(w http.ResponseWriter, status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, http.StatusText(status)+"\n")
}

// InlineQueryTTL is how long the asker of an inline query may download the
// files of its results.
const InlineQueryTTL = time.Hour

// authorize checks a download token against the database: the message
// still carries the file and the viewer may still see the message, or the
// viewer's inline query (chat 0) still lives and shows the file, or the
// file is still the profile photo of the user named (chat PhotoChat) or
// the photo of a chat the viewer is in (chat ChatPhotoChat).
func (s *Service) authorize(ctx context.Context, token string) (*target, int) {
	now := s.now()
	g, err := s.sign.openDownload(token, now)
	switch {
	case errors.Is(err, errExpired):
		return nil, http.StatusForbidden
	case err != nil:
		return nil, http.StatusNotFound
	case g.tenant != s.cfg.TenantID:
		// Only the tenants served by this process (a suspended or unknown
		// tenant's tokens stop here).
		return nil, http.StatusNotFound
	}
	if t, ok := s.access.get(token, now); ok {
		if t == nil {
			return nil, http.StatusNotFound
		}
		return t, http.StatusOK
	}
	t := &target{}
	var kind, sizes string
	// A message the viewer can see that carries the file; chat 0 is an
	// inline query of the viewer (seq its number) whose results show it.
	args := []any{g.fileID, g.chatID, g.seq, g.viewer, g.tenant}
	through := `
		JOIN message_files mf ON mf.file_id = f.id AND mf.chat_id = $2 AND mf.seq = $3
		JOIN chat_members cm ON cm.chat_id = $2 AND cm.user_id = $4 AND cm.visible_from_seq <= $3
			AND (cm.left_at IS NULL OR cm.left_seq >= $3)`
	switch g.chatID {
	case PhotoChat:
		// A profile photo (seq is its user): still that user's photo, of a
		// live bot or account. Privacy was checked when the grant was made.
		through = `
		JOIN users u ON u.id = $3 AND u.photo_file_id = f.id AND $2::bigint > 0 AND $4::bigint > 0
			AND u.deletion_requested_at IS NULL AND u.deleted_at IS NULL
			AND (NOT u.is_bot OR EXISTS (SELECT 1 FROM bots b WHERE b.user_id = u.id AND b.deleted_at IS NULL))`
	case ChatPhotoChat:
		// A chat's photo (seq is the chat): still its photo, and the viewer
		// still a member.
		through = `
		JOIN chats c ON c.id = $3 AND c.photo_file_id = f.id AND c.deleted_at IS NULL AND $2::bigint > 0
		JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $4 AND cm.left_at IS NULL`
	case 0:
		through = `
		JOIN bot_inline_queries q ON q.num = $3 AND q.user_id = $4 AND q.tenant_id = $5 AND $2::bigint = 0
			AND q.created_at > now() - $6::interval AND f.id = ANY(q.file_ids)`
		args = append(args, InlineQueryTTL.String())
	}
	err = s.pool.QueryRow(ctx, `
		SELECT f.object_key, f.mime_type, f.file_name, f.file_hash, f.kind, f.size, f.sizes::text
		FROM files f`+through+`
		WHERE f.id = $1 AND f.tenant_id = $5`, args...).
		Scan(&t.key, &t.mime, &t.name, &t.hash, &kind, &t.size, &sizes)
	if errors.Is(err, pgx.ErrNoRows) {
		s.access.put(token, nil, now)
		return nil, http.StatusNotFound
	}
	if err != nil {
		s.logger.Error("media authorization failed", "err", err)
		return nil, http.StatusServiceUnavailable
	}
	t.kind = kindOf(kind)
	t.hash = t.hash[:32]
	if g.size != appv1.MediaSizeType_MEDIA_SIZE_TYPE_UNSPECIFIED {
		var list []Rendition
		if err := json.Unmarshal([]byte(sizes), &list); err != nil {
			s.logger.Error("media sizes unreadable", "err", err)
			return nil, http.StatusServiceUnavailable
		}
		f := &File{Sizes: list}
		r, ok := f.rendition(g.size)
		if !ok {
			return nil, http.StatusNotFound
		}
		t.key, t.mime, t.size, t.name = r.Key, mimeJPEG, r.Size, ""
		t.hash += sizeSuffix[g.size]
	}
	s.access.put(token, t, now)
	return t, http.StatusOK
}

// parseRange reads a single "bytes=" range of an object of size; ok is
// false for a range that cannot be satisfied. Several ranges are served as
// the whole object (allowed by RFC 9110).
func parseRange(header string, size int64) (start, length int64, partial, ok bool) {
	spec, found := strings.CutPrefix(header, "bytes=")
	if header == "" || !found || strings.Contains(spec, ",") {
		return 0, size, false, true
	}
	a, b, _ := strings.Cut(strings.TrimSpace(spec), "-")
	if a == "" { // suffix: the last b bytes
		n, err := strconv.ParseInt(b, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false, false
		}
		n = min(n, size)
		return size - n, n, true, true
	}
	first, err := strconv.ParseInt(a, 10, 64)
	if err != nil || first < 0 || first >= size {
		return 0, 0, false, false
	}
	last := size - 1
	if b != "" {
		if last, err = strconv.ParseInt(b, 10, 64); err != nil || last < first {
			return 0, 0, false, false
		}
		last = min(last, size-1)
	}
	return first, last - first + 1, true, true
}

// download streams an authorized object with Range support.
func (s *Service) download(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	t, status := s.authorize(r.Context(), token)
	if status != http.StatusOK {
		plain(w, status)
		return
	}
	h := w.Header()
	etag := `"` + t.hash + `"`
	remaining := int(time.Until(s.tokenExpiry(token)).Seconds())
	h.Set("Cache-Control", fmt.Sprintf("public, max-age=%d, s-maxage=%d", max(remaining, 0), min(max(remaining, 0), cdnMaxAge)))
	h.Set("ETag", etag)
	h.Set("Accept-Ranges", "bytes")
	h.Set("Content-Type", t.mime)
	disposition := "inline"
	if t.kind == appv1.MediaKind_MEDIA_KIND_DOCUMENT || !inlineSafe(t.mime) {
		disposition = "attachment"
	}
	if t.name != "" {
		disposition = mime.FormatMediaType(disposition, map[string]string{"filename": t.name})
		if disposition == "" {
			disposition = "attachment"
		}
	}
	h.Set("Content-Disposition", disposition)
	if inm := r.Header.Get("If-None-Match"); inm != "" && (inm == etag || inm == "*") {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	rangeHeader := r.Header.Get("Range")
	if ir := r.Header.Get("If-Range"); ir != "" && ir != etag {
		rangeHeader = ""
	}
	start, length, partial, ok := parseRange(rangeHeader, t.size)
	if !ok {
		h.Set("Content-Range", fmt.Sprintf("bytes */%d", t.size))
		plain(w, http.StatusRequestedRangeNotSatisfiable)
		return
	}
	h.Set("Content-Length", strconv.FormatInt(length, 10))
	if partial {
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, t.size))
	}
	if r.Method == http.MethodHead {
		if partial {
			w.WriteHeader(http.StatusPartialContent)
		}
		return
	}
	body, err := s.objects.Get(r.Context(), t.key, start, length)
	if err != nil {
		s.logger.Warn("media object read failed", "err", err)
		h.Del("Content-Length")
		h.Del("Content-Range")
		plain(w, http.StatusBadGateway)
		return
	}
	defer func() { _ = body.Close() }()
	if partial {
		w.WriteHeader(http.StatusPartialContent)
	}
	rc := http.NewResponseController(w)
	buf := make([]byte, copyChunk)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			// The server's write timeout is for API calls; a long video
			// only needs to keep moving.
			_ = rc.SetWriteDeadline(time.Now().Add(ioIdleTimeout))
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
		}
		if rerr == io.EOF {
			return
		}
		if rerr != nil {
			s.logger.Warn("media object stream broke", "err", rerr)
			return
		}
	}
}

func (s *Service) tokenExpiry(token string) time.Time {
	g, err := s.sign.openDownload(token, time.Time{})
	if err != nil {
		return time.Time{}
	}
	return g.expires
}

// putPart receives one upload part through the media host (proxy mode)
// and streams it to the storage.
func (s *Service) putPart(w http.ResponseWriter, r *http.Request) {
	if s.cfg.UploadMode != UploadProxy {
		plain(w, http.StatusNotFound)
		return
	}
	g, err := s.sign.openPart(r.PathValue("token"), s.now())
	switch {
	case errors.Is(err, errExpired):
		plain(w, http.StatusForbidden)
		return
	case err != nil:
		plain(w, http.StatusNotFound)
		return
	}
	u, err := scanUpload(s.pool.QueryRow(r.Context(), `SELECT `+uploadColumns+` FROM uploads WHERE id = $1 AND tenant_id = $2`,
		g.uploadID, s.cfg.TenantID))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (u.Completed || !s.now().Before(u.ExpiresAt))) {
		plain(w, http.StatusNotFound)
		return
	}
	if err != nil {
		s.logger.Error("loading an upload failed", "err", err)
		plain(w, http.StatusServiceUnavailable)
		return
	}
	if g.part > partCount(u.Size, u.PartSize) {
		plain(w, http.StatusNotFound)
		return
	}
	want := partLength(u.Size, u.PartSize, g.part)
	if r.ContentLength != want {
		plain(w, http.StatusBadRequest)
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(10 * time.Minute))
	part, err := s.objects.UploadPart(r.Context(), u.StagingKey, u.S3UploadID, g.part, http.MaxBytesReader(w, r.Body, want), want)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			plain(w, http.StatusNotFound)
			return
		}
		s.logger.Warn("proxied upload part failed", "err", err)
		plain(w, http.StatusBadGateway)
		return
	}
	w.Header().Set("ETag", part.ETag)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}

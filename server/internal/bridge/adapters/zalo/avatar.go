package zalo

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"app.local/server/internal/bridge"
)

// avatarRef starts the media ref of a person's photo: "avatar:<https URL>".
const avatarRef = "avatar:"

// avatarHostSuffix is the only place a photo is downloaded from: Zalo's image CDN
// (s120-ava-talk.zadn.vn and the like). The URL comes from Zalo's answer, so it is
// checked before it is stored and again before it is fetched.
const avatarHostSuffix = ".zadn.vn"

// avatarURLMax bounds a photo URL kept in external_users.
const avatarURLMax = 1024

// avatarTimeout bounds one photo download: it runs in the account's sync loop.
const avatarTimeout = 10 * time.Second

// avatarAllowed reports whether a photo URL may be stored and fetched: https on the
// default port, a host under avatarHostSuffix, no credentials.
func avatarAllowed(raw string) bool {
	if raw == "" || len(raw) > avatarURLMax {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return strings.HasSuffix(host, avatarHostSuffix) && len(host) > len(avatarHostSuffix)
}

// withAvatar gives a participant the photo the sidecar found; an empty or unexpected
// URL leaves the photo unknown, so Chat keeps what it has.
func withAvatar(p *bridge.Participant, raw string) {
	if !avatarAllowed(raw) {
		return
	}
	p.PhotoKnown, p.PhotoID, p.PhotoRef = true, raw, avatarRef+raw
}

// avatarClient downloads photos. It follows no redirect: one could lead off the CDN.
var avatarClient = &http.Client{
	Timeout:       avatarTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// fetchAvatar streams a person's photo from Zalo's CDN.
func fetchAvatar(ctx context.Context, raw string) (bridge.MediaStream, error) {
	if !avatarAllowed(raw) {
		return nil, fmt.Errorf("%w: zalo photo URL is not on the image CDN", bridge.ErrNotAllowed)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, fmt.Errorf("zalo: photo request: %w", err)
	}
	resp, err := avatarClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("zalo: photo download failed") // the error names the URL; it is not logged
	}
	mime := resp.Header.Get("Content-Type")
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(mime, "image/") {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("zalo: photo download answered %d %q", resp.StatusCode, safeCode(strings.ReplaceAll(mime, "/", "_")))
	}
	return &avatarStream{resp: resp, mime: mime}, nil
}

// avatarStream is a photo being downloaded.
type avatarStream struct {
	resp *http.Response
	mime string
}

func (s *avatarStream) Read(p []byte) (int, error) { return s.resp.Body.Read(p) }
func (s *avatarStream) Close() error               { return s.resp.Body.Close() }
func (s *avatarStream) MimeType() string           { return s.mime }
func (s *avatarStream) Size() int64 {
	if s.resp.ContentLength < 0 {
		return 0
	}
	return s.resp.ContentLength
}

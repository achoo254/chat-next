// Package linkpreview builds previews (site, title, description, image
// URL) of web pages linked in messages, from their Open Graph tags, and
// fetches the preview image through the same guard.
//
// Fetching a URL a user typed is a server-side request forgery risk, so the
// fetcher only talks to public addresses: the check runs on the address
// actually dialed, after DNS resolution, which also defeats DNS rebinding.
// Only http and https are fetched, without proxies or credentials, with
// bounded time, size and redirects.
package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"app.local/server/internal/entities"
	"app.local/server/internal/safehttp"
	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

// Limits of one fetch and of the stored fields.
const (
	DefaultTimeout = 5 * time.Second
	// DefaultMaxBytes is read up to the end of <head>: some sign-in pages
	// (Google's) carry about 750 KB of inline style and script before <title>.
	DefaultMaxBytes     = 2 << 20
	DefaultMaxRedirects = 3
	MaxURLLength        = 2048

	maxSiteNameRunes    = 128
	maxTitleRunes       = 256
	maxDescriptionRunes = 1024
)

// Preview is the text of a page preview and its image URL.
type Preview struct {
	URL         string
	SiteName    string
	Title       string
	Description string
	// ImageURL is the page's og:image, absolute and normalized; "" when
	// none.
	ImageURL string
}

// Empty reports a preview with nothing to show.
func (p Preview) Empty() bool {
	return p.Title == "" && p.Description == ""
}

var (
	// ErrInvalidURL reports a URL that is not an absolute http(s) URL
	// without credentials, or is too long.
	ErrInvalidURL = errors.New("linkpreview: invalid URL")
	// ErrBlockedAddress reports a URL whose host resolves to an address the
	// fetcher may not contact (private, loopback, link-local, multicast, ...).
	ErrBlockedAddress = errors.New("linkpreview: address not allowed")
	// ErrNotHTML reports a response that is not an HTML page.
	ErrNotHTML = errors.New("linkpreview: not an HTML page")
	// ErrNotImage reports a preview image response that is not a raster
	// image or is too large.
	ErrNotImage = errors.New("linkpreview: not a usable image")
)

// allowedPorts are the ports a preview may be fetched from.
var allowedPorts = map[uint16]bool{80: true, 443: true, 8080: true, 8443: true}

// PublicAddress reports whether the fetcher may connect to ap: a public
// unicast address (safehttp.PublicIP) on a web port.
func PublicAddress(ap netip.AddrPort) bool {
	return safehttp.PublicIP(ap.Addr()) && allowedPorts[ap.Port()]
}

// Options configure a Fetcher; zero values take the defaults.
type Options struct {
	// Allow decides which dialed addresses are reachable; nil is
	// PublicAddress. Tests widen it to reach a local server.
	Allow        func(netip.AddrPort) bool
	Timeout      time.Duration
	MaxBytes     int64
	MaxRedirects int
	UserAgent    string
}

// Fetcher downloads pages and extracts their preview.
type Fetcher struct {
	client    *http.Client
	maxBytes  int64
	userAgent string
}

// NewFetcher returns a Fetcher with its own HTTP client.
func NewFetcher(o Options) *Fetcher {
	allow := o.Allow
	if allow == nil {
		allow = PublicAddress
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	maxBytes := o.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	maxRedirects := o.MaxRedirects
	if maxRedirects <= 0 {
		maxRedirects = DefaultMaxRedirects
	}
	userAgent := o.UserAgent
	if userAgent == "" {
		userAgent = "Mozilla/5.0 (compatible; ChatLinkPreview/1.0)"
	}
	dialer := &net.Dialer{
		Timeout: timeout,
		// Runs for the address actually dialed, after name resolution.
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !allow(ap) {
				return ErrBlockedAddress
			}
			return nil
		},
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    timeout,
		ResponseHeaderTimeout:  timeout,
		MaxResponseHeaderBytes: 64 << 10,
		MaxIdleConns:           16,
		IdleConnTimeout:        30 * time.Second,
	}
	return &Fetcher{
		client: &http.Client{
			Transport: transport,
			Timeout:   timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) > maxRedirects {
					return fmt.Errorf("linkpreview: more than %d redirects", maxRedirects)
				}
				if !entities.IsAllowedWebURL(req.URL.String()) {
					return ErrInvalidURL
				}
				return nil
			},
		},
		maxBytes:  maxBytes,
		userAgent: userAgent,
	}
}

// NormalizeURL validates a URL to preview and returns its canonical form
// (lowercase scheme and host, no fragment), which is also the cache key.
func NormalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > MaxURLLength || !entities.IsAllowedWebURL(raw) {
		return "", ErrInvalidURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", ErrInvalidURL
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Fragment = ""
	u.RawFragment = ""
	if u.Path == "" {
		u.Path = "/"
	}
	// Escaping can make the canonical form longer than the input; it is the
	// cache's primary key and must stay well under the btree entry limit.
	out := u.String()
	if len(out) > MaxURLLength {
		return "", ErrInvalidURL
	}
	return out, nil
}

// Fetch downloads rawURL and returns its preview. The URL must already be
// normalized (NormalizeURL).
func (f *Fetcher) Fetch(ctx context.Context, rawURL string) (Preview, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Preview{}, ErrInvalidURL
	}
	req.Header.Set("User-Agent", f.userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9")
	req.Header.Set("Accept-Language", "vi,en;q=0.8")
	resp, err := f.client.Do(req)
	if err != nil {
		if errors.Is(err, ErrBlockedAddress) {
			return Preview{}, ErrBlockedAddress
		}
		return Preview{}, fmt.Errorf("linkpreview: fetch: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Preview{}, fmt.Errorf("linkpreview: status %d", resp.StatusCode)
	}
	contentType := resp.Header.Get("Content-Type")
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || (mediaType != "text/html" && mediaType != "application/xhtml+xml") {
		return Preview{}, ErrNotHTML
	}
	body, err := charset.NewReader(io.LimitReader(resp.Body, f.maxBytes), contentType)
	if err != nil {
		return Preview{}, fmt.Errorf("linkpreview: charset: %w", err)
	}
	p, image := parse(body)
	p.URL = rawURL
	if p.SiteName == "" {
		p.SiteName = strings.TrimPrefix(resp.Request.URL.Hostname(), "www.")
	}
	if image != "" {
		if ref, err := resp.Request.URL.Parse(image); err == nil {
			if u, err := NormalizeURL(ref.String()); err == nil {
				p.ImageURL = u
			}
		}
	}
	return p, nil
}

// FetchImage downloads a preview image (normalized URL) of at most
// maxBytes with the same address, redirect and time limits as pages. The
// caller still checks the bytes are an image.
func (f *Fetcher) FetchImage(ctx context.Context, rawURL string, maxBytes int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, ErrInvalidURL
	}
	req.Header.Set("User-Agent", f.userAgent)
	req.Header.Set("Accept", "image/webp,image/png,image/jpeg,image/gif;q=0.9")
	resp, err := f.client.Do(req)
	if err != nil {
		if errors.Is(err, ErrBlockedAddress) {
			return nil, ErrBlockedAddress
		}
		return nil, fmt.Errorf("linkpreview: fetch image: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("linkpreview: image status %d", resp.StatusCode)
	}
	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if !strings.HasPrefix(mediaType, "image/") || resp.ContentLength > maxBytes {
		return nil, ErrNotImage
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("linkpreview: read image: %w", err)
	}
	if int64(len(b)) > maxBytes {
		return nil, ErrNotImage
	}
	return b, nil
}

// parse reads the head of an HTML document: og:site_name, og:title and
// og:description, falling back to twitter:* tags, <meta name=description>
// and <title>; and the image URL as written (og:image, twitter:image).
func parse(r io.Reader) (Preview, string) {
	z := html.NewTokenizer(r)
	meta := map[string]string{}
	var title strings.Builder
	inTitle := false
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return finish(meta, title.String()), imageOf(meta)
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "body":
				return finish(meta, title.String()), imageOf(meta)
			case "title":
				inTitle = tt == html.StartTagToken
			case "meta":
				if hasAttr {
					readMeta(z, meta)
				}
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "head":
				return finish(meta, title.String()), imageOf(meta)
			case "title":
				inTitle = false
			}
		case html.TextToken:
			if inTitle && title.Len() < 4096 {
				title.Write(z.Text())
			}
		default:
		}
	}
}

func readMeta(z *html.Tokenizer, meta map[string]string) {
	var key, content string
	for {
		k, v, more := z.TagAttr()
		switch strings.ToLower(string(k)) {
		case "property", "name":
			if key == "" {
				key = strings.ToLower(strings.TrimSpace(string(v)))
			}
		case "content":
			content = string(v)
		}
		if !more {
			break
		}
	}
	if key != "" && content != "" {
		if _, seen := meta[key]; !seen {
			meta[key] = content
		}
	}
}

func imageOf(meta map[string]string) string {
	for _, k := range []string{"og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"} {
		if v := strings.TrimSpace(meta[k]); v != "" && len(v) <= MaxURLLength {
			return v
		}
	}
	return ""
}

func finish(meta map[string]string, title string) Preview {
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := clean(meta[k]); v != "" {
				return v
			}
		}
		return ""
	}
	p := Preview{
		SiteName:    first("og:site_name"),
		Title:       first("og:title", "twitter:title"),
		Description: first("og:description", "twitter:description", "description"),
	}
	if p.Title == "" {
		p.Title = clean(title)
	}
	p.SiteName = truncateRunes(p.SiteName, maxSiteNameRunes)
	p.Title = truncateRunes(p.Title, maxTitleRunes)
	p.Description = truncateRunes(p.Description, maxDescriptionRunes)
	return p
}

// clean collapses white space and drops invalid UTF-8 and control
// characters.
func clean(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return strings.TrimSpace(string(runes[:n-1])) + "…"
}

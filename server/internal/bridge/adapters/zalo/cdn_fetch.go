package zalo

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	"app.local/server/internal/bridge"
)

// cdnMaxBytes is the most a download from Zalo's CDN may bring, the engine's
// cap on a copied file (engine defaultMediaMax): a bigger file stays in Zalo.
const cdnMaxBytes = 25 << 20

// cdnMaxRedirects bounds the redirects of one download; each must stay on the
// hosts the download was allowed for.
const cdnMaxRedirects = 3

// cdnURLAllowed reports whether a URL from Zalo may be stored and fetched: https on
// the default port, no credentials, at most maxLen bytes, and a host strictly under
// one of the suffixes (each starts with a dot, so the bare domain is refused too).
func cdnURLAllowed(raw string, maxLen int, suffixes []string) bool {
	if raw == "" || len(raw) > maxLen {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Opaque != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, suffix := range suffixes {
		if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
			return true
		}
	}
	return false
}

// Why a download was refused before or while it ran. They never name the URL: the
// engine logs the error, and a CDN URL can carry a token.
var (
	errOffCDN        = errors.New("zalo: download left Zalo's CDN")
	errPrivateTarget = errors.New("zalo: download target is not a public address")
	errTooLarge      = errors.New("zalo: download is larger than the copy limit")
)

// cdnClient downloads from Zalo's CDN. Every connection is checked where it is
// dialled, after DNS: only TCP to port 443 of a public address (dialAllowed), so a
// name that resolves to a private, loopback or link-local address is refused
// whatever the URL said. No proxy, no cookie jar, no header but a plain
// User-Agent: the account's session never goes with a download.
type cdnClient struct {
	transport *http.Transport
}

// defaultCDN is the production client, shared by every Adapter.
var defaultCDN = newCDNClient(dialAllowed, nil, nil)

// newCDNClient builds a client. allow decides each dialled address; redirect, for
// tests only, sends every dial to another address (still checked by allow); roots,
// for tests only, replaces the system's certificate roots.
func newCDNClient(allow func(netip.AddrPort) bool, redirect func(string) string, roots *tls.Config) *cdnClient {
	dialer := &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			if network != "tcp4" && network != "tcp6" {
				return errPrivateTarget
			}
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !allow(ap) {
				return errPrivateTarget
			}
			return nil
		},
	}
	tlsConf := &tls.Config{MinVersion: tls.VersionTLS12}
	if roots != nil {
		tlsConf = roots.Clone()
	}
	return &cdnClient{transport: &http.Transport{
		Proxy: nil, // a proxy would be dialled instead of the CDN and escape the check
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if redirect != nil {
				addr = redirect(addr)
			}
			return dialer.DialContext(ctx, network, addr)
		},
		TLSClientConfig:       tlsConf,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
	}}
}

// nonPublic lists the ranges a CDN address is never in, beyond what netip names
// itself (private, loopback, link-local, multicast, unspecified).
var nonPublic = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT, also Tailscale
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), // NAT64 could reach an IPv4 private address
	netip.MustParsePrefix("2001:db8::/32"),
}

// dialAllowed is the production check of a dialled address: port 443 of a public
// unicast address.
func dialAllowed(ap netip.AddrPort) bool {
	if ap.Port() != 443 {
		return false
	}
	ip := ap.Addr().Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range nonPublic {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// get starts the download of raw, which allowed has accepted, and follows
// redirects only to URLs allowed accepts. timeout bounds the whole download,
// body included. A file over cdnMaxBytes is refused before or while it streams.
func (c *cdnClient) get(ctx context.Context, raw string, allowed func(string) bool, timeout time.Duration) (bridge.MediaStream, error) {
	if !allowed(raw) {
		return nil, fmt.Errorf("%w: %w", bridge.ErrNotAllowed, errOffCDN)
	}
	client := &http.Client{
		Transport: c.transport,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > cdnMaxRedirects || !allowed(req.URL.String()) {
				return errOffCDN
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, errors.New("zalo: download request could not be built")
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := client.Do(req)
	if err != nil {
		return nil, downloadError(err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("zalo: download answered %d", resp.StatusCode)
	}
	if resp.ContentLength > cdnMaxBytes {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("%w: %w", bridge.ErrNotAllowed, errTooLarge)
	}
	return &cdnStream{body: resp.Body, mime: resp.Header.Get("Content-Type"), size: max(resp.ContentLength, 0)}, nil
}

// downloadError says why a request failed without the URL the HTTP client puts in
// its errors.
func downloadError(err error) error {
	switch {
	case errors.Is(err, errOffCDN):
		return fmt.Errorf("%w: %w", bridge.ErrNotAllowed, errOffCDN)
	case errors.Is(err, errPrivateTarget):
		return fmt.Errorf("%w: %w", bridge.ErrNotAllowed, errPrivateTarget)
	case errors.Is(err, context.Canceled):
		return context.Canceled
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return errors.New("zalo: download timed out")
	}
	return errors.New("zalo: download failed")
}

// cdnStream is a download in progress. It stops with errTooLarge once more than
// cdnMaxBytes came, whatever the server announced.
type cdnStream struct {
	body io.ReadCloser
	mime string
	size int64
	read int64
}

func (s *cdnStream) Read(p []byte) (int, error) {
	if s.read > cdnMaxBytes {
		return 0, errTooLarge
	}
	if room := cdnMaxBytes + 1 - s.read; int64(len(p)) > room {
		p = p[:room]
	}
	n, err := s.body.Read(p)
	s.read += int64(n)
	if s.read > cdnMaxBytes {
		return n, errTooLarge
	}
	return n, err
}

func (s *cdnStream) Close() error     { return s.body.Close() }
func (s *cdnStream) MimeType() string { return s.mime }
func (s *cdnStream) Size() int64      { return s.size }

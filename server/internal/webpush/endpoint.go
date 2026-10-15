package webpush

import (
	"errors"
	"net/netip"
	"net/url"
	"strings"
)

// EndpointMax bounds the length of a subscription endpoint.
const EndpointMax = 2048

// ErrEndpoint is returned for an endpoint that is not a browser vendor's
// push service.
var ErrEndpoint = errors.New("webpush: endpoint is not a known push service")

// pushHosts are the push services of the browsers: Chrome, Edge (on
// Android), Opera and Samsung Internet use FCM; Firefox Mozilla's
// autopush; Edge on Windows WNS; Safari Apple's. A subscription's
// endpoint is chosen by the client, so the server only ever sends to these
// hosts: an endpoint cannot make it request an internal address (SSRF).
var pushHosts = map[string]bool{
	"fcm.googleapis.com":                true,
	"updates.push.services.mozilla.com": true,
	"web.push.apple.com":                true,
}

// pushHostSuffixes cover services with per-region hosts
// (wns2-<region>.notify.windows.com).
var pushHostSuffixes = []string{".notify.windows.com"}

// CheckEndpoint parses a subscription endpoint and returns it when it is
// an https URL on a known push service (default port, no credentials, no
// fragment). allowLocal also accepts http and https URLs on a loopback
// address with any port, for development and end-to-end tests only.
func CheckEndpoint(raw string, allowLocal bool) (*url.URL, error) {
	if raw == "" || len(raw) > EndpointMax {
		return nil, ErrEndpoint
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return nil, ErrEndpoint
	}
	host := strings.ToLower(u.Hostname())
	if allowLocal && loopback(host) && (u.Scheme == "http" || u.Scheme == "https") {
		return u, nil
	}
	if u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") {
		return nil, ErrEndpoint
	}
	if pushHosts[host] {
		return u, nil
	}
	for _, suffix := range pushHostSuffixes {
		if strings.HasSuffix(host, suffix) && validLabel(strings.TrimSuffix(host, suffix)) {
			return u, nil
		}
	}
	return nil, ErrEndpoint
}

// Audience is the origin of an endpoint, the "aud" of its VAPID token.
func Audience(u *url.URL) string {
	return u.Scheme + "://" + u.Host
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	addr, err := netip.ParseAddr(host)
	return err == nil && addr.IsLoopback()
}

// validLabel accepts one DNS label (the region part of a WNS host).
func validLabel(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

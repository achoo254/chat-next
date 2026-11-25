package zalo

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"app.local/server/internal/bridge"
)

// cdnTestServer is a stand-in for Zalo's CDN: every dial goes to it, whatever the
// URL's host, and its certificate is trusted (as "example.com", the name httptest
// gives it). allow decides the dialled address as in production.
func cdnTestServer(t *testing.T, allow func(netip.AddrPort) bool, h http.HandlerFunc) *Adapter {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	addr := srv.Listener.Addr().String()
	roots := srv.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs //nolint:forcetypeassert // httptest's own client
	cdn := newCDNClient(allow, func(string) string { return addr }, &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12})
	a, _ := newTestAdapter(t, &fakeRunner{})
	a.cdn = cdn
	return a
}

// anyAddress lets the test server, on loopback, be dialled.
func anyAddress(netip.AddrPort) bool { return true }

func fetch(t *testing.T, a *Adapter, ref string) ([]byte, bridge.MediaStream, error) {
	t.Helper()
	s, err := a.FetchMedia(context.Background(), bridge.Account{}, ref)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = s.Close() }()
	body, err := io.ReadAll(s)
	return body, s, err
}

func TestFetchMediaDownloadsAFileWithoutTheSession(t *testing.T) {
	a := cdnTestServer(t, anyAddress, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Errorf("the download carried credentials: %v", r.Header)
		}
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.7"))
	})
	body, s, err := fetch(t, a, mediaRef+testFileURL)
	if err != nil || string(body) != "%PDF-1.7" || s.MimeType() != "application/pdf" || s.Size() != 8 {
		t.Fatalf("body %q, err %v", body, err)
	}
}

func TestFetchMediaFollowsRedirectsOnlyOnTheCDN(t *testing.T) {
	a := cdnTestServer(t, anyAddress, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start":
			http.Redirect(w, r, "https://f2.zdn.vn/end", http.StatusFound)
		case "/end":
			_, _ = w.Write([]byte("ok"))
		case "/off":
			http.Redirect(w, r, "https://evil.example/x", http.StatusFound)
		case "/plain":
			http.Redirect(w, r, "http://f2.zdn.vn/end", http.StatusFound)
		case "/loop":
			http.Redirect(w, r, "https://f2.zdn.vn/loop", http.StatusFound)
		}
	})
	if body, _, err := fetch(t, a, mediaRef+"https://f1.zdn.vn/start"); err != nil || string(body) != "ok" {
		t.Fatalf("redirect on the CDN: body %q, err %v", body, err)
	}
	for _, path := range []string{"/off", "/plain", "/loop"} {
		_, _, err := fetch(t, a, mediaRef+"https://f1.zdn.vn"+path)
		if !errors.Is(err, bridge.ErrNotAllowed) || !errors.Is(err, errOffCDN) {
			t.Errorf("%s: err = %v", path, err)
		}
	}
}

func TestFetchMediaRefusesAFileOverTheCap(t *testing.T) {
	big := bytes.Repeat([]byte{7}, cdnMaxBytes+1)
	a := cdnTestServer(t, anyAddress, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/announced" {
			w.Header().Set("Content-Length", strconv.Itoa(len(big)))
		} else {
			w.Header().Set("Transfer-Encoding", "chunked") // no length: the cap holds while streaming
		}
		_, _ = w.Write(big)
	})
	if _, _, err := fetch(t, a, mediaRef+"https://f1.zdn.vn/announced"); !errors.Is(err, errTooLarge) {
		t.Errorf("announced: err = %v", err)
	}
	body, _, err := fetch(t, a, mediaRef+"https://f1.zdn.vn/streamed")
	if !errors.Is(err, errTooLarge) || len(body) > cdnMaxBytes+1 {
		t.Errorf("streamed: %d bytes, err = %v", len(body), err)
	}
}

func TestFetchMediaAtTheCapIsWhole(t *testing.T) {
	exact := bytes.Repeat([]byte{1}, cdnMaxBytes)
	a := cdnTestServer(t, anyAddress, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Transfer-Encoding", "chunked")
		_, _ = w.Write(exact)
	})
	if body, _, err := fetch(t, a, mediaRef+testPhotoURL); err != nil || len(body) != cdnMaxBytes {
		t.Fatalf("%d bytes, err = %v", len(body), err)
	}
}

// The production check of the dialled address refuses the test server on
// loopback: a CDN name that resolves to a private address is never reached.
func TestFetchMediaRefusesANonPublicAddressAtDialTime(t *testing.T) {
	var reached atomic.Bool
	a := cdnTestServer(t, dialAllowed, func(http.ResponseWriter, *http.Request) { reached.Store(true) })
	_, _, err := fetch(t, a, mediaRef+testPhotoURL)
	if !errors.Is(err, bridge.ErrNotAllowed) || !errors.Is(err, errPrivateTarget) || reached.Load() {
		t.Fatalf("err = %v, reached = %v", err, reached.Load())
	}
}

func TestDialAllowedOnlyPublicHTTPS(t *testing.T) {
	ok := []string{"203.162.4.190:443", "[2402:800::1]:443"}
	bad := []string{"203.162.4.190:80", "127.0.0.1:443", "10.1.2.3:443", "172.16.0.1:443", "192.168.1.1:443",
		"169.254.169.254:443", "100.100.1.1:443", "0.0.0.0:443", "[::1]:443", "[fe80::1]:443", "[fd00::1]:443",
		"[::ffff:127.0.0.1]:443", "[64:ff9b::a00:1]:443", "224.0.0.1:443", "255.255.255.255:443"}
	for _, s := range ok {
		if !dialAllowed(netip.MustParseAddrPort(s)) {
			t.Errorf("%s refused", s)
		}
	}
	for _, s := range bad {
		if dialAllowed(netip.MustParseAddrPort(s)) {
			t.Errorf("%s allowed", s)
		}
	}
}

func TestFetchMediaErrorsNeverNameTheURL(t *testing.T) {
	a := cdnTestServer(t, anyAddress, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/off" {
			http.Redirect(w, r, "https://evil.example/x?token=tok-secret", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusForbidden)
	})
	prod := cdnTestServer(t, dialAllowed, func(http.ResponseWriter, *http.Request) {})
	for _, c := range []struct {
		a   *Adapter
		ref string
	}{{a, mediaRef + testPhotoURL}, {a, mediaRef + "https://f1.zdn.vn/off?token=tok-secret"}, {prod, mediaRef + testFileURL},
		{a, mediaRef + "https://evil.example/?token=tok-secret"}} {
		_, _, err := fetch(t, c.a, c.ref)
		if err == nil || strings.Contains(err.Error(), "tok-secret") || strings.Contains(err.Error(), "zdn.vn") {
			t.Errorf("err = %v", err)
		}
	}
}

func TestFetchMediaRefusesWithoutDialling(t *testing.T) {
	a := &Adapter{}
	for _, ref := range []string{"conv/1", "", mediaRef + "https://evil.example/x", mediaRef + "http://f1.zdn.vn/x", avatarRef + testFileURL} {
		if _, err := a.FetchMedia(context.Background(), bridge.Account{}, ref); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("ref %q: err = %v", ref, err)
		}
	}
}

func TestFetchAvatarRefusesWhatIsNotAnImage(t *testing.T) {
	a := cdnTestServer(t, anyAddress, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>"))
	})
	if _, _, err := fetch(t, a, avatarRef+testAvatar); err == nil {
		t.Fatal("an html page was taken as a photo")
	}
}

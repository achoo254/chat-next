package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

// localOnly allows exactly the test server's address, like PublicAddress
// would allow a public site.
func localOnly(t *testing.T, srv *httptest.Server) func(netip.AddrPort) bool {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	want, err := netip.ParseAddrPort(u.Host)
	if err != nil {
		t.Fatal(err)
	}
	return func(ap netip.AddrPort) bool { return ap == want }
}

const page = `<!doctype html><html><head>
<meta charset="utf-8">
<title>Fallback title</title>
<meta property="og:site_name" content="Ví dụ">
<meta property="og:title" content="  Tiêu đề
  trang ">
<meta name="description" content="plain description">
<meta property="og:description" content="Mô tả Open Graph">
</head><body><meta property="og:title" content="ignored"></body></html>`

func TestFetchParsesOpenGraph(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, page)
	}))
	defer srv.Close()
	f := NewFetcher(Options{Allow: localOnly(t, srv)})
	p, err := f.Fetch(context.Background(), srv.URL+"/a")
	if err != nil {
		t.Fatal(err)
	}
	if p.SiteName != "Ví dụ" || p.Title != "Tiêu đề trang" || p.Description != "Mô tả Open Graph" {
		t.Fatalf("preview = %+v", p)
	}
}

func TestFetchFallsBackToTitleAndHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, `<html><head><title>Only a title</title><meta name="description" content="d"></head></html>`)
	}))
	defer srv.Close()
	p, err := NewFetcher(Options{Allow: localOnly(t, srv)}).Fetch(context.Background(), srv.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "Only a title" || p.Description != "d" || p.SiteName != "127.0.0.1" {
		t.Fatalf("preview = %+v", p)
	}
}

func TestFetchRefusesNonPublicAddresses(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, page)
	}))
	defer srv.Close()
	f := NewFetcher(Options{})
	for _, u := range []string{
		srv.URL + "/", // loopback
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/",
		"http://localhost:" + strings.Split(srv.URL, ":")[2] + "/", // name resolving to loopback
	} {
		_, err := f.Fetch(context.Background(), u)
		if !errors.Is(err, ErrBlockedAddress) {
			t.Errorf("%s: err = %v, want ErrBlockedAddress", u, err)
		}
	}
	if hits != 0 {
		t.Fatalf("blocked fetches reached the server %d times", hits)
	}
}

func TestFetchRedirectsAreCheckedAndBounded(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/to-private":
			http.Redirect(w, r, "http://10.1.2.3/", http.StatusFound)
		case "/to-file":
			http.Redirect(w, r, "file:///etc/passwd", http.StatusFound)
		default: // /loop
			http.Redirect(w, r, srv.URL+"/loop", http.StatusFound)
		}
	}))
	defer srv.Close()
	allow := localOnly(t, srv)
	f := NewFetcher(Options{Allow: allow})
	if _, err := f.Fetch(context.Background(), srv.URL+"/to-private"); !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("redirect to private: %v", err)
	}
	if _, err := f.Fetch(context.Background(), srv.URL+"/to-file"); err == nil {
		t.Fatal("redirect to file: accepted")
	}
	if _, err := f.Fetch(context.Background(), srv.URL+"/loop"); err == nil || !strings.Contains(err.Error(), "redirects") {
		t.Fatalf("redirect loop: %v", err)
	}
}

func TestFetchRejectsNonHTMLAndBoundsSize(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{}`)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		// The title tag starts past the size limit, so it is never seen.
		_, _ = fmt.Fprint(w, "<html><head>"+strings.Repeat("<!-- padding -->", 4096)+"<title>late</title></head></html>")
	}))
	defer srv.Close()
	f := NewFetcher(Options{Allow: localOnly(t, srv), MaxBytes: 1024})
	if _, err := f.Fetch(context.Background(), srv.URL+"/json"); !errors.Is(err, ErrNotHTML) {
		t.Fatalf("json: %v", err)
	}
	p, err := f.Fetch(context.Background(), srv.URL+"/big")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Empty() {
		t.Fatalf("preview past the size limit: %+v", p)
	}
}

func TestNormalizeURL(t *testing.T) {
	for in, want := range map[string]string{
		"HTTPS://Example.COM":          "https://example.com/",
		"https://example.com/a?b=1#x":  "https://example.com/a?b=1",
		" http://example.com/path ":    "http://example.com/path",
		"https://user:pw@example.com/": "",
		"javascript:alert(1)":          "",
		"ftp://example.com/":           "",
		"/relative":                    "",
	} {
		got, err := NormalizeURL(in)
		if want == "" {
			if !errors.Is(err, ErrInvalidURL) {
				t.Errorf("NormalizeURL(%q) = %q, %v; want ErrInvalidURL", in, got, err)
			}
			continue
		}
		if err != nil || got != want {
			t.Errorf("NormalizeURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := NormalizeURL("https://example.com/" + strings.Repeat("a", MaxURLLength)); !errors.Is(err, ErrInvalidURL) {
		t.Error("overlong URL accepted")
	}
}

func TestPublicAddress(t *testing.T) {
	for addr, want := range map[string]bool{
		"93.184.216.34:443":         true,
		"93.184.216.34:22":          false,
		"10.0.0.1:80":               false,
		"172.16.5.4:80":             false,
		"127.0.0.1:443":             false,
		"169.254.169.254:80":        false,
		"100.64.0.1:80":             false,
		"0.0.0.0:80":                false,
		"224.0.0.1:80":              false,
		"[::1]:443":                 false,
		"[fe80::1]:443":             false,
		"[fc00::1]:443":             false,
		"[::ffff:10.0.0.1]:443":     false,
		"[2606:4700::1111]:443":     true,
		"[64:ff9b::a00:1]:443":      false,
		"[2001:db8::1]:443":         false,
		"255.255.255.255:80":        false,
		"198.18.0.1:80":             false,
		"[::ffff:93.184.216.34]:80": true,
	} {
		if got := PublicAddress(netip.MustParseAddrPort(addr)); got != want {
			t.Errorf("PublicAddress(%s) = %v, want %v", addr, got, want)
		}
	}
}

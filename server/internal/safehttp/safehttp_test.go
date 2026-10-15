package safehttp

import (
	"context"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPublicIP(t *testing.T) {
	for addr, want := range map[string]bool{
		"93.184.216.34":         true,
		"2606:4700::1111":       true,
		"10.1.2.3":              false,
		"172.16.0.1":            false,
		"192.168.1.1":           false,
		"127.0.0.1":             false,
		"::1":                   false,
		"169.254.169.254":       false, // cloud metadata
		"fd00:ec2::254":         false, // AWS metadata over IPv6
		"100.64.0.1":            false, // CGNAT
		"0.0.0.0":               false,
		"::":                    false,
		"224.0.0.1":             false,
		"ff02::1":               false,
		"fe80::1":               false,
		"::ffff:127.0.0.1":      false, // IPv4-mapped loopback
		"::ffff:10.0.0.1":       false, // IPv4-mapped private
		"::ffff:93.184.216.34":  true,  // IPv4-mapped public: the IPv4 address decides
		"::10.0.0.1":            false, // IPv4-compatible
		"64:ff9b::a00:1":        false, // NAT64 of 10.0.0.1
		"2002:a00:1::1":         false, // 6to4
		"2001:0:4136:e378::1":   false, // Teredo
		"198.18.0.1":            false,
		"255.255.255.255":       false,
		"fc00::1":               false,
		"2001:db8::1":           false,
		"192.0.2.10":            false,
		"203.0.113.9":           false,
		"240.0.0.1":             false,
		"100.63.255.255":        true,
		"100.128.0.0":           true,
		"8.8.8.8":               true,
		"2a00:1450:4001:81b::e": true,
	} {
		a, err := netip.ParseAddr(addr)
		if err != nil {
			t.Fatalf("%s: %v", addr, err)
		}
		if got := PublicIP(a); got != want {
			t.Errorf("PublicIP(%s) = %v, want %v", addr, got, want)
		}
	}
}

// fakeResolver answers from a list of answers, one per lookup (the last
// one repeats), and counts lookups.
type fakeResolver struct {
	mu      sync.Mutex
	answers [][]string
	calls   int
}

func (r *fakeResolver) LookupNetIP(_ context.Context, _, _ string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	i := min(r.calls, len(r.answers)-1)
	r.calls++
	var out []netip.Addr
	for _, s := range r.answers[i] {
		out = append(out, netip.MustParseAddr(s))
	}
	return out, nil
}

func post(t *testing.T, c *Client, url string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	return c.Do(req)
}

func TestDirectPrivateAddressIsRefused(t *testing.T) {
	c := New(Options{})
	for _, raw := range []string{
		"https://10.0.0.1/hook", "https://127.0.0.1/hook", "https://[::1]/hook", "https://169.254.169.254/latest",
		"https://[::ffff:127.0.0.1]/hook", "https://[::ffff:10.0.0.1]/", "https://[fd00:ec2::254]/", "https://0.0.0.0/",
		"https://100.64.1.1/",
	} {
		if _, err := c.CheckURL(context.Background(), raw); !errors.Is(err, ErrBlocked) {
			t.Errorf("CheckURL(%s) = %v, want ErrBlocked", raw, err)
		}
		if _, err := post(t, c, raw); !errors.Is(err, ErrBlocked) {
			t.Errorf("Do(%s) = %v, want ErrBlocked", raw, err)
		}
	}
}

func TestURLRules(t *testing.T) {
	c := New(Options{Resolver: &fakeResolver{answers: [][]string{{"93.184.216.34"}}}})
	for _, raw := range []string{
		"http://example.com/hook",                          // https only
		"https://example.com:8080/hook",                    // odd port
		"https://example.com:22/",                          // odd port
		"https://user:pw@example.com/",                     // credentials
		"https://example.com/#frag",                        // fragment
		"ftp://example.com/",                               // scheme
		"https:///path",                                    // no host
		"https://example.com:0/",                           // port 0
		"https://" + strings.Repeat("a", URLMax) + ".com/", // too long
	} {
		if _, err := c.CheckURL(context.Background(), raw); !errors.Is(err, ErrURL) {
			t.Errorf("CheckURL(%s) = %v, want ErrURL", raw, err)
		}
	}
	for _, raw := range []string{"https://example.com/hook", "https://example.com:8443/x?y=1", "https://example.com:443/"} {
		if _, err := c.CheckURL(context.Background(), raw); err != nil {
			t.Errorf("CheckURL(%s) = %v", raw, err)
		}
	}
	// An odd port is refused at dial time too (a request built by hand).
	if _, err := post(t, c, "https://example.com:8080/"); !errors.Is(err, ErrURL) {
		t.Errorf("Do on port 8080 = %v", err)
	}
}

func TestDNSRebindingIsRefusedAtDial(t *testing.T) {
	// Public when the URL is saved, private when the request dials.
	r := &fakeResolver{answers: [][]string{{"93.184.216.34"}, {"127.0.0.1"}}}
	c := New(Options{Resolver: r})
	if _, err := c.CheckURL(context.Background(), "https://rebind.example/hook"); err != nil {
		t.Fatalf("save-time check: %v", err)
	}
	if _, err := post(t, c, "https://rebind.example/hook"); !errors.Is(err, ErrBlocked) {
		t.Fatalf("Do after rebinding = %v, want ErrBlocked", err)
	}
	if r.calls != 2 {
		t.Fatalf("lookups = %d, want 2 (the dial resolves again)", r.calls)
	}
	// A name mixing a public and a private address is refused as a whole.
	mixed := New(Options{Resolver: &fakeResolver{answers: [][]string{{"93.184.216.34", "10.0.0.7"}}}})
	if _, err := mixed.CheckURL(context.Background(), "https://mixed.example/"); !errors.Is(err, ErrBlocked) {
		t.Fatalf("mixed answer = %v", err)
	}
	// IPv4-mapped answers are judged by their IPv4 address.
	mapped := New(Options{Resolver: &fakeResolver{answers: [][]string{{"::ffff:10.0.0.1"}}}})
	if _, err := post(t, mapped, "https://mapped.example/"); !errors.Is(err, ErrBlocked) {
		t.Fatalf("mapped answer = %v", err)
	}
}

func TestRedirectIsNotFollowed(t *testing.T) {
	var reached atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Add(1) }))
	defer target.Close()
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/internal", http.StatusTemporaryRedirect)
	}))
	defer src.Close()
	c := New(Options{Development: true})
	resp, err := post(t, c, src.URL)
	if err != nil {
		t.Fatal(err)
	}
	Discard(resp, 1024)
	if resp.StatusCode != http.StatusTemporaryRedirect || reached.Load() != 0 {
		t.Fatalf("status %d, target reached %d times", resp.StatusCode, reached.Load())
	}
	// Outside development the redirect's private target could not be
	// dialed either; the 3xx is what the caller sees.
	prod := New(Options{})
	if _, err := post(t, prod, src.URL); !errors.Is(err, ErrURL) {
		t.Fatalf("http loopback URL in production = %v", err)
	}
}

func TestOversizedResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 2<<20)))
	}))
	defer srv.Close()
	resp, err := post(t, New(Options{Development: true}), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBody(resp, 1<<20); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("ReadBody = %v, want ErrTooLarge", err)
	}
	resp, err = post(t, New(Options{Development: true}), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if b, err := ReadBody(resp, 4<<20); err != nil || len(b) != 2<<20 {
		t.Fatalf("ReadBody within the limit = %d, %v", len(b), err)
	}
}

func TestTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer srv.Close()
	defer close(release)
	start := time.Now()
	_, err := post(t, New(Options{Development: true, Timeout: 200 * time.Millisecond}), srv.URL)
	var ne net.Error
	if !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("err = %v, want a timeout", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v", d)
	}
}

func TestTLSIsVerified(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer srv.Close()
	_, err := post(t, New(Options{Development: true}), srv.URL)
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		t.Fatalf("self-signed certificate: err = %v", err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	tlsConfig := srv.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	tlsConfig.RootCAs = pool
	tlsConfig.InsecureSkipVerify = true // New must turn this off again
	c := New(Options{Development: true, TLS: tlsConfig})
	resp, err := post(t, c, srv.URL)
	if err != nil {
		t.Fatalf("trusted certificate: %v", err)
	}
	Discard(resp, 0)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

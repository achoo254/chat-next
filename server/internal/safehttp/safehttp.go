// Package safehttp makes outbound HTTP requests to URLs that users or bots
// chose (bot webhooks; later file downloads by URL) without letting them
// reach the server's own network (SSRF).
//
// The address check runs when a connection is dialed, on the addresses the
// name actually resolved to: every address of the name must be public
// unicast (no private, loopback, link-local, CGNAT, multicast, unspecified,
// documentation or reserved range, no cloud metadata address, no IPv6 form
// that embeds an IPv4 address: IPv4-mapped, IPv4-compatible,
// IPv4-translated, NAT64, 6to4, Teredo), then the dialer connects to the
// checked address itself and checks the connected address once more. A name that resolves to a public
// address when a URL is saved and to a private one later (DNS rebinding) is
// refused at that later dial. Kept-alive connections are reused only to the
// address that passed the check, at most IdleTimeout after their last use, so
// a DNS change takes effect with the next dial.
//
// Options.Deny refuses more ranges on top of those (the server's own public
// addresses, so a URL cannot reach other sites hosted on the same machine
// through it).
//
// Redirects are never followed (the 3xx answer is returned), only the
// configured ports are dialed, https is required unless the client is built
// for development, TLS certificates are verified, the whole request is
// bounded by Timeout and ReadBody bounds what is read of the answer. The
// environment's proxy settings are ignored.
package safehttp

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
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Defaults.
const (
	DefaultTimeout     = 10 * time.Second
	DefaultIdleTimeout = 30 * time.Second
	// URLMax bounds the length of a URL.
	URLMax = 2048
)

// DefaultPorts are the ports a URL may name.
var DefaultPorts = []uint16{80, 443, 8443}

// Errors. Every refusal of an address wraps ErrBlocked, every refusal of a
// URL ErrURL.
var (
	ErrBlocked  = errors.New("safehttp: address not allowed")
	ErrURL      = errors.New("safehttp: URL not allowed")
	ErrTooLarge = errors.New("safehttp: response too large")
)

// blockedPrefixes are special-purpose ranges netip has no predicate for.
var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),       // "this network"
	netip.MustParsePrefix("100.64.0.0/10"),   // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),    // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // documentation
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"), // documentation
	netip.MustParsePrefix("203.0.113.0/24"),  // documentation
	netip.MustParsePrefix("192.88.99.0/24"),  // 6to4 relay anycast (deprecated)
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved, broadcast
	netip.MustParsePrefix("::/96"),           // IPv4-compatible (embeds IPv4, deprecated)
	netip.MustParsePrefix("64:ff9b::/96"),    // NAT64 (could reach private IPv4)
	netip.MustParsePrefix("64:ff9b:1::/48"),  // local-use NAT64
	netip.MustParsePrefix("100::/64"),        // discard-only
	netip.MustParsePrefix("2001::/23"),       // IETF protocol assignments: Teredo, benchmarking, ORCHID
	netip.MustParsePrefix("2001:db8::/32"),   // documentation
	netip.MustParsePrefix("2002::/16"),       // 6to4 (embeds IPv4)
	netip.MustParsePrefix("3fff::/20"),       // documentation
	netip.MustParsePrefix("5f00::/16"),       // SRv6 SIDs
	netip.MustParsePrefix("fec0::/10"),       // site-local (deprecated)
	netip.MustParsePrefix("fd00:ec2::/32"),   // AWS IMDS over IPv6 (fd00:ec2::254), also inside fc00::/7
	netip.MustParsePrefix("::ffff:0:0:0/96"), // IPv4-translated (SIIT, embeds IPv4)
}

// PublicIP reports whether a is a public unicast address. An IPv4-mapped
// IPv6 address (::ffff:a.b.c.d) is judged by its IPv4 address; 169.254.169.254
// (cloud metadata) is link-local and refused.
func PublicIP(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() ||
		a.IsLinkLocalUnicast() || a.IsMulticast() || a.IsUnspecified() || a.Zone() != "" {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// Resolver looks up the addresses of a host name (net.DefaultResolver).
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Options configure a Client; zero values take the defaults.
type Options struct {
	// Timeout bounds a whole request, from dial to the end of the headers
	// (bound the body with the request's context and ReadBody).
	Timeout time.Duration
	// IdleTimeout bounds how long an idle kept-alive connection is reused.
	IdleTimeout time.Duration
	// Ports a URL may name; DefaultPorts when empty.
	Ports []uint16
	// Development allows http URLs, loopback addresses and any port, for a
	// local receiver in development and end-to-end tests. Never set it in
	// production (config refuses it there).
	Development bool
	// Resolver replaces net.DefaultResolver (tests).
	Resolver Resolver
	// TLS replaces the TLS settings (tests trust their own CA with it);
	// certificates are always verified.
	TLS *tls.Config
	// Deny refuses these ranges too, also in development (see Denied).
	Deny []netip.Prefix
}

// Client sends requests under the policy.
type Client struct {
	http     *http.Client
	ports    []uint16
	dev      bool
	resolver Resolver
	timeout  time.Duration
	deny     []netip.Prefix
}

// New returns a Client with its own connection pool.
func New(o Options) *Client {
	c := &Client{ports: o.Ports, dev: o.Development, resolver: o.Resolver, timeout: o.Timeout, deny: o.Deny}
	if len(c.ports) == 0 {
		c.ports = DefaultPorts
	}
	if c.resolver == nil {
		c.resolver = net.DefaultResolver
	}
	if c.timeout <= 0 {
		c.timeout = DefaultTimeout
	}
	idle := o.IdleTimeout
	if idle <= 0 {
		idle = DefaultIdleTimeout
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if o.TLS != nil {
		tlsConfig = o.TLS.Clone()
		tlsConfig.InsecureSkipVerify = false
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            c.dial,
		TLSClientConfig:        tlsConfig,
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    c.timeout,
		ResponseHeaderTimeout:  c.timeout,
		MaxResponseHeaderBytes: 64 << 10,
		MaxIdleConns:           256,
		MaxIdleConnsPerHost:    100,
		IdleConnTimeout:        idle,
	}
	c.http = &http.Client{
		Transport: transport,
		Timeout:   c.timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return c
}

// CheckURL validates raw as a URL the client may call (scheme, no
// credentials, allowed port, length) and resolves its host: every address
// must be allowed. It answers early when a URL is saved; Do checks the
// addresses again at every dial.
func (c *Client) CheckURL(ctx context.Context, raw string) (*url.URL, error) {
	u, err := c.parse(raw)
	if err != nil {
		return nil, err
	}
	if _, err := c.addresses(ctx, u.Hostname()); err != nil {
		return nil, err
	}
	return u, nil
}

// ParseURL validates raw like CheckURL without resolving its host.
func (c *Client) ParseURL(raw string) (*url.URL, error) {
	return c.parse(raw)
}

func (c *Client) parse(raw string) (*url.URL, error) {
	if len(raw) > URLMax {
		return nil, fmt.Errorf("%w: longer than %d bytes", ErrURL, URLMax)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: not a URL", ErrURL)
	}
	switch {
	case u.Scheme != "https" && (!c.dev || u.Scheme != "http"):
		return nil, fmt.Errorf("%w: the scheme must be https", ErrURL)
	case u.Opaque != "" || u.Host == "" || u.Hostname() == "":
		return nil, fmt.Errorf("%w: the URL needs a host", ErrURL)
	case u.User != nil:
		return nil, fmt.Errorf("%w: credentials in the URL are not allowed", ErrURL)
	case u.Fragment != "":
		return nil, fmt.Errorf("%w: a fragment is not allowed", ErrURL)
	}
	port, err := urlPort(u)
	if err != nil {
		return nil, err
	}
	if !c.portAllowed(port) {
		return nil, fmt.Errorf("%w: port %d is not allowed (use %s)", ErrURL, port, portList(c.ports))
	}
	return u, nil
}

func urlPort(u *url.URL) (uint16, error) {
	raw := u.Port()
	if raw == "" {
		if u.Scheme == "http" {
			return 80, nil
		}
		return 443, nil
	}
	p, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || p == 0 {
		return 0, fmt.Errorf("%w: invalid port", ErrURL)
	}
	return uint16(p), nil
}

func portList(ports []uint16) string {
	parts := make([]string, 0, len(ports))
	for _, p := range ports {
		parts = append(parts, strconv.Itoa(int(p)))
	}
	return strings.Join(parts, ", ")
}

func (c *Client) portAllowed(p uint16) bool {
	return c.dev || slices.Contains(c.ports, p)
}

// allowed is the address policy: public unicast and not denied, plus
// loopback in development.
func (c *Client) allowed(a netip.Addr) bool {
	if Denied(c.deny, a) {
		return false
	}
	return PublicIP(a) || (c.dev && a.Unmap().IsLoopback())
}

// Denied reports whether a (an IPv4-mapped address as its IPv4 address) is
// in one of the ranges.
func Denied(ranges []netip.Prefix, a netip.Addr) bool {
	a = a.Unmap()
	for _, p := range ranges {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// HostAddresses returns the public unicast addresses of this machine's
// network interfaces, each as a single-address prefix. A host behind NAT
// does not see its public address here; list it in the configuration.
func HostAddresses() ([]netip.Prefix, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, fmt.Errorf("safehttp: interface addresses: %w", err)
	}
	var out []netip.Prefix
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipNet.IP)
		if !ok {
			continue
		}
		ip = ip.Unmap()
		if PublicIP(ip) {
			out = append(out, netip.PrefixFrom(ip, ip.BitLen()))
		}
	}
	return out, nil
}

// addresses resolves host (an IP literal stands for itself) and refuses the
// name when any of its addresses is not allowed, so a name cannot mix a
// public address with a private one.
func (c *Client) addresses(ctx context.Context, host string) ([]netip.Addr, error) {
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if a, err := netip.ParseAddr(host); err == nil {
		if !c.allowed(a) {
			return nil, fmt.Errorf("%w: %s", ErrBlocked, a)
		}
		return []netip.Addr{a}, nil
	}
	list, err := c.resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, &DNSError{Host: host, Err: err}
	}
	if len(list) == 0 {
		return nil, &DNSError{Host: host, Err: errors.New("no address")}
	}
	for _, a := range list {
		if !c.allowed(a) {
			return nil, fmt.Errorf("%w: %s resolves to %s", ErrBlocked, host, a)
		}
	}
	return list, nil
}

// DNSError is a host name that did not resolve.
type DNSError struct {
	Host string
	Err  error
}

func (e *DNSError) Error() string { return "safehttp: resolve " + e.Host + ": " + e.Err.Error() }
func (e *DNSError) Unwrap() error { return e.Err }

// dial resolves and checks the host at connection time, then connects to a
// checked address; the dialer's Control checks the address once more.
func (c *Client) dial(ctx context.Context, network, address string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrBlocked, address)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || !c.portAllowed(uint16(port)) {
		return nil, fmt.Errorf("%w: port %s", ErrBlocked, portText)
	}
	addrs, err := c.addresses(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{
		Timeout: c.timeout,
		Control: func(_, connected string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(connected)
			if err != nil || !c.allowed(ap.Addr()) {
				return fmt.Errorf("%w: %s", ErrBlocked, connected)
			}
			return nil
		},
	}
	var errs []error
	for _, a := range addrs {
		conn, err := dialer.DialContext(ctx, network, netip.AddrPortFrom(a, uint16(port)).String())
		if err == nil {
			return conn, nil
		}
		errs = append(errs, err)
		if ctx.Err() != nil {
			break
		}
	}
	return nil, errors.Join(errs...)
}

// Do sends req after checking its URL (the addresses are checked when the
// connection is dialed). The answer of a redirect is returned as is.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	if _, err := c.parse(req.URL.String()); err != nil {
		return nil, err
	}
	return c.http.Do(req)
}

// Timeout is the bound of one request.
func (c *Client) Timeout() time.Duration { return c.timeout }

// CloseIdle closes the kept-alive connections.
func (c *Client) CloseIdle() { c.http.CloseIdleConnections() }

// ReadBody reads at most limit bytes of the body (ErrTooLarge beyond) and
// closes it.
func ReadBody(resp *http.Response, limit int64) ([]byte, error) {
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, ErrTooLarge
	}
	return b, nil
}

// Discard reads and drops up to limit bytes of the body (so the connection
// can be reused) and closes it.
func Discard(resp *http.Response, limit int64) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, limit))
	_ = resp.Body.Close()
}

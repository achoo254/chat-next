// Package miniapp holds the server side of Mini Apps that is shared by the
// Developer Console, the Bot API and the client RPCs: the rules a Mini App
// URL must follow and the Ed25519 signing of the init data handed to it.
//
// Mini Apps run from the bot developer's own https URL (ADR 0010). A URL on
// the app's registrable domain or under a tenant's domain would be same-site
// with chat.<d> and its requests would carry the app's SameSite cookies, so
// such URLs are refused when a bot sets them and again when one is opened.
package miniapp

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"golang.org/x/net/idna"
	"golang.org/x/net/publicsuffix"
)

// URLMax bounds a Mini App URL, in bytes.
const URLMax = 512

// Querier reads the tenants table (a pool or a transaction).
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// URLs checks Mini App URLs for one server.
type URLs struct {
	// appDomain is the registrable domain of the app's public URL
	// (hoandat.com for https://chat.hoandat.com); its host itself when it
	// has none (an IP address or localhost in development).
	appDomain string
}

// NewURLs returns the checker for the app served at publicOrigin
// (config PublicURL). An empty origin (tests of other packages) leaves only
// the tenant domains refused.
func NewURLs(publicOrigin string) (*URLs, error) {
	if publicOrigin == "" {
		return &URLs{}, nil
	}
	u, err := url.Parse(publicOrigin)
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("miniapp: the public origin must be an absolute URL")
	}
	host := strings.ToLower(u.Hostname())
	domain := host
	if _, ipErr := netip.ParseAddr(host); ipErr != nil {
		if d, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
			domain = d
		}
	}
	return &URLs{appDomain: domain}, nil
}

// errURL is the refusal of a Mini App URL; the Console and the Bot API show
// it to the developer.
func errURL(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("mini_app_url_not_allowed: "+format, args...))
}

// Check validates raw for a bot's Mini App: an absolute https URL of at most
// URLMax bytes, without user name, password or fragment (the container adds
// its own), whose host is a public domain name (no IP address, no single
// label) that is neither the app's registrable domain nor under it, nor a
// tenant's domain or under it. Refusals are invalid_argument; a failed read
// of the tenants is returned as is.
//
// The tenant domains are the rows of the tenants table: every tenant this
// database serves (the api role writes its own at start). A tenant of the
// IdP that never enabled chat here is not known in-process (the IdP looks
// tenants up by host, it does not list them); OpenMiniApp checks the URL
// again, so a URL refused later by a new tenant also stops opening.
func (p *URLs) Check(ctx context.Context, q Querier, raw string) error {
	host, err := hostOf(raw)
	if err != nil {
		return err
	}
	refused, err := p.refusedDomains(ctx, q)
	if err != nil {
		return err
	}
	return checkHost(host, refused)
}

// checkHost refuses a host that is one of the refused domains or under one.
func checkHost(host string, refused []string) error {
	for _, d := range refused {
		if host == d || strings.HasSuffix(host, "."+d) {
			return errURL("the URL must not be on %s or a domain under it", d)
		}
	}
	return nil
}

// refusedDomains are the app's registrable domain and the tenant domains.
func (p *URLs) refusedDomains(ctx context.Context, q Querier) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT domain FROM tenants`)
	if err != nil {
		return nil, fmt.Errorf("miniapp: list tenant domains: %w", err)
	}
	domains, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("miniapp: list tenant domains: %w", err)
	}
	out := make([]string, 0, len(domains)+1)
	if p.appDomain != "" {
		out = append(out, p.appDomain)
	}
	for _, d := range domains {
		if d = strings.TrimSuffix(strings.ToLower(d), "."); d != "" {
			// Same-site is decided by the registrable domain, so a tenant
			// stored as a subdomain refuses its siblings too.
			if reg, err := publicsuffix.EffectiveTLDPlusOne(d); err == nil {
				d = reg
			}
			out = append(out, d)
		}
	}
	return out, nil
}

// hostOf applies the rules of a Mini App URL that need no lookup and
// returns its host in lowercase ASCII (punycode).
func hostOf(raw string) (string, error) {
	if len(raw) > URLMax {
		return "", errURL("the URL has more than %d bytes", URLMax)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.Host == "" {
		return "", errURL("the URL must be an absolute https URL")
	}
	if u.User != nil {
		return "", errURL("the URL must not carry a user name or password")
	}
	if strings.Contains(raw, "#") {
		return "", errURL("the URL must not have a fragment (#)")
	}
	host := strings.ToLower(u.Hostname())
	if _, err := netip.ParseAddr(host); err == nil {
		return "", errURL("the host must be a domain name, not an IP address")
	}
	ascii, err := idna.Lookup.ToASCII(host)
	if err != nil || ascii == "" || strings.HasSuffix(ascii, ".") {
		return "", errURL("the host is not a valid domain name")
	}
	labels := strings.Split(ascii, ".")
	// Browsers read a host whose last label is a number as an IPv4 address
	// (WHATWG URL: 127.1, 0x7f.1).
	if len(labels) < 2 || numericLabel(labels[len(labels)-1]) {
		return "", errURL("the host must be a public domain name")
	}
	if _, err := publicsuffix.EffectiveTLDPlusOne(ascii); err != nil {
		return "", errURL("the host must be a public domain name")
	}
	return ascii, nil
}

// numericLabel reports whether a host label is a number in the WHATWG
// sense: decimal digits, or 0x followed by hex digits.
func numericLabel(label string) bool {
	digits, base := label, "0123456789"
	if rest, ok := strings.CutPrefix(label, "0x"); ok {
		digits, base = rest, "0123456789abcdef"
	}
	for _, r := range digits {
		if !strings.ContainsRune(base, r) {
			return false
		}
	}
	return label != ""
}

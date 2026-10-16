// Package config reads the server configuration from environment variables.
// Errors name the variable and never include its value, because several
// variables hold secrets.
package config

import (
	"crypto/ecdsa"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"app.local/server/internal/webpush"
)

// Environments.
const (
	EnvProduction  = "production"
	EnvDevelopment = "development"
)

// Defaults of optional variables.
const (
	DefaultListenAddr   = "127.0.0.1:4600"
	DefaultTenantID     = "primary"
	DefaultTenantDomain = "hoandat.com"
	// DefaultAppURLScheme matches urlScheme in brand.config.json.
	DefaultAppURLScheme = "com.hoandat.chat"
)

// SessionKeyMinLen is the minimum decoded length of SESSION_KEY.
const SessionKeyMinLen = 32

// Config is the configuration of the api role.
type Config struct {
	Env              string
	ListenAddr       string
	PublicURL        *url.URL // origin only: scheme://host[:port]
	DatabaseURL      string
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string
	SessionKey       []byte
	TenantID         string
	TenantDomain     string
	// AppURLScheme is the app's own scheme allowed in message links
	// (ADR 0004).
	AppURLScheme string
	// DevOrigins is empty in production even when DEV_ORIGINS is set.
	DevOrigins []string
	// OperatorUserIDs may use the moderation queue (CHAT_OPERATOR_USER_IDS);
	// empty by default, so nobody can.
	OperatorUserIDs []int64
	// BotWebhookLocal lets bot webhooks use http, loopback addresses and any
	// port (BOT_WEBHOOK_ALLOW_LOCAL, development only: a local receiver in
	// development and end-to-end tests).
	BotWebhookLocal bool
	// OutboundDeny are addresses (or CIDR ranges) that requests to URLs
	// chosen by users and bots never reach (OUTBOUND_DENY_CIDRS): the
	// server's own public addresses, so a bot webhook or a link preview
	// cannot call other sites hosted on the same machine. The public
	// addresses of the host's interfaces are refused as well (api role).
	OutboundDeny []netip.Prefix
	// Media is nil when MEDIA_S3_ENDPOINT is unset: media RPCs then answer
	// failed_precondition and AppConfig.upload_size_max_bytes is 0.
	Media *Media
	// WebPush is nil when WEB_PUSH_VAPID_PRIVATE_KEY is unset: PushService
	// then reports no key and refuses registrations.
	WebPush *WebPush
	// Abuse holds the anti-spam thresholds (ABUSE_*).
	Abuse Abuse
}

// Abuse holds the anti-spam thresholds. Each comes from its ABUSE_*
// variable, defaults to the value in DefaultAbuse, and 0 turns its rule off.
type Abuse struct {
	// StrangerChatsNew caps the private chats a young account starts with
	// strangers in 24 hours (ABUSE_STRANGER_CHATS_NEW).
	StrangerChatsNew int
	// StrangerChats is the same cap for older accounts (ABUSE_STRANGER_CHATS).
	StrangerChats int
	// NewAccountDays is the age below which an account is young
	// (ABUSE_NEW_ACCOUNT_DAYS).
	NewAccountDays int
	// Reporters is how many distinct people with open reports against an
	// account in 30 days stop its new chats with strangers until a moderator
	// reviews them (ABUSE_REPORTERS).
	Reporters int
	// SignupsPerIPHour caps the chat accounts created at first sign-in from
	// one address in an hour (ABUSE_SIGNUPS_PER_IP_HOUR).
	SignupsPerIPHour int
	// SignupsPer10Min caps the chat accounts the tenant creates in ten
	// minutes (ABUSE_SIGNUPS_PER_10MIN).
	SignupsPer10Min int
}

// DefaultAbuse are the thresholds used when ABUSE_* are unset.
func DefaultAbuse() Abuse {
	return Abuse{StrangerChatsNew: 20, StrangerChats: 50, NewAccountDays: 7, Reporters: 3, SignupsPerIPHour: 30, SignupsPer10Min: 300}
}

// abuseValueMax bounds every ABUSE_* value.
const abuseValueMax = 1_000_000

func loadAbuse(get func(string) string) (Abuse, []error) {
	a := DefaultAbuse()
	var errs []error
	for _, v := range []struct {
		name string
		dst  *int
	}{
		{"ABUSE_STRANGER_CHATS_NEW", &a.StrangerChatsNew},
		{"ABUSE_STRANGER_CHATS", &a.StrangerChats},
		{"ABUSE_NEW_ACCOUNT_DAYS", &a.NewAccountDays},
		{"ABUSE_REPORTERS", &a.Reporters},
		{"ABUSE_SIGNUPS_PER_IP_HOUR", &a.SignupsPerIPHour},
		{"ABUSE_SIGNUPS_PER_10MIN", &a.SignupsPer10Min},
	} {
		raw := get(v.name)
		if raw == "" {
			continue
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > abuseValueMax {
			errs = append(errs, invalid(v.name, fmt.Sprintf("must be a whole number from 0 to %d", abuseValueMax)))
			continue
		}
		*v.dst = n
	}
	return a, errs
}

// WebPush configures notifications to closed browser apps (package push).
type WebPush struct {
	// VAPIDKey is the VAPID private key (WEB_PUSH_VAPID_PRIVATE_KEY): the
	// 32-byte P-256 scalar, base64url. Its public key is derived from it.
	VAPIDKey *ecdsa.PrivateKey
	// Subject is the operator contact push services see (WEB_PUSH_SUBJECT,
	// mailto: or https:); CHAT_PUBLIC_URL by default.
	Subject string
	// AllowLocal accepts loopback endpoints (WEB_PUSH_ALLOW_LOCAL,
	// development only: the end-to-end tests' push receiver).
	AllowLocal bool
}

// Development reports whether the server runs in the development environment.
func (c Config) Development() bool {
	return c.Env == EnvDevelopment
}

// PublicOrigin is the origin of CHAT_PUBLIC_URL, e.g. https://chat.hoandat.com.
func (c Config) PublicOrigin() string {
	return c.PublicURL.Scheme + "://" + c.PublicURL.Host
}

// Lookup reads one variable, like os.LookupEnv.
type Lookup func(key string) (string, bool)

// VarError reports a missing or invalid variable without its value.
type VarError struct {
	Name   string
	Reason string
}

func (e *VarError) Error() string {
	return e.Name + ": " + e.Reason
}

func missing(name string) error {
	return &VarError{Name: name, Reason: "is required"}
}

func invalid(name, reason string) error {
	return &VarError{Name: name, Reason: reason}
}

var (
	tenantIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	schemePattern   = regexp.MustCompile(`^[a-z][a-z0-9+.-]{0,62}$`)
	domainPattern   = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
)

// Load reads and validates the api configuration. Every problem is reported
// (joined), not only the first.
func Load(lookup Lookup) (Config, error) {
	var errs []error
	get := func(name string) string {
		v, _ := lookup(name)
		return strings.TrimSpace(v)
	}
	required := func(name string) string {
		v := get(name)
		if v == "" {
			errs = append(errs, missing(name))
		}
		return v
	}
	orDefault := func(name, def string) string {
		if v := get(name); v != "" {
			return v
		}
		return def
	}

	c := Config{
		Env:              required("CHAT_ENV"),
		ListenAddr:       orDefault("CHAT_LISTEN_ADDR", DefaultListenAddr),
		DatabaseURL:      required("DATABASE_URL"),
		OIDCClientID:     required("OIDC_CLIENT_ID"),
		OIDCClientSecret: required("OIDC_CLIENT_SECRET"),
		TenantID:         orDefault("TENANT_ID", DefaultTenantID),
		TenantDomain:     strings.ToLower(orDefault("TENANT_DOMAIN", DefaultTenantDomain)),
		AppURLScheme:     strings.ToLower(orDefault("APP_URL_SCHEME", DefaultAppURLScheme)),
	}
	if c.Env != "" && c.Env != EnvProduction && c.Env != EnvDevelopment {
		errs = append(errs, invalid("CHAT_ENV", "must be production or development"))
	}
	production := c.Env == EnvProduction

	if _, port, err := net.SplitHostPort(c.ListenAddr); err != nil || port == "" {
		errs = append(errs, invalid("CHAT_LISTEN_ADDR", "must be host:port"))
	}

	if raw := required("CHAT_PUBLIC_URL"); raw != "" {
		u, err := parseOrigin(raw)
		switch {
		case err != nil:
			errs = append(errs, invalid("CHAT_PUBLIC_URL", err.Error()))
		case production && u.Scheme != "https":
			errs = append(errs, invalid("CHAT_PUBLIC_URL", "must use https in production"))
		default:
			c.PublicURL = u
		}
	}

	if raw := required("OIDC_ISSUER"); raw != "" {
		u, err := url.Parse(raw)
		switch {
		case err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.RawQuery != "" || u.Fragment != "":
			errs = append(errs, invalid("OIDC_ISSUER", "must be an absolute http(s) URL"))
		case production && u.Scheme != "https":
			errs = append(errs, invalid("OIDC_ISSUER", "must use https in production"))
		default:
			c.OIDCIssuer = raw
		}
	}

	if raw := required("SESSION_KEY"); raw != "" {
		key, err := decodeKey(raw)
		switch {
		case err != nil:
			errs = append(errs, invalid("SESSION_KEY", "must be base64"))
		case len(key) < SessionKeyMinLen:
			errs = append(errs, invalid("SESSION_KEY", fmt.Sprintf("must decode to at least %d bytes", SessionKeyMinLen)))
		default:
			c.SessionKey = key
		}
	}

	if !tenantIDPattern.MatchString(c.TenantID) {
		errs = append(errs, invalid("TENANT_ID", "must match "+tenantIDPattern.String()))
	}
	if !schemePattern.MatchString(c.AppURLScheme) || c.AppURLScheme == "http" || c.AppURLScheme == "https" {
		errs = append(errs, invalid("APP_URL_SCHEME", "must be a URL scheme like com.example.chat"))
	}
	if !domainPattern.MatchString(c.TenantDomain) {
		errs = append(errs, invalid("TENANT_DOMAIN", "must be a domain name"))
	}

	if raw := get("DEV_ORIGINS"); raw != "" && !production {
		for item := range strings.SplitSeq(raw, ",") {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			u, err := parseOrigin(item)
			if err != nil {
				errs = append(errs, invalid("DEV_ORIGINS", "every item must be an origin like http://localhost:5173"))
				break
			}
			c.DevOrigins = append(c.DevOrigins, u.Scheme+"://"+u.Host)
		}
	}

	if raw := get("CHAT_OPERATOR_USER_IDS"); raw != "" {
		ids, err := parseUserIDs(raw)
		if err != nil {
			errs = append(errs, invalid("CHAT_OPERATOR_USER_IDS", err.Error()))
		}
		c.OperatorUserIDs = ids
	}

	switch raw := get("BOT_WEBHOOK_ALLOW_LOCAL"); raw {
	case "", "false", "0":
	case "true", "1":
		if production {
			errs = append(errs, invalid("BOT_WEBHOOK_ALLOW_LOCAL", "is only allowed when CHAT_ENV=development"))
		}
		c.BotWebhookLocal = !production
	default:
		errs = append(errs, invalid("BOT_WEBHOOK_ALLOW_LOCAL", "must be true or false"))
	}

	if raw := get("OUTBOUND_DENY_CIDRS"); raw != "" {
		deny, err := parsePrefixes(raw)
		if err != nil {
			errs = append(errs, invalid("OUTBOUND_DENY_CIDRS", err.Error()))
		}
		c.OutboundDeny = deny
	}

	media, mediaErrs := loadMedia(get, production, c.PublicURL)
	errs = append(errs, mediaErrs...)
	c.Media = media

	webPush, webPushErrs := loadWebPush(get, production, c.PublicURL)
	errs = append(errs, webPushErrs...)
	c.WebPush = webPush

	abuse, abuseErrs := loadAbuse(get)
	errs = append(errs, abuseErrs...)
	c.Abuse = abuse

	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return c, nil
}

// operatorIDsMax bounds CHAT_OPERATOR_USER_IDS.
const operatorIDsMax = 100

// parseUserIDs reads a comma-separated list of positive user ids below
// 2^53 (ADR 0001), ignoring empty items and duplicates.
func parseUserIDs(raw string) ([]int64, error) {
	seen := map[int64]bool{}
	var ids []int64
	for item := range strings.SplitSeq(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		id, err := strconv.ParseInt(item, 10, 64)
		if err != nil || id <= 0 || id >= 1<<53 {
			return nil, errors.New("must be a comma-separated list of user ids")
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) > operatorIDsMax {
		return nil, fmt.Errorf("at most %d user ids", operatorIDsMax)
	}
	return ids, nil
}

// outboundDenyMax bounds OUTBOUND_DENY_CIDRS.
const outboundDenyMax = 100

// parsePrefixes reads a comma-separated list of IP addresses and CIDR
// ranges (an address is a range of one), ignoring empty items. IPv4-mapped
// IPv6 forms are stored as IPv4.
func parsePrefixes(raw string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for item := range strings.SplitSeq(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		var p netip.Prefix
		if strings.Contains(item, "/") {
			parsed, err := netip.ParsePrefix(item)
			if err != nil {
				return nil, errors.New("must be a comma-separated list of IP addresses or CIDR ranges")
			}
			p = parsed
		} else {
			a, err := netip.ParseAddr(item)
			if err != nil || a.Zone() != "" {
				return nil, errors.New("must be a comma-separated list of IP addresses or CIDR ranges")
			}
			p = netip.PrefixFrom(a, a.BitLen())
		}
		if p.Addr().Is4In6() && p.Bits() >= 96 {
			p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
		}
		out = append(out, p.Masked())
	}
	if len(out) > outboundDenyMax {
		return nil, fmt.Errorf("at most %d items", outboundDenyMax)
	}
	return out, nil
}

// LoadDatabaseURL reads only DATABASE_URL, for the migrate role.
func LoadDatabaseURL(lookup Lookup) (string, error) {
	v, _ := lookup("DATABASE_URL")
	if v = strings.TrimSpace(v); v == "" {
		return "", missing("DATABASE_URL")
	}
	return v, nil
}

// parseOrigin accepts scheme://host[:port] with an optional trailing slash
// and nothing else.
func parseOrigin(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil {
		return nil, errors.New("must be an absolute URL like https://chat.example.com")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, errors.New("must use http or https")
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("must not have a path, query or fragment")
	}
	return &url.URL{Scheme: u.Scheme, Host: strings.ToLower(u.Host)}, nil
}

// decodeKey accepts standard or URL-safe base64, padded or not.
func decodeKey(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("not base64")
}

// loadWebPush reads the WEB_PUSH_* variables; nil without a VAPID key.
func loadWebPush(get func(string) string, production bool, public *url.URL) (*WebPush, []error) {
	var errs []error
	allowLocal := false
	switch raw := get("WEB_PUSH_ALLOW_LOCAL"); raw {
	case "", "false", "0":
	case "true", "1":
		if production {
			errs = append(errs, invalid("WEB_PUSH_ALLOW_LOCAL", "is only allowed when CHAT_ENV=development"))
		}
		allowLocal = !production
	default:
		errs = append(errs, invalid("WEB_PUSH_ALLOW_LOCAL", "must be true or false"))
	}
	raw := get("WEB_PUSH_VAPID_PRIVATE_KEY")
	if raw == "" {
		if get("WEB_PUSH_SUBJECT") != "" {
			errs = append(errs, invalid("WEB_PUSH_SUBJECT", "needs WEB_PUSH_VAPID_PRIVATE_KEY"))
		}
		return nil, errs
	}
	key, err := webpush.ParseVAPIDKey(raw)
	if err != nil {
		errs = append(errs, invalid("WEB_PUSH_VAPID_PRIVATE_KEY", "must be a base64url P-256 private key (32 bytes)"))
	}
	subject := get("WEB_PUSH_SUBJECT")
	switch {
	case subject != "" && !strings.HasPrefix(subject, "mailto:") && !strings.HasPrefix(subject, "https://"):
		errs = append(errs, invalid("WEB_PUSH_SUBJECT", "must be a mailto: or https: URI"))
	case subject == "" && public != nil && public.Scheme == "https":
		subject = public.String()
	case subject == "":
		errs = append(errs, invalid("WEB_PUSH_SUBJECT", "is required when CHAT_PUBLIC_URL is not https"))
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return &WebPush{VAPIDKey: key, Subject: subject, AllowLocal: allowLocal}, nil
}

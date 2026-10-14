// Package config reads the server configuration from environment variables.
// Errors name the variable and never include its value, because several
// variables hold secrets.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
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
	// DevOrigins is empty in production even when DEV_ORIGINS is set.
	DevOrigins []string
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

	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return c, nil
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

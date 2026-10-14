package auth

import "strings"

// Origins is the allowlist of browser origins that may send cookie-backed
// requests: the public origin of the tenant, plus DEV_ORIGINS in
// development. Together with SameSite=Strict it blocks CSRF (ADR 0006).
type Origins struct {
	allowed map[string]struct{}
}

// NewOrigins builds the allowlist; origins are compared case-insensitively.
func NewOrigins(public string, extra ...string) *Origins {
	o := &Origins{allowed: make(map[string]struct{}, 1+len(extra))}
	for _, origin := range append([]string{public}, extra...) {
		o.allowed[strings.ToLower(strings.TrimSuffix(origin, "/"))] = struct{}{}
	}
	return o
}

// Allowed reports whether an Origin header value is allowed. A missing or
// opaque ("null") origin never is.
func (o *Origins) Allowed(origin string) bool {
	if origin == "" || origin == "null" {
		return false
	}
	_, ok := o.allowed[strings.ToLower(origin)]
	return ok
}

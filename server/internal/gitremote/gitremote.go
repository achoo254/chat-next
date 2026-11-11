// Package gitremote turns a git remote URL into the canonical key that
// identifies a repository across machines and URL forms, so a project of
// the AI Agent links one repository however each clone names its remote.
//
// The rule follows Orca's normalizeGitRemoteUrl and its key comparison
// (stablyai/orca, src/shared/git/remotes/git-remote-identity.ts): ssh,
// scp-like (user@host:path) and http(s) forms of one repository give the
// same key "<host>/<path>": the scheme, the user, the port, leading and
// trailing slashes and a trailing ".git" are dropped, and the whole key is
// lower case (Orca lowercases keys when it compares them). Local paths
// (file://, a drive letter, a bare path) have no key.
//
// One deviation keeps secrets out of keys: a key holding "@" is refused, so
// a malformed "user:password@host:path" never stores its password. Shared
// test vectors: spec/git-remote/test-vectors.json.
package gitremote

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits of a remote URL and of its key, in bytes.
const (
	MaxURLLen = 2048
	MaxKeyLen = 512
)

var (
	// Orca: /^[A-Za-z]:[\\/]/ (a Windows path, never a remote).
	drivePathRE = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
	// Orca: /^([^@\s:]+@)?([^:\s]+):(.+)$/ (user@host:path).
	scpRE = regexp.MustCompile(`^([^@\s:]+@)?([^:\s]+):(.+)$`)
)

// Canonical returns the key of a git remote URL, and false when the URL is
// not a remote (empty, local, malformed, too long or with control
// characters).
func Canonical(remote string) (string, bool) {
	trimmed := strings.TrimSpace(remote)
	if trimmed == "" || len(trimmed) > MaxURLLen || !utf8.ValidString(trimmed) || hasControl(trimmed) {
		return "", false
	}
	if drivePathRE.MatchString(trimmed) {
		return "", false
	}
	var host, path string
	if m := scpRE.FindStringSubmatch(trimmed); !strings.Contains(trimmed, "://") && m != nil {
		host, path = m[2], m[3]
	} else {
		u, err := url.Parse(trimmed)
		if err != nil {
			return "", false
		}
		host, path = u.Hostname(), u.EscapedPath()
	}
	host = strings.ToLower(strings.TrimSpace(host))
	path = normalizePath(path)
	if host == "" || path == "" {
		return "", false
	}
	key := strings.ToLower(host + "/" + path)
	if strings.Contains(key, "@") || len(key) > MaxKeyLen {
		return "", false
	}
	return key, true
}

// normalizePath drops leading and trailing slashes, then a trailing ".git".
func normalizePath(path string) string {
	path = strings.TrimRight(strings.TrimLeft(path, "/"), "/")
	return strings.TrimSuffix(path, ".git")
}

func hasControl(s string) bool {
	return strings.ContainsFunc(s, unicode.IsControl)
}

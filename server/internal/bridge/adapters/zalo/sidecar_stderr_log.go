package zalo

import (
	"bufio"
	"io"
	"log/slog"
	"net/netip"
	"regexp"
	"strings"
)

// maxStderrLine bounds one stderr line; the sidecar's own lines are short.
const maxStderrLine = 4 << 10

// hostName is a DNS name as the egress guard prints it.
var hostName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// isLoggableBlockedName reports whether a refused connection target is a plain DNS
// name: not an IP address, not the "unix-socket" marker, not free text.
func isLoggableBlockedName(target string) bool {
	if target == "" || target == "unix-socket" || len(target) > 253 || !hostName.MatchString(target) {
		return false
	}
	_, err := netip.ParseAddr(target)
	return err != nil
}

// logStderr reads the sidecar's stderr until it closes and logs only what the
// protocol allows there: the name of a Zalo host connected to (the firewall's
// allow-list is learnt from these), or the fact that a connection was blocked.
// Any other line is reported without its text: stderr is not trusted to be
// free of message text, cookies or ids.
func logStderr(r io.Reader, logger *slog.Logger) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1<<10), maxStderrLine)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "host "):
			if host := strings.TrimPrefix(line, "host "); len(host) <= 253 && hostName.MatchString(host) {
				logger.Info("zalo sidecar connected to a host", "host", host)
			} else {
				logger.Debug("zalo sidecar reported a host that is not a plain name")
			}
		case line == "blocked" || strings.HasPrefix(line, "blocked "):
			// The refused target is a DNS name, an IP address or the word "unix-socket": the
			// name is what completes the allow-list, so only a plain DNS name is logged; an IP
			// address (it can come from a server response) never is.
			if target := strings.TrimPrefix(strings.TrimPrefix(line, "blocked"), " "); isLoggableBlockedName(target) {
				logger.Warn("zalo sidecar connection blocked by its egress guard", "host", target)
			} else {
				logger.Warn("zalo sidecar connection blocked by its egress guard")
			}
		default:
			logger.Debug("zalo sidecar wrote an unexpected stderr line")
		}
	}
	if sc.Err() != nil {
		logger.Debug("zalo sidecar stderr line over the limit; the rest is discarded")
		_, _ = io.Copy(io.Discard, r)
	}
}

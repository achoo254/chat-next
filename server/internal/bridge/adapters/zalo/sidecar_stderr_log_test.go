package zalo

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// stderrLog runs logStderr over input and returns what it logged.
func stderrLog(input string) string {
	var out bytes.Buffer
	logStderr(strings.NewReader(input), slog.New(slog.NewTextHandler(&out, &slog.HandlerOptions{Level: slog.LevelInfo})))
	return out.String()
}

func TestLogStderrNamesTheBlockedHost(t *testing.T) {
	got := stderrLog("blocked registry.npmjs.org\n")
	if !strings.Contains(got, "connection blocked by its egress guard") || !strings.Contains(got, "host=registry.npmjs.org") {
		t.Fatalf("a blocked host name must be logged, got %q", got)
	}
}

func TestLogStderrBlockedWithoutAPlainNameLogsNoText(t *testing.T) {
	lines := []string{"blocked\n", "blocked unix-socket\n", "blocked 10.9.8.7\n", "blocked ::1\n", "blocked evil host with spaces\n", "blocked a=b\"c\n"}
	for _, line := range lines {
		got := stderrLog(line)
		if !strings.Contains(got, "connection blocked by its egress guard") {
			t.Fatalf("%q: the block must still be reported, got %q", line, got)
		}
		if strings.Contains(got, "host=") {
			t.Fatalf("%q: only a plain DNS name may be logged as the host, got %q", line, got)
		}
	}
}

func TestLogStderrKeepsDroppingUnexpectedLines(t *testing.T) {
	if got := stderrLog("cookie=secret\n"); got != "" {
		t.Fatalf("an unexpected line must not reach the log at info level, got %q", got)
	}
}

package engine

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func TestALongWaitTheOtherAppAsksForIsLoggedAndAShortOneIsNot(t *testing.T) {
	old := rateLimitLogAfter
	rateLimitLogAfter = 20 * time.Millisecond
	defer func() { rateLimitLogAfter = old }()
	var buf bytes.Buffer
	ctx := withLogger(context.Background(), slog.New(slog.NewTextHandler(&buf, nil)))
	wait := func(d time.Duration) {
		asked := false
		if _, err := retryRateLimit(ctx, func() (int, error) {
			if !asked {
				asked = true
				return 0, &bridge.RateLimitError{RetryAfter: d}
			}
			return 1, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	wait(5 * time.Millisecond)
	if buf.Len() != 0 {
		t.Fatalf("a short wait was logged: %s", buf.String())
	}
	wait(30 * time.Millisecond)
	if !strings.Contains(buf.String(), "asked to wait") || !strings.Contains(buf.String(), "wait=30ms") {
		t.Fatalf("a long wait was not logged: %q", buf.String())
	}
}

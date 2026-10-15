package rpc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
)

// recordingLogger captures every record at Debug and above.
func recordingLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})), &buf
}

func TestInternalClassifiesClientEndedCalls(t *testing.T) {
	const procedure = "/app.v1.ChatsService/GetDialogs"

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	expired, cancelExpired := context.WithDeadline(context.Background(), time.Unix(0, 0))
	defer cancelExpired()

	cases := []struct {
		name     string
		ctx      context.Context
		err      error
		code     connect.Code
		level    string
		hideBody bool
	}{
		{"client aborted", cancelled, fmt.Errorf("query: %w", context.Canceled), connect.CodeCanceled, "level=DEBUG", false},
		{"client deadline passed", expired, fmt.Errorf("query: %w", context.DeadlineExceeded), connect.CodeDeadlineExceeded, "level=DEBUG", false},
		{"server-side timeout on a live request", context.Background(), fmt.Errorf("query: %w", context.DeadlineExceeded), connect.CodeInternal, "level=ERROR", true},
		{"real failure", context.Background(), errors.New("connection refused"), connect.CodeInternal, "level=ERROR", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logger, buf := recordingLogger()
			err := internal(tc.ctx, logger, procedure, tc.err)
			if got := connect.CodeOf(err); got != tc.code {
				t.Fatalf("code = %v, want %v", got, tc.code)
			}
			out := buf.String()
			if strings.Count(out, "\n") != 1 || !strings.Contains(out, tc.level) || !strings.Contains(out, procedure) {
				t.Fatalf("log = %q, want one %s record for %s", out, tc.level, procedure)
			}
			if tc.hideBody && strings.Contains(err.Error(), tc.err.Error()) {
				t.Fatalf("internal error leaks its cause to the client: %v", err)
			}
		})
	}
}

func TestFailPassesClientErrorsThroughWithoutLogging(t *testing.T) {
	logger, buf := recordingLogger()
	denied := connect.NewError(connect.CodePermissionDenied, errors.New("not a member"))
	if err := fail(context.Background(), logger, "/p", denied); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("code = %v", connect.CodeOf(err))
	}
	if buf.Len() != 0 {
		t.Fatalf("client error was logged: %q", buf.String())
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fail(cancelled, logger, "/p", context.Canceled); connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatalf("cancelled call: code = %v", connect.CodeOf(err))
	}
	if strings.Contains(buf.String(), "level=ERROR") {
		t.Fatalf("cancelled call logged as an error: %q", buf.String())
	}
}

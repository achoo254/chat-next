package engine_test

import (
	"bytes"
	"log/slog"
	"sync"
	"testing"
)

// failureLogMax caps what one test keeps; a stalled run logs the same few lines over and over.
const failureLogMax = 256 << 10

// keptLog is a writer that holds what it is given, up to failureLogMax, for many goroutines.
type keptLog struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	dropped int
}

func (k *keptLog) Write(p []byte) (int, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.buf.Len()+len(p) > failureLogMax {
		k.dropped += len(p)
		return len(p), nil
	}
	return k.buf.Write(p)
}

func (k *keptLog) text() (string, int) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.buf.String(), k.dropped
}

// failureLog is the engine's logger in a test: its lines are kept and printed only if the test
// fails, so a stall seen once on CI leaves what the engine did, and a passing test prints nothing.
// It is registered before the engine's own cleanup, so it prints after the engine stopped.
func failureLog(t *testing.T) *slog.Logger {
	t.Helper()
	kept := &keptLog{}
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		text, dropped := kept.text()
		t.Logf("engine log of this test:\n%s", text)
		if dropped > 0 {
			t.Logf("(%d bytes of the engine log were left out)", dropped)
		}
	})
	return slog.New(slog.NewTextHandler(kept, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

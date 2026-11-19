package engine

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// stalledStream gives one chunk then blocks until it is closed, like a download that stops.
type stalledStream struct {
	mu     sync.Mutex
	sent   bool
	closed chan struct{}
	once   sync.Once
}

func (s *stalledStream) Read(p []byte) (int, error) {
	s.mu.Lock()
	if !s.sent {
		s.sent = true
		s.mu.Unlock()
		return copy(p, "abc"), nil
	}
	s.mu.Unlock()
	<-s.closed
	return 0, io.ErrClosedPipe
}
func (s *stalledStream) Close() error     { s.once.Do(func() { close(s.closed) }); return nil }
func (s *stalledStream) MimeType() string { return "image/jpeg" }
func (s *stalledStream) Size() int64      { return 0 }

func TestAStalledDownloadIsGivenUpInsteadOfHoldingTheRun(t *testing.T) {
	old := fileIdle
	fileIdle = 120 * time.Millisecond
	defer func() { fileIdle = old }()
	s := &stalledStream{closed: make(chan struct{})}
	body, stop := watched(context.Background(), s)
	defer stop()
	done := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(body)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("read ended with %v, want the closed stream's error", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a stalled download still blocks the read")
	}
}

func TestADownloadThatKeepsGoingIsNotCut(t *testing.T) {
	old := fileIdle
	fileIdle = 120 * time.Millisecond
	defer func() { fileIdle = old }()
	// A byte every 30 ms for 300 ms: longer than the idle limit in all, never idle that long.
	body, stop := watched(context.Background(), &tickingStream{every: 30 * time.Millisecond, n: 10})
	defer stop()
	if b, err := io.ReadAll(body); err != nil || len(b) != 10 {
		t.Fatalf("read %d bytes, %v; want 10 and no error", len(b), err)
	}
}

// tickingStream gives a byte every `every`, n times.
type tickingStream struct {
	every time.Duration
	n     int
}

func (s *tickingStream) Read(p []byte) (int, error) {
	if s.n == 0 {
		return 0, io.EOF
	}
	time.Sleep(s.every)
	s.n--
	p[0] = 'x'
	return 1, nil
}
func (s *tickingStream) Close() error     { return nil }
func (s *tickingStream) MimeType() string { return "image/jpeg" }
func (s *tickingStream) Size() int64      { return 0 }

package zalo

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// fakeRunner starts fakeProcesses; each start runs script in its own goroutine
// so a test plays the sidecar's side line by line.
type fakeRunner struct {
	mu      sync.Mutex
	script  func(p *fakeProcess)
	started []*fakeProcess
	fail    error
}

func (r *fakeRunner) Start(ctx context.Context) (Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail != nil {
		return nil, r.fail
	}
	p := newFakeProcess()
	r.started = append(r.started, p)
	if r.script != nil {
		go r.script(p)
	}
	return p, nil
}

func (r *fakeRunner) starts() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.started)
}

// fakeProcess behaves like the sidecar's pipes: it reads commands from stdin,
// exits when stdin closes, and its stdout carries what the script emits.
type fakeProcess struct {
	stdinR  *io.PipeReader
	stdinW  *io.PipeWriter
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	stderrR *io.PipeReader
	stderrW *io.PipeWriter

	commands    chan string   // lines written to stdin
	stdinClosed chan struct{} // closed when the adapter closed stdin
	exited      chan struct{}
	exitOnce    sync.Once
	terminated  bool
	mu          sync.Mutex
}

func newFakeProcess() *fakeProcess {
	p := &fakeProcess{commands: make(chan string, 16), stdinClosed: make(chan struct{}), exited: make(chan struct{})}
	p.stdinR, p.stdinW = io.Pipe()
	p.stdoutR, p.stdoutW = io.Pipe()
	p.stderrR, p.stderrW = io.Pipe()
	go func() {
		sc := bufio.NewScanner(p.stdinR)
		sc.Buffer(make([]byte, 0, 64<<10), 1<<20) // a file_chunk line is longer than the default
		for sc.Scan() {
			p.commands <- sc.Text()
		}
		close(p.stdinClosed)
		p.exit() // the real sidecar exits when its stdin closes
	}()
	return p
}

func (p *fakeProcess) Stdin() io.WriteCloser { return p.stdinW }
func (p *fakeProcess) Stdout() io.Reader     { return p.stdoutR }
func (p *fakeProcess) Stderr() io.Reader     { return p.stderrR }

func (p *fakeProcess) Wait() error {
	<-p.exited
	return nil
}

func (p *fakeProcess) Terminate() error {
	p.mu.Lock()
	p.terminated = true
	p.mu.Unlock()
	p.exit()
	return nil
}

// exit ends the process: its outputs close.
func (p *fakeProcess) exit() {
	p.exitOnce.Do(func() {
		_ = p.stdoutW.Close()
		_ = p.stderrW.Close()
		_ = p.stdinR.CloseWithError(errors.New("process exited"))
		close(p.exited)
	})
}

func (p *fakeProcess) wasTerminated() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.terminated
}

// waitStdinClosed fails the test unless the adapter closes stdin soon.
func (p *fakeProcess) waitStdinClosed(t *testing.T) {
	t.Helper()
	select {
	case <-p.stdinClosed:
	case <-time.After(5 * time.Second):
		t.Fatal("the adapter did not close the sidecar's stdin")
	}
}

// waitExited fails the test unless the process exits soon.
func (p *fakeProcess) waitExited(t *testing.T) {
	t.Helper()
	select {
	case <-p.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the sidecar did not exit")
	}
}

// emit writes one stdout line; it gives up once the process exited.
func (p *fakeProcess) emit(line string) {
	_, _ = p.stdoutW.Write([]byte(line + "\n"))
}

// stderr writes one stderr line.
func (p *fakeProcess) stderr(line string) {
	_, _ = p.stderrW.Write([]byte(line + "\n"))
}

// command waits for the next stdin line ("" when stdin closed first). It is
// called from script goroutines, so it reports with Error, not Fatal.
func (p *fakeProcess) command(t *testing.T) string {
	t.Helper()
	select {
	case c := <-p.commands:
		return c
	case <-p.stdinClosed:
		return ""
	case <-time.After(5 * time.Second):
		t.Error("no command reached the sidecar")
		return ""
	}
}

const readyLine = `{"ev":"ready","protocol":12}`

// fastTiming keeps tests short.
var fastTiming = timing{stopGrace: 200 * time.Millisecond, readyTimeout: 2 * time.Second, firstQR: 2 * time.Second,
	loginStartWait: 2 * time.Second, loginPoll: 300 * time.Millisecond, loginIdle: time.Minute,
	loginTTL: time.Minute, connect: 3 * time.Second,
	sendGap: 20 * time.Millisecond, sendAnswer: 300 * time.Millisecond, mediaAnswer: 300 * time.Millisecond, historyAnswer: 300 * time.Millisecond}

// newTestAdapter returns an adapter on runner with fast timings and a logger
// that keeps every record for inspection.
func newTestAdapter(t *testing.T, runner Runner) (*Adapter, *recordingHandler) {
	t.Helper()
	return newTestAdapterAt(t, runner, time.Now)
}

// newTestAdapterAt is newTestAdapter with a clock of the test's.
func newTestAdapterAt(t *testing.T, runner Runner, now func() time.Time) (*Adapter, *recordingHandler) {
	t.Helper()
	h := &recordingHandler{}
	a := newAdapter(runner, slog.New(h), now)
	a.timing = fastTiming
	t.Cleanup(a.Close)
	return a, h
}

// eventually fails the test unless cond holds within 5 seconds.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// process returns the i-th process the runner started, waiting for it.
func (r *fakeRunner) process(t *testing.T, i int) *fakeProcess {
	t.Helper()
	eventually(t, "sidecar start", func() bool { return r.starts() > i })
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.started[i]
}

// recordingHandler is a slog.Handler that keeps every record as text.
type recordingHandler struct {
	mu    sync.Mutex
	lines []string
	attrs []slog.Attr
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	line := r.Message
	r.Attrs(func(a slog.Attr) bool {
		line += " " + a.Key + "=" + a.Value.String()
		return true
	})
	for _, a := range h.attrs {
		line += " " + a.Key + "=" + a.Value.String()
	}
	h.mu.Lock()
	h.lines = append(h.lines, line)
	h.mu.Unlock()
	return nil
}

func (h *recordingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.attrs = append(h.attrs, attrs...)
	return h
}

func (h *recordingHandler) WithGroup(string) slog.Handler { return h }

func (h *recordingHandler) all() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.lines...)
}

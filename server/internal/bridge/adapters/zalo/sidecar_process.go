package zalo

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// sidecar is a running sidecar seen through its protocol: commands go in with
// send, parsed events come out of events (closed once stdout ends), and stop
// closes stdin then kills after a grace period. A command with an id is sent
// with request; its answer is handed to that caller by the stdout reader and
// never goes through events, so a caller is answered even while the reader of
// events is busy (the engine reads events and sends from one goroutine).
type sidecar struct {
	proc   Process
	logger *slog.Logger
	grace  time.Duration

	events   chan wireEvent
	stopping chan struct{} // closed by stop: events are no longer wanted
	exited   chan struct{} // closed once the process has exited

	stdinMu  sync.Mutex
	stopOnce sync.Once

	answersMu sync.Mutex
	waiting   map[string]chan wireEvent // by command id
}

// startSidecar starts a process and waits for its ready line.
func startSidecar(ctx context.Context, r Runner, logger *slog.Logger, t timing) (*sidecar, error) {
	if r == nil {
		return nil, errors.New("zalo: no sidecar runner configured")
	}
	proc, err := r.Start(ctx)
	if err != nil {
		return nil, err
	}
	s := &sidecar{proc: proc, logger: logger, grace: t.stopGrace,
		events: make(chan wireEvent, 64), stopping: make(chan struct{}), exited: make(chan struct{}),
		waiting: map[string]chan wireEvent{}}
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); s.readStdout() }()
	go func() { defer readers.Done(); logStderr(proc.Stderr(), logger) }()
	go func() {
		readers.Wait() // exec: Wait only after the pipes are read to the end
		_ = proc.Wait()
		close(s.exited)
	}()
	if err := s.waitReady(ctx, t.readyTimeout); err != nil {
		s.stop()
		return nil, err
	}
	return s, nil
}

func (s *sidecar) waitReady(ctx context.Context, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("zalo: sidecar did not start in time")
	case ev, ok := <-s.events:
		switch {
		case !ok:
			return errors.New("zalo: sidecar exited before it was ready")
		case ev.Ev != evReady:
			return fmt.Errorf("zalo: sidecar sent %q before ready", safeCode(ev.Ev))
		case ev.Protocol != protocolVersion:
			return fmt.Errorf("zalo: sidecar speaks protocol %d, the adapter %d", ev.Protocol, protocolVersion)
		}
		return nil
	}
}

// readStdout parses stdout line by line. Lines are never logged: a bad one is
// counted by kind only. Once stop is called, lines are read and dropped so the
// process can still write its last ones and exit.
func (s *sidecar) readStdout() {
	defer close(s.events)
	sc := bufio.NewScanner(s.proc.Stdout())
	sc.Buffer(make([]byte, 0, 64<<10), maxLineBytes)
	for sc.Scan() {
		ev, err := decodeEvent(sc.Bytes())
		if err != nil {
			s.logger.Debug("zalo sidecar line dropped", "reason", err.Error())
			continue
		}
		if isAnswer(ev.Ev) {
			s.answer(ev)
			continue
		}
		select {
		case s.events <- ev:
		case <-s.stopping:
		}
	}
	if err := sc.Err(); err != nil {
		// A line over the limit (or a read error): the protocol is broken, so the
		// process goes; the reader of events sees it as an exit.
		s.logger.Warn("zalo sidecar output unreadable; stopping it", "reason", readErrorKind(err))
		_ = s.proc.Terminate()
	}
}

func readErrorKind(err error) string {
	if errors.Is(err, bufio.ErrTooLong) {
		return "line too long"
	}
	return "read error"
}

// send writes one command line.
func (s *sidecar) send(c command) error {
	line, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("zalo: encode command: %w", err)
	}
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	if _, err := s.proc.Stdin().Write(append(line, '\n')); err != nil {
		return errors.New("zalo: sidecar does not take commands (stdin closed)")
	}
	return nil
}

// errNoAnswer: the sidecar did not answer a command in time, or stopped first.
// Whatever the command asked for may or may not have happened.
var errNoAnswer = errors.New("zalo: the sidecar did not answer")

// request writes a command with an id and waits for its answer, at most
// timeout. An answer that comes later is dropped.
func (s *sidecar) request(ctx context.Context, c command, timeout time.Duration) (wireEvent, error) {
	ch := make(chan wireEvent, 1)
	s.answersMu.Lock()
	s.waiting[c.ID] = ch
	s.answersMu.Unlock()
	defer func() {
		s.answersMu.Lock()
		delete(s.waiting, c.ID)
		s.answersMu.Unlock()
	}()
	if err := s.send(c); err != nil {
		return wireEvent{}, err
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case ev := <-ch:
		return ev, nil
	case <-ctx.Done():
		return wireEvent{}, ctx.Err()
	case <-timer.C:
		return wireEvent{}, fmt.Errorf("%w within %v", errNoAnswer, timeout)
	case <-s.stopping:
		return wireEvent{}, fmt.Errorf("%w: it was stopped", errNoAnswer)
	case <-s.exited:
		return wireEvent{}, fmt.Errorf("%w: it exited", errNoAnswer)
	}
}

// answer hands an answer to the caller waiting for its id, if any.
func (s *sidecar) answer(ev wireEvent) {
	s.answersMu.Lock()
	ch := s.waiting[ev.ID]
	delete(s.waiting, ev.ID)
	s.answersMu.Unlock()
	if ch == nil {
		s.logger.Debug("zalo sidecar answer nobody waits for", "event", safeCode(ev.Ev))
		return
	}
	ch <- ev // buffered for one; the id was removed, so this is the only send
}

// stop closes stdin (the sidecar stops its listener and exits on EOF), then
// asks it to terminate if it is still there after the grace period, and gives
// up waiting after a second one: through sudo nothing stronger reaches the
// sidecar (see ExecRunner). It returns once the process is gone or given up
// on; calling it again is harmless.
func (s *sidecar) stop() {
	s.stopOnce.Do(func() {
		close(s.stopping)
		s.stdinMu.Lock()
		_ = s.proc.Stdin().Close()
		s.stdinMu.Unlock()
		grace := time.NewTimer(s.grace)
		defer grace.Stop()
		select {
		case <-s.exited:
			return
		case <-grace.C:
		}
		if err := s.proc.Terminate(); err != nil {
			s.logger.Warn("zalo sidecar could not be signalled", "err", err)
		}
		term := time.NewTimer(s.grace)
		defer term.Stop()
		select {
		case <-s.exited:
		case <-term.C:
			s.logger.Error("zalo sidecar still running after SIGTERM; no longer waiting for it")
		}
	})
}

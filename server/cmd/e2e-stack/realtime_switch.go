package main

import (
	"bufio"
	"errors"
	"net"
	"net/http"
	"sync"
)

// realtimeSwitchPath turns the realtime gateway off and on, so a scenario
// can drop the browsers' WebSockets the way a broken network does:
//
//	POST /e2e/realtime?state=down   close every open socket, refuse new ones
//	POST /e2e/realtime?state=up     accept sockets again
//
// The browsers never see this path (the Vite dev server does not proxy
// it); the scenarios call the api port directly.
const realtimeSwitchPath = "/e2e/realtime"

// realtimeSwitch wraps the api handler: it keeps the hijacked connections
// of /ws so "down" can close them without the server's close handshake.
type realtimeSwitch struct {
	mu    sync.Mutex
	down  bool
	conns map[net.Conn]struct{}
}

func newRealtimeSwitch() *realtimeSwitch {
	return &realtimeSwitch{conns: make(map[net.Conn]struct{})}
}

func (s *realtimeSwitch) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case realtimeSwitchPath:
			s.control(w, r)
		case "/ws":
			s.mu.Lock()
			down := s.down
			s.mu.Unlock()
			if down {
				http.Error(w, "realtime is switched off by the e2e stack", http.StatusServiceUnavailable)
				return
			}
			next.ServeHTTP(&trackingWriter{ResponseWriter: w, sw: s}, r)
		default:
			next.ServeHTTP(w, r)
		}
	})
}

func (s *realtimeSwitch) control(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	switch r.URL.Query().Get("state") {
	case "down":
		s.setDown(true)
	case "up":
		s.setDown(false)
	default:
		http.Error(w, `state must be "down" or "up"`, http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *realtimeSwitch) setDown(down bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down = down
	if !down {
		return
	}
	for conn := range s.conns {
		// Already closed by the gateway is fine: it is gone either way.
		_ = conn.Close()
	}
	clear(s.conns)
}

func (s *realtimeSwitch) track(conn net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down {
		// Switched off while this upgrade was in flight.
		_ = conn.Close()
		return
	}
	s.conns[conn] = struct{}{}
}

// trackingWriter records the connection the WebSocket upgrade hijacks.
// Unwrap keeps http.ResponseController working (the gateway clears the
// server's deadlines through it).
type trackingWriter struct {
	http.ResponseWriter
	sw *realtimeSwitch
}

func (t *trackingWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

func (t *trackingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(t.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	if conn == nil {
		return nil, nil, errors.New("e2e-stack: hijack returned no connection")
	}
	t.sw.track(conn)
	return conn, rw, nil
}

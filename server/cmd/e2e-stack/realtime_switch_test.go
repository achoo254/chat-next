package main

import (
	"bufio"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRealtimeSwitch(t *testing.T) {
	// A stand-in gateway: hijacks /ws and keeps the connection open.
	gateway := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" {
			_, _ = io.WriteString(w, "app")
			return
		}
		if err := http.NewResponseController(w).SetReadDeadline(time.Time{}); err != nil {
			t.Errorf("deadline through the tracking writer: %v", err)
		}
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
		_ = rw.Flush()
		// Hold the socket until the switch closes it.
		_, _ = io.Copy(io.Discard, conn)
	})
	sw := newRealtimeSwitch()
	srv := httptest.NewServer(sw.wrap(gateway))
	defer srv.Close()

	post := func(state string) int {
		t.Helper()
		resp, err := http.Post(srv.URL+realtimeSwitchPath+"?state="+state, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	upgrade := func() (*bufio.Reader, func()) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/ws", nil)
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "test")
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusSwitchingProtocols {
			_ = resp.Body.Close()
			t.Fatalf("upgrade status %d", resp.StatusCode)
		}
		body, ok := resp.Body.(io.ReadWriteCloser)
		if !ok {
			t.Fatal("upgraded body is not writable")
		}
		return bufio.NewReader(body), func() { _ = body.Close() }
	}

	socket, closeSocket := upgrade()
	defer closeSocket()
	// Other paths pass through untouched.
	if resp, err := http.Get(srv.URL + "/rpc/x"); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("pass-through = %v, %v", resp, err)
	}

	if code := post("down"); code != http.StatusNoContent {
		t.Fatalf("down = %d", code)
	}
	done := make(chan error, 1)
	go func() {
		_, err := socket.ReadByte()
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("socket still delivers data after down")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("socket not closed by down")
	}

	resp, err := http.Get(srv.URL + "/ws")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("/ws while down = %d", resp.StatusCode)
	}

	if code := post("up"); code != http.StatusNoContent {
		t.Fatalf("up = %d", code)
	}
	_, closeAgain := upgrade()
	closeAgain()

	if code := post("sideways"); code != http.StatusBadRequest {
		t.Fatalf("bad state = %d", code)
	}
	resp, err = http.Get(srv.URL + realtimeSwitchPath + "?state=down")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed || !strings.Contains(resp.Header.Get("Allow"), "POST") {
		t.Fatalf("GET control = %d", resp.StatusCode)
	}
}

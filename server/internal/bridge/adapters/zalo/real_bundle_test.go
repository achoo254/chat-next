package zalo

import (
	"context"
	"log/slog"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The committed bundle, run with the real Node and ExecRunner: it says ready
// with the protocol this adapter speaks, answers an unknown command and an
// empty session with error codes, a file sent before any login with a send_error,
// and exits by itself once its stdin closes.
// No command touches the network. Skipped where node is not installed.
func TestRealBundleSpeaksTheProtocolAndExitsOnStdinClose(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	bundle, err := filepath.Abs(filepath.Join("sidecar", "dist", "zalo-sidecar.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := &recordingHandler{}
	side, err := startSidecar(ctx, ExecRunner{Node: node, Bundle: bundle}, slog.New(h), timing{stopGrace: 5 * time.Second, readyTimeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer side.stop()
	if err := side.send(command{Cmd: "bogus"}); err != nil {
		t.Fatal(err)
	}
	expectError(ctx, t, side, "unknown_command")
	// A session without its fields fails before any network call, with a code.
	if err := side.send(command{Cmd: cmdLoginSession, Session: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	expectError(ctx, t, side, "bad_session")
	// A file streamed in chunks and sent before any login is answered, by id, without a network call.
	if err := side.send(command{Cmd: cmdFileChunk, ID: "f1", Data: "eGluIGNow6Bv"}); err != nil {
		t.Fatal(err)
	}
	ev, err := side.request(ctx, command{Cmd: cmdSendMedia, ID: "f1", To: "123", Kind: "file", Name: "a.txt", Size: 9}, 10*time.Second)
	if err != nil || ev.Ev != evSendError || string(ev.Code) != "not_logged_in" {
		t.Fatalf("send_media before login = %+v, %v; want send_error not_logged_in", ev, err)
	}
	_ = side.proc.Stdin().Close()
	select {
	case <-side.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the sidecar did not exit after its stdin closed")
	}
}

func expectError(ctx context.Context, t *testing.T, side *sidecar, code string) {
	t.Helper()
	select {
	case ev, ok := <-side.events:
		if !ok || ev.Ev != evError || string(ev.Code) != code {
			t.Fatalf("event = %+v (open %v), want error %s", ev, ok, code)
		}
	case <-ctx.Done():
		t.Fatalf("no error %s", code)
	}
}

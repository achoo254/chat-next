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
// with the protocol this adapter speaks, answers an unknown command with an
// error event, and exits by itself once its stdin closes. No command touches
// the network. Skipped where node is not installed.
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
	select {
	case ev, ok := <-side.events:
		if !ok || ev.Ev != evError || ev.Code != "unknown_command" {
			t.Fatalf("event = %+v (open %v), want error unknown_command", ev, ok)
		}
	case <-ctx.Done():
		t.Fatal("no answer to the unknown command")
	}
	_ = side.proc.Stdin().Close()
	select {
	case <-side.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the sidecar did not exit after its stdin closed")
	}
}

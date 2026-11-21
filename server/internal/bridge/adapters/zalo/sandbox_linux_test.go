//go:build linux

package zalo

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The real user switch: only a root test process may setuid, so this runs
// only as root (CI and the WSL test user skip it). The bundle runs as
// "nobody" and still answers; the work directory is gone afterwards.
func TestSandboxedSidecarRunsAsAnotherUser(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("needs root to switch user")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	uid, gid, err := lookupUser("nobody")
	if err != nil {
		t.Skip("no user nobody")
	}
	bundle, err := filepath.Abs(filepath.Join("sidecar", "dist", "zalo-sidecar.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	r := ExecRunner{Node: node, Bundle: bundle, sandbox: &sandboxIdentity{uid: uid, gid: gid}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	side, err := startSidecar(ctx, r, slog.New(&recordingHandler{}), timing{stopGrace: 5 * time.Second, readyTimeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("start as nobody: %v", err)
	}
	p, ok := side.proc.(*execProcess)
	if !ok {
		t.Fatal("not an exec process")
	}
	facts, err := factsOf(os.Lstat(p.dir))
	if err != nil || facts.uid != uid || facts.mode.Perm() != 0o700 {
		t.Errorf("work dir: %+v, %v", facts, err)
	}
	side.stop()
	if _, err := os.Stat(p.dir); !os.IsNotExist(err) {
		t.Errorf("work dir left behind: %v", err)
	}
}

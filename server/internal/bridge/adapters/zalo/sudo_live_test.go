//go:build linux

package zalo

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"
)

// TestLiveSudo checks the real sudo with a sudoers rule installed by hand (the
// test installs nothing): ZALO_LIVE_SUDO_USER may run exactly
// `ZALO_LIVE_SUDO_NODE ZALO_LIVE_SUDO_BUNDLE`, without a password, as the
// user running the test. Run it as the server's user, for example:
//
//	ZALO_LIVE_SUDO_USER=zalo ZALO_LIVE_SUDO_NODE=/opt/node22/bin/node \
//	ZALO_LIVE_SUDO_BUNDLE=/opt/chat/zalo-sidecar/zalo-sidecar.cjs go test -run TestLiveSudo ./internal/bridge/adapters/zalo/
func TestLiveSudo(t *testing.T) {
	user, node, bundle := os.Getenv("ZALO_LIVE_SUDO_USER"), os.Getenv("ZALO_LIVE_SUDO_NODE"), os.Getenv("ZALO_LIVE_SUDO_BUNDLE")
	if user == "" || node == "" || bundle == "" {
		t.Skip("set ZALO_LIVE_SUDO_USER, ZALO_LIVE_SUDO_NODE and ZALO_LIVE_SUDO_BUNDLE to run against a real sudoers rule")
	}
	sudo := os.Getenv("ZALO_LIVE_SUDO_PATH")
	if sudo == "" {
		sudo = defaultSudo
	}
	if err := sudoAllows(sudo, user, node, bundle); err != nil {
		t.Fatalf("the rule is not granted: %v", err)
	}
	if err := sudoAllows(sudo, user, node, bundle+".other"); err == nil {
		t.Fatal("sudo granted a command line the rule does not name")
	}
	r := ExecRunner{Node: node, Bundle: bundle, sudo: &sudoLaunch{path: sudo, user: user}}
	start := func() *sidecar {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		side, err := startSidecar(ctx, r, slog.New(&recordingHandler{}), timing{stopGrace: 5 * time.Second, readyTimeout: 20 * time.Second})
		if err != nil {
			t.Fatalf("start through sudo: %v", err)
		}
		t.Cleanup(side.stop)
		return side
	}
	side := start()
	if err := side.proc.Terminate(); err != nil { // to sudo, which relays it
		t.Fatal(err)
	}
	waitSidecarExit(t, side, "SIGTERM to sudo")
	side = start()
	_ = side.proc.Stdin().Close()
	waitSidecarExit(t, side, "its stdin closed")
}

//go:build unix

package zalo

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeSudo writes a stand-in for sudo: it records its arguments, environment
// and working directory, refuses any command line other than the one the
// sudoers rule allows, and runs node with an empty environment, as sudo's
// env_reset would (the real sudo keeps a few variables of its own; none of
// the server's).
func fakeSudo(t *testing.T) (script, dir string) {
	t.Helper()
	dir = t.TempDir()
	script = filepath.Join(dir, "sudo")
	body := `#!/bin/sh
printf '%s\n' "$@" > "` + dir + `/argv"
env > "` + dir + `/env"
pwd -P > "` + dir + `/cwd"
[ $# -eq 6 ] && [ "$1" = "-n" ] && [ "$2" = "-u" ] && [ "$4" = "--" ] || exit 64
exec env -i "$5" "$6"
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, dir
}

// startThroughFakeSudo starts the real bundle through the fake sudo and waits
// for its ready line.
func startThroughFakeSudo(t *testing.T) (*sidecar, string, string, string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	bundle, err := filepath.Abs(filepath.Join("sidecar", "dist", "zalo-sidecar.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	script, dir := fakeSudo(t)
	r := ExecRunner{Node: node, Bundle: bundle, sudo: &sudoLaunch{path: script, user: "zalo"}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	side, err := startSidecar(ctx, r, slog.New(&recordingHandler{}), timing{stopGrace: 5 * time.Second, readyTimeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("start through sudo: %v", err)
	}
	t.Cleanup(side.stop)
	return side, dir, node, bundle
}

func waitSidecarExit(t *testing.T, side *sidecar, why string) {
	t.Helper()
	select {
	case <-side.exited:
	case <-time.After(5 * time.Second):
		t.Fatalf("the sidecar did not exit after %s", why)
	}
}

func TestSudoLaunchIsExactlyTheAllowedCommand(t *testing.T) {
	t.Setenv("ZALO_TEST_SERVER_SECRET", "s3cret") // what the server has must not reach sudo
	side, dir, node, bundle := startThroughFakeSudo(t)

	argv, err := os.ReadFile(filepath.Join(dir, "argv"))
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.Join([]string{"-n", "-u", "zalo", "--", node, bundle}, "\n") + "\n"; string(argv) != want {
		t.Errorf("sudo argv = %q, want %q", argv, want)
	}
	env, err := os.ReadFile(filepath.Join(dir, "env"))
	if err != nil {
		t.Fatal(err)
	}
	given := map[string]bool{"PATH": true, "TZ": true, "WS_NO_BUFFER_UTIL": true, "WS_NO_UTF_8_VALIDATE": true}
	shell := map[string]bool{"PWD": true, "SHLVL": true, "_": true, "OLDPWD": true} // set by sh itself
	for _, line := range strings.Split(strings.TrimSpace(string(env)), "\n") {
		key, _, _ := strings.Cut(line, "=")
		if !given[key] && !shell[key] {
			t.Errorf("sudo got the variable %s from the server", key)
		}
	}
	cwd, err := os.ReadFile(filepath.Join(dir, "cwd"))
	if err != nil {
		t.Fatal(err)
	}
	wantDir, _ := filepath.EvalSymlinks(filepath.Dir(bundle))
	if strings.TrimSpace(string(cwd)) != wantDir {
		t.Errorf("working directory = %q, want the bundle's %q", strings.TrimSpace(string(cwd)), wantDir)
	}

	// It answered ready with an empty environment; closing stdin stops it.
	_ = side.proc.Stdin().Close()
	waitSidecarExit(t, side, "its stdin closed")
}

func TestSudoLaunchStopsOnSIGTERM(t *testing.T) {
	side, _, _, _ := startThroughFakeSudo(t)
	if err := side.proc.Terminate(); err != nil { // stdin stays open
		t.Fatal(err)
	}
	waitSidecarExit(t, side, "SIGTERM")
}

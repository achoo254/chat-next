//go:build windows

package zalo

import (
	"os"
	"os/exec"
	"path/filepath"
)

// setProcessGroup does nothing on Windows (development only): the sidecar
// exits when its stdin closes, and Kill ends the process itself.
func setProcessGroup(*exec.Cmd) {}

// killProcessGroup kills the sidecar process.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

// sidecarPath is the PATH of the sidecar: the system directory only.
func sidecarPath() string { return filepath.Join(os.Getenv("SYSTEMROOT"), "System32") }

// platformEnv is what Node needs on Windows to open sockets and read random
// bytes.
func platformEnv() []string { return []string{"SYSTEMROOT=" + os.Getenv("SYSTEMROOT")} }

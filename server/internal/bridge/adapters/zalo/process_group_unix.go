//go:build unix

package zalo

import (
	"os/exec"
	"syscall"
)

// killProcessGroup sends SIGKILL to the sidecar's whole process group.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

// sidecarPath is the PATH of the sidecar: system directories only.
func sidecarPath() string { return "/usr/local/bin:/usr/bin:/bin" }

// platformEnv adds nothing on Unix.
func platformEnv() []string { return nil }

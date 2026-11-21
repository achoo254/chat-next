//go:build unix

package zalo

import (
	"os/exec"
	"syscall"
)

// setProcessGroup starts the process in a group of its own. Through sudo this
// matters: sudo relays a signal only when it comes from outside the command's
// process group, and the server's group must not be the sidecar's.
//
// There is no Pdeathsig: the kernel clears it when sudo (set-user-ID) is
// executed. If the server dies, the write end of the sidecar's stdin closes
// and the sidecar exits on that EOF.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminate sends SIGTERM to the process the server started.
func terminate(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Signal(syscall.SIGTERM)
}

// sidecarPath is the PATH of the sidecar: system directories only.
func sidecarPath() string { return "/usr/local/bin:/usr/bin:/bin" }

// platformEnv adds nothing on Unix.
func platformEnv() []string { return nil }

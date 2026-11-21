//go:build linux

package zalo

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the sidecar in its own process group (killed as one)
// and has the kernel kill it if the server dies first, so no orphan keeps a
// Zalo session open. Pdeathsig follows the OS thread that started the child,
// not the process (Go issue 27505): the Go runtime rarely retires a thread,
// and if it did the sidecar would get SIGKILL early, which the engine treats
// as a crash and retries. Closing stdin still stops it in every other case.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

//go:build linux

package zalo

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the sidecar in its own process group (killed as one)
// and has the kernel kill it if the server dies first, so no orphan keeps a
// Zalo session open.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

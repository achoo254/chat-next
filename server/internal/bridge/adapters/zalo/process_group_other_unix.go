//go:build unix && !linux

package zalo

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the sidecar in its own process group (killed as one).
// Without Pdeathsig outside Linux, the sidecar still exits when the server
// dies because its stdin closes.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

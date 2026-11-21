//go:build !linux

package zalo

import "os/exec"

// realHost: no sandbox outside Linux, so Zalo is never offered there.
func realHost() hostSystem { return hostSystem{supported: false, serverUID: -1} }

// applySandbox refuses: the OS user switch exists only in the Linux build.
func applySandbox(*exec.Cmd, string, *sandboxIdentity) error { return errSandboxUnsupported }

// reclaimWorkDir has nothing to give back without a sandbox.
func reclaimWorkDir(string) {}

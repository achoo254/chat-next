//go:build linux

package zalo

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

// realHost reads the running Linux system.
func realHost() hostSystem {
	return hostSystem{
		supported:  true,
		serverUID:  os.Getuid(),
		lookupUser: lookupUser,
		lstat:      func(name string) (fileFacts, error) { return factsOf(os.Lstat(name)) },
		stat:       func(name string) (fileFacts, error) { return factsOf(os.Stat(name)) },
		readFile:   os.ReadFile,
		realDir:    filepath.EvalSymlinks,
	}
}

func lookupUser(name string) (uint32, uint32, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return 0, 0, err
	}
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return 0, 0, fmt.Errorf("uid %q: %w", u.Uid, err)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return 0, 0, fmt.Errorf("gid %q: %w", u.Gid, err)
	}
	return uint32(uid), uint32(gid), nil
}

func factsOf(fi fs.FileInfo, err error) (fileFacts, error) {
	if err != nil {
		return fileFacts{}, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fileFacts{}, fmt.Errorf("%s: no owner information", fi.Name())
	}
	return fileFacts{mode: fi.Mode(), uid: st.Uid, gid: st.Gid}, nil
}

// applySandbox gives the work directory to the sandbox user (mode 0700) and
// makes the process start as that user and group, without supplementary
// groups. The server needs CAP_SETUID, CAP_SETGID and CAP_CHOWN for this.
// Go sets the parent-death signal after switching credentials, so
// Pdeathsig still applies to the sandboxed process.
func applySandbox(cmd *exec.Cmd, dir string, id *sandboxIdentity) error {
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("zalo: sidecar work dir: %w", err)
	}
	if err := os.Chown(dir, int(id.uid), int(id.gid)); err != nil {
		return fmt.Errorf("zalo: give the sidecar work dir to the sandbox user: %w", err)
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Credential = &syscall.Credential{Uid: id.uid, Gid: id.gid, Groups: []uint32{}}
	return nil
}

// reclaimWorkDir gives the work directory back to the server so it can be
// removed (the temporary directory's sticky bit lets only the owner do it).
func reclaimWorkDir(dir string) {
	_ = os.Chown(dir, os.Getuid(), os.Getgid())
}

//go:build linux

package zalo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// sudoCheckTimeout bounds the startup question to sudo.
const sudoCheckTimeout = 10 * time.Second

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
		sudoAllows: sudoAllows,
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

// sudoAllows asks sudo, as the server's user, whether it may run exactly
// `node bundle` as user without a password (see sudoListArgs). Nothing is run.
func sudoAllows(sudo, user, node, bundle string) error {
	ctx, cancel := context.WithTimeout(context.Background(), sudoCheckTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, sudo, sudoListArgs(user, node, bundle)...)
	cmd.Dir = "/"
	cmd.Env = sidecarEnv()
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("sudo -l exited %d: %s", exit.ExitCode(), sudoReply(out))
	}
	return err
}

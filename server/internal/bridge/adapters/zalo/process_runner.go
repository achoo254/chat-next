package zalo

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
)

// Runner starts one sidecar process. The adapter starts one per login and one
// per subscribed account; tests give a fake that answers with scripted lines.
type Runner interface {
	Start(ctx context.Context) (Process, error)
}

// Process is a started sidecar. Closing Stdin asks it to stop; Terminate asks
// harder (SIGTERM). Wait returns once it has exited, after its stdout and
// stderr have been read to the end.
type Process interface {
	Stdin() io.WriteCloser
	Stdout() io.Reader
	Stderr() io.Reader
	Wait() error
	Terminate() error
}

// ExecRunner runs the bundled sidecar with Node, in the bundle's own directory
// (the sidecar writes no file), with a fixed minimal environment: nothing of
// the server's environment is passed on (no database DSN, no SecretBox key,
// no NODE_OPTIONS).
//
// Built by NewSandboxedRunner it runs `<sudo> -n -u <user> -- <node> <bundle>`
// and nothing more, the one command a sudoers rule lets the server's user run
// as the sandbox user. sudo resets the environment; the sidecar sets what it
// needs itself (sidecar/src/ws-env.mjs). A zero ExecRunner (tests) runs
// `<node> <bundle>` as the server's user.
//
// Stopping through sudo: the server's user may signal sudo (its real uid is
// the server's) but not the sidecar (owned by the sandbox user). sudo relays
// SIGTERM, SIGINT, SIGHUP and SIGQUIT to the command when they come from
// outside the command's process group, which is why the process starts in a
// group of its own. SIGKILL cannot be relayed: a sidecar that ignored both its
// stdin closing and SIGTERM would be left running; the adapter then stops
// waiting for it and logs an error.
type ExecRunner struct {
	// Node is the node binary, an absolute path.
	Node string
	// Bundle is the absolute path of dist/zalo-sidecar.cjs.
	Bundle string

	sudo *sudoLaunch
}

// sudoLaunch is how the sidecar is started as the sandbox user.
type sudoLaunch struct {
	path string // the sudo binary, absolute
	user string // the sandbox user
}

// args is the exact command line: the sudoers rule allows these arguments and
// no others.
func (r ExecRunner) args() (string, []string) {
	if r.sudo != nil {
		return r.sudo.path, []string{"-n", "-u", r.sudo.user, "--", r.Node, r.Bundle}
	}
	return r.Node, []string{r.Bundle}
}

// Start implements Runner.
func (r ExecRunner) Start(ctx context.Context) (Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r.Node == "" || r.Bundle == "" {
		return nil, errors.New("zalo: sidecar node or bundle path not configured")
	}
	name, args := r.args()
	// Not CommandContext: the process outlives the call that starts it (a login
	// spans several calls) and the adapter stops it itself, stdin first.
	cmd := exec.Command(name, args...)
	cmd.Dir = filepath.Dir(r.Bundle)
	cmd.Env = sidecarEnv()
	setProcessGroup(cmd)
	p := &execProcess{cmd: cmd}
	var err error
	if p.stdin, err = cmd.StdinPipe(); err == nil {
		if p.stdout, err = cmd.StdoutPipe(); err == nil {
			p.stderr, err = cmd.StderrPipe()
		}
	}
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		return nil, fmt.Errorf("zalo: start sidecar: %w", err)
	}
	return p, nil
}

// sidecarEnv is the whole environment given to the process (to sudo, which
// resets it, or to node directly in tests).
func sidecarEnv() []string {
	env := []string{"PATH=" + sidecarPath(), "TZ=UTC", "WS_NO_BUFFER_UTIL=1", "WS_NO_UTF_8_VALIDATE=1"}
	return append(env, platformEnv()...)
}

type execProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.Reader
	stderr io.Reader
}

func (p *execProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *execProcess) Stdout() io.Reader     { return p.stdout }
func (p *execProcess) Stderr() io.Reader     { return p.stderr }
func (p *execProcess) Wait() error           { return p.cmd.Wait() }

// Terminate sends SIGTERM to the started process: the sidecar itself, or sudo,
// which relays it.
func (p *execProcess) Terminate() error { return terminate(p.cmd) }

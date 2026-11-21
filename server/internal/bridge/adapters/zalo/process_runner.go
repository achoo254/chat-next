package zalo

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
)

// Runner starts one sidecar process. The adapter starts one per login and one
// per subscribed account; tests give a fake that answers with scripted lines.
type Runner interface {
	Start(ctx context.Context) (Process, error)
}

// Process is a started sidecar. Closing Stdin asks it to stop; Kill ends it
// (and anything it started) at once. Wait returns once it has exited, after
// its stdout and stderr have been read to the end.
type Process interface {
	Stdin() io.WriteCloser
	Stdout() io.Reader
	Stderr() io.Reader
	Wait() error
	Kill() error
}

// ExecRunner runs the bundled sidecar with Node: `<Node> <Bundle>`, in an
// empty temporary directory, with a fixed minimal environment. Nothing of the
// server's environment is inherited: no database DSN, no SecretBox key, no
// NODE_OPTIONS. Running it as a separate OS user is a deployment step (see
// docs/integrations/zalo-sidecar.md), not done here.
type ExecRunner struct {
	// Node is the node binary, a path or a name looked up in PATH.
	Node string
	// Bundle is the absolute path of dist/zalo-sidecar.cjs.
	Bundle string
}

// Start implements Runner.
func (r ExecRunner) Start(ctx context.Context) (Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r.Node == "" || r.Bundle == "" {
		return nil, errors.New("zalo: sidecar node or bundle path not configured")
	}
	dir, err := os.MkdirTemp("", "zalo-sidecar-")
	if err != nil {
		return nil, fmt.Errorf("zalo: sidecar work dir: %w", err)
	}
	// Not CommandContext: the process outlives the call that starts it (a login
	// spans several calls) and the adapter stops it itself, stdin first.
	cmd := exec.Command(r.Node, r.Bundle)
	cmd.Dir = dir
	cmd.Env = sidecarEnv(dir)
	setProcessGroup(cmd)
	p := &execProcess{cmd: cmd, dir: dir}
	if p.stdin, err = cmd.StdinPipe(); err == nil {
		if p.stdout, err = cmd.StdoutPipe(); err == nil {
			p.stderr, err = cmd.StderrPipe()
		}
	}
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("zalo: start sidecar: %w", err)
	}
	return p, nil
}

// sidecarEnv is the whole environment of the sidecar. WS_NO_* keep the ws
// package from loading optional native modules from disk.
func sidecarEnv(home string) []string {
	env := []string{
		"PATH=" + sidecarPath(),
		"HOME=" + home,
		"TZ=UTC",
		"WS_NO_BUFFER_UTIL=1",
		"WS_NO_UTF_8_VALIDATE=1",
	}
	return append(env, platformEnv()...)
}

type execProcess struct {
	cmd    *exec.Cmd
	dir    string
	stdin  io.WriteCloser
	stdout io.Reader
	stderr io.Reader
}

func (p *execProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *execProcess) Stdout() io.Reader     { return p.stdout }
func (p *execProcess) Stderr() io.Reader     { return p.stderr }

// Wait waits for the exit and removes the work directory.
func (p *execProcess) Wait() error {
	err := p.cmd.Wait()
	_ = os.RemoveAll(p.dir)
	return err
}

// Kill ends the process group, so nothing the sidecar might have started
// survives it.
func (p *execProcess) Kill() error { return killProcessGroup(p.cmd) }

package zalo

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strings"
)

// SandboxConfig is how the sidecar is run apart from the server. Every field is
// required except SHA256, which defaults to the bundle's sibling .sha256 file.
type SandboxConfig struct {
	// Node is the absolute path of the node binary (no PATH lookup).
	Node string
	// Bundle is the absolute path of dist/zalo-sidecar.cjs.
	Bundle string
	// User is the OS user the sidecar runs as: not root, not the server's user.
	User string
	// SHA256 is the expected hex digest of the bundle.
	SHA256 string
}

// errSandboxUnsupported: the sandbox switches OS user, which only the Linux
// build does.
var errSandboxUnsupported = errors.New("zalo: the sidecar sandbox (a separate OS user) needs Linux")

// sandboxIdentity is the OS user and group the sidecar runs as.
type sandboxIdentity struct{ uid, gid uint32 }

// fileFacts is what the checks read about a path, without following a
// symbolic link at the path itself.
type fileFacts struct {
	mode     fs.FileMode
	uid, gid uint32
}

// hostSystem is the part of the OS the checks read; tests give a fake.
type hostSystem struct {
	supported  bool
	serverUID  int
	lookupUser func(name string) (uid, gid uint32, err error)
	lstat      func(name string) (fileFacts, error)
	stat       func(name string) (fileFacts, error) // follows links
	readFile   func(name string) ([]byte, error)
	realDir    func(name string) (string, error) // resolves links in a directory path
}

// NewSandboxedRunner checks the sandbox and returns the runner that uses it.
// Any failed check is an error and Zalo must not be offered: the user must be
// a real, unprivileged account other than the server's; node must be an
// absolute path to an executable; the bundle must be a regular file the
// sidecar's user cannot change (nor any directory above it) and must have the
// expected SHA-256.
func NewSandboxedRunner(cfg SandboxConfig) (*ExecRunner, error) {
	return prepareSandbox(cfg, realHost())
}

func prepareSandbox(cfg SandboxConfig, h hostSystem) (*ExecRunner, error) {
	if !h.supported {
		return nil, errSandboxUnsupported
	}
	if cfg.User == "" {
		return nil, errors.New("zalo: no sandbox user configured")
	}
	uid, gid, err := h.lookupUser(cfg.User)
	if err != nil {
		return nil, fmt.Errorf("zalo: sandbox user %q: %w", cfg.User, err)
	}
	if uid == 0 || gid == 0 {
		return nil, fmt.Errorf("zalo: sandbox user %q is root or in the root group", cfg.User)
	}
	if h.serverUID >= 0 && int64(uid) == int64(h.serverUID) {
		return nil, fmt.Errorf("zalo: sandbox user %q is the server's own user", cfg.User)
	}
	id := sandboxIdentity{uid: uid, gid: gid}
	if err := checkNode(cfg.Node, h); err != nil {
		return nil, err
	}
	if err := checkBundle(cfg.Bundle, id, h); err != nil {
		return nil, err
	}
	if err := checkBundleDigest(cfg, h); err != nil {
		return nil, err
	}
	return &ExecRunner{Node: cfg.Node, Bundle: cfg.Bundle, sandbox: &id}, nil
}

func checkNode(node string, h hostSystem) error {
	if !path.IsAbs(node) {
		return errors.New("zalo: node must be an absolute path")
	}
	f, err := h.stat(node)
	if err != nil {
		return fmt.Errorf("zalo: node: %w", err)
	}
	if !f.mode.IsRegular() || f.mode.Perm()&0o111 == 0 {
		return errors.New("zalo: node is not an executable file")
	}
	return nil
}

// checkBundle refuses a bundle the sidecar's user could replace: a link, a
// file it owns or can write, or one in a directory it can write.
func checkBundle(bundle string, id sandboxIdentity, h hostSystem) error {
	if !path.IsAbs(bundle) || path.Clean(bundle) != bundle {
		return errors.New("zalo: bundle must be a clean absolute path")
	}
	f, err := h.lstat(bundle)
	if err != nil {
		return fmt.Errorf("zalo: bundle: %w", err)
	}
	if !f.mode.IsRegular() {
		return errors.New("zalo: bundle is not a regular file (a link is refused)")
	}
	if f.mode.Perm()&0o022 != 0 {
		return errors.New("zalo: bundle is writable by its group or by everyone")
	}
	if f.uid == id.uid || writableBy(f, id) {
		return errors.New("zalo: bundle is owned or writable by the sandbox user")
	}
	dir, err := h.realDir(path.Dir(bundle))
	if err != nil {
		return fmt.Errorf("zalo: bundle directory: %w", err)
	}
	for {
		d, err := h.lstat(dir)
		if err != nil {
			return fmt.Errorf("zalo: bundle directory: %w", err)
		}
		if !d.mode.IsDir() {
			return fmt.Errorf("zalo: %s is not a directory", dir)
		}
		if d.uid == id.uid || writableBy(d, id) {
			return fmt.Errorf("zalo: %s is owned or writable by the sandbox user", dir)
		}
		if dir == "/" {
			return nil
		}
		dir = path.Dir(dir)
	}
}

// writableBy reports whether the sandbox user may write f. Its supplementary
// groups do not count: the sidecar starts without them. A world-writable
// directory is refused even with the sticky bit.
func writableBy(f fileFacts, id sandboxIdentity) bool {
	perm := f.mode.Perm()
	return (f.uid == id.uid && perm&0o200 != 0) || (f.gid == id.gid && perm&0o020 != 0) || perm&0o002 != 0
}

var hexDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

// checkBundleDigest compares the bundle with SHA256, or with the first word of
// the sibling .sha256 file that the build writes next to it.
func checkBundleDigest(cfg SandboxConfig, h hostSystem) error {
	want := strings.ToLower(strings.TrimSpace(cfg.SHA256))
	if want == "" {
		raw, err := h.readFile(cfg.Bundle + ".sha256")
		if err != nil {
			return fmt.Errorf("zalo: bundle digest file: %w", err)
		}
		if fields := strings.Fields(string(raw)); len(fields) > 0 {
			want = strings.ToLower(fields[0])
		}
	}
	if !hexDigest.MatchString(want) {
		return errors.New("zalo: the expected bundle digest is not a SHA-256")
	}
	data, err := h.readFile(cfg.Bundle)
	if err != nil {
		return fmt.Errorf("zalo: bundle: %w", err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != want {
		return errors.New("zalo: bundle digest does not match; it is not the reviewed bundle")
	}
	return nil
}

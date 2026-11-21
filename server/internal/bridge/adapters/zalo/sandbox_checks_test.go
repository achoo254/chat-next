package zalo

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"strings"
	"testing"
)

const (
	serverUID  = 1000
	sandboxUID = 1500
	sandboxGID = 1500
	bundlePath = "/opt/chat/zalo/zalo-sidecar.cjs"
	nodePath   = "/usr/bin/node"
)

var bundleBytes = []byte("the reviewed bundle")

// fakeHost is a small file tree: root owns everything, read-only for others.
type fakeHost struct {
	files map[string]fileFacts
	data  map[string][]byte
	users map[string][2]uint32
}

func newFakeHost() *fakeHost {
	sum := sha256.Sum256(bundleBytes)
	h := &fakeHost{
		files: map[string]fileFacts{
			"/":                    {mode: fs.ModeDir | 0o755},
			"/opt":                 {mode: fs.ModeDir | 0o755},
			"/opt/chat":            {mode: fs.ModeDir | 0o755, uid: serverUID, gid: serverUID},
			"/opt/chat/zalo":       {mode: fs.ModeDir | 0o755},
			bundlePath:             {mode: 0o644},
			bundlePath + ".sha256": {mode: 0o644},
			nodePath:               {mode: 0o755},
		},
		data: map[string][]byte{
			bundlePath:             bundleBytes,
			bundlePath + ".sha256": []byte(hex.EncodeToString(sum[:]) + "  zalo-sidecar.cjs\n"),
		},
		users: map[string][2]uint32{"chat-zalo": {sandboxUID, sandboxGID}, "root": {0, 0}, "chat": {serverUID, serverUID}},
	}
	return h
}

func (h *fakeHost) system() hostSystem {
	get := func(name string) (fileFacts, error) {
		f, ok := h.files[name]
		if !ok {
			return fileFacts{}, fs.ErrNotExist
		}
		return f, nil
	}
	return hostSystem{
		supported: true,
		serverUID: serverUID,
		lookupUser: func(name string) (uint32, uint32, error) {
			ids, ok := h.users[name]
			if !ok {
				return 0, 0, errors.New("unknown user")
			}
			return ids[0], ids[1], nil
		},
		lstat: get,
		stat:  get,
		readFile: func(name string) ([]byte, error) {
			d, ok := h.data[name]
			if !ok {
				return nil, fs.ErrNotExist
			}
			return d, nil
		},
		realDir: func(name string) (string, error) { return name, nil },
	}
}

var goodSandbox = SandboxConfig{Node: nodePath, Bundle: bundlePath, User: "chat-zalo"}

func TestSandboxAcceptsAProperSetup(t *testing.T) {
	r, err := prepareSandbox(goodSandbox, newFakeHost().system())
	if err != nil {
		t.Fatal(err)
	}
	if r.Node != nodePath || r.Bundle != bundlePath || r.sandbox == nil || r.sandbox.uid != sandboxUID || r.sandbox.gid != sandboxGID {
		t.Errorf("runner = %+v", r)
	}
}

func TestSandboxRefusals(t *testing.T) {
	cases := map[string]struct {
		cfg    func(c *SandboxConfig)
		host   func(h *fakeHost)
		reason string
	}{
		"not linux":             {host: nil, reason: "needs Linux"},
		"no user":               {cfg: func(c *SandboxConfig) { c.User = "" }, reason: "no sandbox user"},
		"unknown user":          {cfg: func(c *SandboxConfig) { c.User = "nobody-here" }, reason: "unknown user"},
		"root":                  {cfg: func(c *SandboxConfig) { c.User = "root" }, reason: "root"},
		"the server's user":     {cfg: func(c *SandboxConfig) { c.User = "chat" }, reason: "server's own user"},
		"relative node":         {cfg: func(c *SandboxConfig) { c.Node = "node" }, reason: "node must be an absolute path"},
		"node not executable":   {host: func(h *fakeHost) { h.files[nodePath] = fileFacts{mode: 0o644} }, reason: "not an executable"},
		"relative bundle":       {cfg: func(c *SandboxConfig) { c.Bundle = "zalo-sidecar.cjs" }, reason: "clean absolute path"},
		"missing bundle":        {host: func(h *fakeHost) { delete(h.files, bundlePath) }, reason: "bundle"},
		"bundle is a link":      {host: func(h *fakeHost) { h.files[bundlePath] = fileFacts{mode: fs.ModeSymlink | 0o777} }, reason: "not a regular file"},
		"world-writable bundle": {host: func(h *fakeHost) { h.files[bundlePath] = fileFacts{mode: 0o646} }, reason: "writable by its group or by everyone"},
		"group-writable bundle": {host: func(h *fakeHost) { h.files[bundlePath] = fileFacts{mode: 0o664} }, reason: "writable by its group or by everyone"},
		"bundle owned by the sandbox": {host: func(h *fakeHost) {
			h.files[bundlePath] = fileFacts{mode: 0o444, uid: sandboxUID}
		}, reason: "owned or writable by the sandbox user"},
		"directory owned by the sandbox": {host: func(h *fakeHost) {
			h.files["/opt/chat/zalo"] = fileFacts{mode: fs.ModeDir | 0o755, uid: sandboxUID}
		}, reason: "/opt/chat/zalo is owned or writable"},
		"directory writable by the sandbox group": {host: func(h *fakeHost) {
			h.files["/opt"] = fileFacts{mode: fs.ModeDir | 0o775, gid: sandboxGID}
		}, reason: "/opt is owned or writable"},
		"world-writable root":       {host: func(h *fakeHost) { h.files["/"] = fileFacts{mode: fs.ModeDir | fs.ModeSticky | 0o777} }, reason: "/ is owned or writable"},
		"digest mismatch":           {host: func(h *fakeHost) { h.data[bundlePath] = []byte("something else") }, reason: "digest does not match"},
		"no digest file":            {host: func(h *fakeHost) { delete(h.data, bundlePath+".sha256") }, reason: "digest file"},
		"bad digest file":           {host: func(h *fakeHost) { h.data[bundlePath+".sha256"] = []byte("nope\n") }, reason: "not a SHA-256"},
		"configured digest differs": {cfg: func(c *SandboxConfig) { c.SHA256 = strings.Repeat("0", 64) }, reason: "digest does not match"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := goodSandbox
			if tc.cfg != nil {
				tc.cfg(&cfg)
			}
			host := newFakeHost()
			sys := host.system()
			if tc.host != nil {
				tc.host(host)
			} else if tc.cfg == nil {
				sys.supported = false
			}
			_, err := prepareSandbox(cfg, sys)
			if err == nil || !strings.Contains(err.Error(), tc.reason) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.reason)
			}
		})
	}
}

func TestSandboxTakesAConfiguredDigest(t *testing.T) {
	sum := sha256.Sum256(bundleBytes)
	host := newFakeHost()
	delete(host.data, bundlePath+".sha256")
	cfg := goodSandbox
	cfg.SHA256 = strings.ToUpper(hex.EncodeToString(sum[:]))
	if _, err := prepareSandbox(cfg, host.system()); err != nil {
		t.Fatal(err)
	}
}

func TestSandboxOutsideLinuxIsRefusedByTheRealHost(t *testing.T) {
	if realHost().supported {
		t.Skip("Linux: the sandbox is supported")
	}
	if _, err := NewSandboxedRunner(goodSandbox); !errors.Is(err, errSandboxUnsupported) {
		t.Fatalf("err = %v", err)
	}
}

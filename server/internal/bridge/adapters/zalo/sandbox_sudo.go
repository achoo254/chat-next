package zalo

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"unicode"
)

// checkSudo returns the sudo to use once it is the real binary (absolute,
// regular, owned by root with the set-user-ID bit) and grants the one command.
func checkSudo(cfg SandboxConfig, h hostSystem) (string, error) {
	sudo := cfg.Sudo
	if sudo == "" {
		sudo = defaultSudo
	}
	if !path.IsAbs(sudo) {
		return "", errors.New("zalo: sudo must be an absolute path")
	}
	f, err := h.stat(sudo)
	if err != nil {
		return "", fmt.Errorf("zalo: sudo: %w", err)
	}
	if !f.mode.IsRegular() || f.uid != 0 || f.mode&fs.ModeSetuid == 0 {
		return "", errors.New("zalo: sudo is not a set-user-ID file owned by root")
	}
	if err := h.sudoAllows(sudo, cfg.User, cfg.Node, cfg.Bundle); err != nil {
		return "", fmt.Errorf("zalo: the sudoers rule for the sidecar is missing or differs: %w", err)
	}
	return sudo, nil
}

// sudoListArgs asks sudo whether the command is allowed: `-l` with a command
// exits 0 only when that exact command line (these arguments, no others) is
// allowed as user, and `-n` makes it fail instead of asking for a password.
// Measured with sudo 1.9.9: extra or missing arguments, another user or
// another command all exit 1.
func sudoListArgs(user, node, bundle string) []string {
	return []string{"-n", "-u", user, "-l", "--", node, bundle}
}

// sudoReply is a short printable excerpt of what sudo answered, for the log.
func sudoReply(out []byte) string {
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	line = strings.Map(func(r rune) rune {
		if unicode.IsPrint(r) {
			return r
		}
		return -1
	}, line)
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}

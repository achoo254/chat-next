package config

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ParseEnvFile reads KEY=VALUE lines. Blank lines and lines starting with
// '#' are skipped; a value may be wrapped in matching single or double
// quotes, which are removed (no escape processing). Errors carry the line
// number, never the line itself.
func ParseEnvFile(r io.Reader) ([][2]string, error) {
	var pairs [][2]string
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !envKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("env file line %d: expected KEY=VALUE", n)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') {
			if value[len(value)-1] != value[0] {
				return nil, fmt.Errorf("env file line %d: unterminated quote", n)
			}
			value = value[1 : len(value)-1]
		}
		pairs = append(pairs, [2]string{key, value})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("env file: %w", err)
	}
	return pairs, nil
}

// LoadEnvFile sets the variables of the file at path that are not already
// set in the process environment.
func LoadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("env file: %w", err)
	}
	defer func() { _ = f.Close() }()
	pairs, err := ParseEnvFile(f)
	if err != nil {
		return err
	}
	for _, kv := range pairs {
		if _, set := os.LookupEnv(kv[0]); set {
			continue
		}
		if err := os.Setenv(kv[0], kv[1]); err != nil {
			return fmt.Errorf("env file: set %s: %w", kv[0], err)
		}
	}
	return nil
}

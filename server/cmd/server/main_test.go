package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunRejectsUnknownRole(t *testing.T) {
	var stderr bytes.Buffer
	if code := run([]string{"-role", "nope"}, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "unknown role") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunAcceptsEveryRole(t *testing.T) {
	for _, role := range Roles {
		var stderr bytes.Buffer
		if code := run([]string{"-role", role}, &stderr); code == 2 {
			t.Fatalf("role %q rejected: %s", role, stderr.String())
		}
	}
}

package watch

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackupStale(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	check := Backup(dir, func() time.Time { return now })
	if p, _ := check(context.Background()); len(p) != 1 || p[0].Key != "backup_stale" {
		t.Fatalf("no backup: %v", p)
	}
	f := filepath.Join(dir, "chat-20261017-025000.dump")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if p, _ := check(context.Background()); len(p) != 0 {
		t.Fatalf("fresh backup: %v", p)
	}
	old := now.Add(-30 * time.Hour)
	if err := os.Chtimes(f, old, old); err != nil {
		t.Fatal(err)
	}
	if p, _ := check(context.Background()); len(p) != 1 || !strings.Contains(p[0].Summary, "30 giờ") {
		t.Fatalf("stale backup: %v", p)
	}
	if p, _ := Backup(filepath.Join(dir, "none"), time.Now)(context.Background()); len(p) != 0 {
		t.Fatalf("another machine: %v", p)
	}
}

func TestErrorCounter(t *testing.T) {
	c := NewErrorCounter()
	now := time.Now()
	c.now = func() time.Time { return now }
	for range 3 {
		c.add()
	}
	now = now.Add(10 * time.Minute)
	c.add()
	if n := c.Recent(5 * time.Minute); n != 1 {
		t.Fatalf("recent = %d, want the last one only", n)
	}
	if p, _ := Errors(c)(context.Background()); len(p) != 0 {
		t.Fatalf("one error alerts: %v", p)
	}
	for range errorsThreshold {
		c.add()
	}
	if p, _ := Errors(c)(context.Background()); len(p) != 1 {
		t.Fatalf("errors: %v", p)
	}
}

func TestDiskIgnoresUnknownPaths(t *testing.T) {
	if p, err := Disk("", "/no/such/path")(context.Background()); err != nil || len(p) != 0 {
		t.Fatalf("disk: %v, %v", p, err)
	}
}

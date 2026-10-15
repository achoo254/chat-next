// Package testdb runs a throwaway PostgreSQL 16 for the tests of one package
// (no Docker): TestMain calls Main, and every test gets its own database
// cloned from a migrated template with New.
//
// The PostgreSQL binaries are downloaded and extracted once into
// ~/.embedded-postgres-go.
// When that download is impossible (no network on first run) the tests that
// need a database skip with the reason; any other failure fails the package.
//
// Start runs the same server outside tests (the local end-to-end stack,
// cmd/e2e-stack).
package testdb

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"

	"app.local/server/internal/store"
	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
	"github.com/jackc/pgx/v5"
)

const (
	version      = embeddedpostgres.V16
	templateName = "chat_template"
	user         = "postgres"
	password     = "postgres"
)

var (
	// baseURL is the server URL without a database name; empty when the
	// server is unavailable.
	baseURL string
	// unavailable explains why there is no server.
	unavailable string
)

// Main starts PostgreSQL, migrates the template database, runs the tests
// and stops the server. Use it as os.Exit(testdb.Main(m)) in TestMain.
func Main(m *testing.M) int {
	dir, err := os.MkdirTemp("", "chat-testdb-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	defer func() { _ = os.RemoveAll(dir) }()

	srv, err := Start(dir, 0)
	if err != nil {
		if unavailable == "" {
			fmt.Fprintln(os.Stderr, "testdb:", err)
			return 1
		}
		fmt.Fprintln(os.Stderr, "testdb: database tests will be skipped:", unavailable)
		return m.Run()
	}
	defer func() {
		if err := srv.Stop(); err != nil {
			fmt.Fprintln(os.Stderr, "testdb: stop:", err)
		}
	}()
	baseURL = srv.BaseURL
	if err := prepareTemplate(srv); err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	return m.Run()
}

// Server is a running PostgreSQL started by Start.
type Server struct {
	pg *embeddedpostgres.EmbeddedPostgres
	// BaseURL is the server URL without a database name.
	BaseURL string
}

// Stop shuts the server down.
func (s *Server) Stop() error { return s.pg.Stop() }

// CreateMigrated creates database name, applies every migration and returns
// the database URL.
func (s *Server) CreateMigrated(ctx context.Context, name string, logger *slog.Logger) (string, error) {
	if err := exec(ctx, s.BaseURL, "CREATE DATABASE "+name); err != nil {
		return "", err
	}
	url := s.BaseURL + name
	return url, store.Migrate(ctx, url, logger)
}

// Start launches the server with its data under dir, listening on port of
// 127.0.0.1 (0 picks a free port). Concurrent starts are serialized by a
// file lock so the shared binary download happens once.
func Start(dir string, port uint32) (*Server, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	cacheDir := filepath.Join(home, ".embedded-postgres-go")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	unlock, err := lockFile(filepath.Join(cacheDir, "chat-testdb.lock"))
	if err != nil {
		return nil, err
	}
	defer unlock()

	cached, _ := filepath.Glob(filepath.Join(cacheDir, "embedded-postgres-binaries-*-"+string(version)+".txz"))
	// The binaries are extracted once into a shared directory (extraction
	// is slow, especially under -race); the marker proves it completed.
	binDir := filepath.Join(cacheDir, "chat-testdb-"+string(version)+"-"+runtime.GOOS+"-"+runtime.GOARCH)
	marker := filepath.Join(binDir, ".complete")
	if _, err := os.Stat(marker); err != nil {
		if err := os.RemoveAll(binDir); err != nil {
			return nil, err
		}
	}
	if port == 0 {
		if port, err = freePort(); err != nil {
			return nil, err
		}
	}
	var logs bytes.Buffer
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Version(version).
		Port(port).
		Username(user).
		Password(password).
		CachePath(cacheDir).
		BinariesPath(binDir).
		RuntimePath(filepath.Join(dir, "runtime")).
		DataPath(filepath.Join(dir, "data")).
		StartTimeout(90 * time.Second).
		Logger(&logs))
	if err := pg.Start(); err != nil {
		if len(cached) == 0 {
			unavailable = "PostgreSQL " + string(version) + " binaries could not be downloaded: " + err.Error()
		}
		return nil, fmt.Errorf("start PostgreSQL: %w\n%s", err, logs.String())
	}
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		_ = pg.Stop()
		return nil, err
	}
	return &Server{pg: pg, BaseURL: fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/", user, password, port)}, nil
}

func lockFile(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

func freePort() (uint32, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer func() { _ = l.Close() }()
	addr, ok := l.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("unexpected listener address %v", l.Addr())
	}
	return uint32(addr.Port), nil
}

func prepareTemplate(srv *Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	_, err := srv.CreateMigrated(ctx, templateName, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return err
}

func exec(ctx context.Context, base, sql string) error {
	conn, err := pgx.Connect(ctx, base+"postgres")
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	_, err = conn.Exec(ctx, sql)
	return err
}

// New returns the URL of a fresh, migrated database that is dropped when the
// test ends. It skips the test when PostgreSQL is unavailable.
func New(t testing.TB) string {
	t.Helper()
	if baseURL == "" {
		if unavailable == "" {
			t.Fatal("testdb: Main was not called from TestMain")
		}
		t.Skip("testdb:", unavailable)
	}
	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	name := "t_" + hex.EncodeToString(suffix[:])
	ctx := context.Background()
	if err := exec(ctx, baseURL, "CREATE DATABASE "+name+" TEMPLATE "+templateName); err != nil {
		t.Fatalf("testdb: create database: %v", err)
	}
	t.Cleanup(func() {
		if err := exec(context.Background(), baseURL, "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("testdb: drop database: %v", err)
		}
	})
	return baseURL + name
}

// Open returns a Store on a fresh database (see New), closed when the test
// ends.
func Open(t testing.TB) *store.Store {
	t.Helper()
	url := New(t)
	s, err := store.Open(context.Background(), url)
	if err != nil {
		t.Fatalf("testdb: open store: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

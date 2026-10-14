package store

import (
	"errors"
	"testing"
)

func TestPoolConfigMaxConns(t *testing.T) {
	cases := map[string]int32{
		"postgres://u:p@127.0.0.1:5432/chat":                         defaultMaxConns,
		"postgres://u:p@127.0.0.1:5432/chat?sslmode=disable":         defaultMaxConns,
		"postgres://u:p@127.0.0.1:5432/chat?pool_max_conns=3":        3,
		"host=127.0.0.1 dbname=chat user=u pool_max_conns=25":        25,
		"host=127.0.0.1 dbname=chat user=u application_name=chatapi": defaultMaxConns,
	}
	for url, want := range cases {
		cfg, err := poolConfig(url)
		if err != nil {
			t.Fatalf("%s: %v", url, err)
		}
		if cfg.MaxConns != want {
			t.Errorf("%s: MaxConns = %d, want %d", url, cfg.MaxConns, want)
		}
	}
	if _, err := poolConfig("postgres://u:secret@[bad"); !errors.Is(err, errInvalidURL) {
		t.Fatalf("invalid URL err = %v", err)
	}
}

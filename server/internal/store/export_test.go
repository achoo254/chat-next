package store

import (
	"context"
	"testing"
)

// ExpireGrantLeases moves every grant check lease into the past, as if the
// checks holding them had crashed long ago.
func ExpireGrantLeases(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(),
		`UPDATE user_sessions SET grant_lease_until = now() - interval '1 second' WHERE grant_lease_until IS NOT NULL`); err != nil {
		t.Fatal(err)
	}
}

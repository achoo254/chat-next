package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrLeaseLost reports a Snowflake worker lease that another process holds
// now, or no free worker at all.
var ErrLeaseLost = errors.New("store: snowflake worker lease lost")

// WorkerLease is a leased Snowflake worker number.
type WorkerLease struct {
	Worker int64
	// LastUnixMs is the newest millisecond the previous holder may have used;
	// the new holder issues ids only after it.
	LastUnixMs int64
}

// LeaseSnowflakeWorker takes a worker number whose lease has expired, for
// ttl. holder identifies this process.
func (s *Store) LeaseSnowflakeWorker(ctx context.Context, holder string, ttl time.Duration) (WorkerLease, error) {
	var l WorkerLease
	err := s.pool.QueryRow(ctx, `
		UPDATE snowflake_workers w SET holder = $1, lease_until = now() + $2::interval
		WHERE w.worker = (SELECT worker FROM snowflake_workers WHERE lease_until < now()
			ORDER BY lease_until, worker LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING w.worker, w.last_ms`, holder, ttl).Scan(&l.Worker, &l.LastUnixMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkerLease{}, ErrLeaseLost
	}
	if err != nil {
		return WorkerLease{}, fmt.Errorf("store: lease snowflake worker: %w", err)
	}
	return l, nil
}

// RenewSnowflakeWorker extends the lease and records the newest millisecond
// issued so far. The holder must stop issuing before its lease runs out, so
// a later holder, which starts after the expiry, never reuses a millisecond.
// ErrLeaseLost when the lease is no longer this holder's.
func (s *Store) RenewSnowflakeWorker(ctx context.Context, worker int64, holder string, ttl time.Duration, lastUnixMs int64) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE snowflake_workers SET lease_until = now() + $3::interval, last_ms = greatest(last_ms, $4)
		WHERE worker = $1 AND holder = $2 AND lease_until > now()`, worker, holder, ttl, lastUnixMs)
	if err != nil {
		return fmt.Errorf("store: renew snowflake worker: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// ReleaseSnowflakeWorker ends the lease after recording lastUnixMs.
func (s *Store) ReleaseSnowflakeWorker(ctx context.Context, worker int64, holder string, lastUnixMs int64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE snowflake_workers SET lease_until = '-infinity', holder = NULL, last_ms = greatest(last_ms, $3)
		WHERE worker = $1 AND holder = $2`, worker, holder, lastUnixMs)
	if err != nil {
		return fmt.Errorf("store: release snowflake worker: %w", err)
	}
	return nil
}

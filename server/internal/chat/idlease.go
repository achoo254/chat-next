package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"app.local/server/internal/ids"
	"app.local/server/internal/store"
)

// Snowflake worker lease timing: the lease is renewed every leaseRenew and
// the generator refuses ids once leaseStopAfter has passed without a
// renewal, well before another process may take the worker (leaseTTL).
const (
	leaseTTL       = time.Minute
	leaseRenew     = 15 * time.Second
	leaseStopAfter = 40 * time.Second
)

// ErrNoWorkerLease reports that message ids cannot be issued because the
// Snowflake worker lease was lost.
var ErrNoWorkerLease = errors.New("chat: snowflake worker lease lost")

// LeasedIDs issues Snowflake ids under a worker number leased in Postgres
// (ADR 0001), so two processes never share a worker.
type LeasedIDs struct {
	st     *store.Store
	holder string
	logger *slog.Logger
	worker int64
	gen    *ids.Snowflake

	mu         sync.Mutex
	validUntil time.Time
}

// LeaseIDs takes a free worker number.
func LeaseIDs(ctx context.Context, st *store.Store, logger *slog.Logger) (*LeasedIDs, error) {
	host, _ := os.Hostname()
	holder := fmt.Sprintf("%s/%d/%d", host, os.Getpid(), time.Now().UnixNano())
	lease, err := st.LeaseSnowflakeWorker(ctx, holder, leaseTTL)
	if err != nil {
		return nil, err
	}
	gen, err := ids.NewSnowflakeAfter(lease.Worker, lease.LastUnixMs)
	if err != nil {
		return nil, err
	}
	logger.Info("snowflake worker leased", "worker", lease.Worker)
	return &LeasedIDs{st: st, holder: holder, logger: logger, worker: lease.Worker, gen: gen,
		validUntil: time.Now().Add(leaseStopAfter)}, nil
}

// Next implements IDSource.
func (l *LeasedIDs) Next() (int64, error) {
	l.mu.Lock()
	valid := time.Now().Before(l.validUntil)
	l.mu.Unlock()
	if !valid {
		return 0, ErrNoWorkerLease
	}
	return l.gen.Next()
}

// Run renews the lease until ctx ends, then releases it.
func (l *LeasedIDs) Run(ctx context.Context) {
	ticker := time.NewTicker(leaseRenew)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			l.mu.Lock()
			l.validUntil = time.Time{}
			l.mu.Unlock()
			if err := l.st.ReleaseSnowflakeWorker(rctx, l.worker, l.holder, l.gen.LastUnixMs()); err != nil {
				l.logger.Warn("snowflake worker release failed", "err", err)
			}
			return
		case <-ticker.C:
			started := time.Now()
			err := l.st.RenewSnowflakeWorker(ctx, l.worker, l.holder, leaseTTL, l.gen.LastUnixMs())
			if err != nil {
				l.logger.Error("snowflake worker renewal failed", "worker", l.worker, "err", err)
				continue
			}
			l.mu.Lock()
			l.validUntil = started.Add(leaseStopAfter)
			l.mu.Unlock()
		}
	}
}

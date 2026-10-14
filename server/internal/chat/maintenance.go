package chat

import (
	"context"
	"fmt"
	"time"
)

// Maintenance timing.
const (
	maintenanceInterval = time.Hour
	epochInterval       = 30 * time.Second
	// partitionsAhead is how many days of log partitions exist in advance,
	// so a stopped maintenance loop has weeks before writes fail.
	partitionsAhead  = 30
	dedupeRetention  = 7 * 24 * time.Hour
	maintenanceLimit = 10 * time.Minute
)

// EnsurePartitions creates the daily partitions of the logs and the outbox
// ahead of time and drops the ones past retention.
func (s *Service) EnsurePartitions(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("chat: partitions: %w", err)
	}
	defer conn.Release()
	// Dropping a partition locks its parent briefly; never queue behind a
	// long transaction.
	if _, err := conn.Exec(ctx, `SET lock_timeout = '5s'`); err != nil {
		return fmt.Errorf("chat: partitions: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), `RESET lock_timeout`) }()
	if _, err := conn.Exec(ctx, `SELECT chat_ensure_day_partitions($1, $2)`, partitionsAhead, s.cfg.LogRetentionDays); err != nil {
		return fmt.Errorf("chat: partitions: %w", err)
	}
	return nil
}

// maintain runs the hourly jobs once.
func (s *Service) maintain(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, maintenanceLimit)
	defer cancel()
	if err := s.EnsurePartitions(ctx); err != nil {
		s.logger.Error("log partition maintenance failed", "err", err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM send_dedupe WHERE created_at < now() - $1::interval`, dedupeRetention); err != nil {
		s.logger.Error("send dedupe cleanup failed", "err", err)
	}
	if err := s.previews.Purge(ctx); err != nil {
		s.logger.Error("link preview cleanup failed", "err", err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM oidc_logout_jti WHERE expires_at < now()`); err != nil {
		s.logger.Error("logout jti cleanup failed", "err", err)
	}
}

// RunMaintenance runs the hourly jobs and re-reads server_epoch every 30
// seconds until ctx ends.
func (s *Service) RunMaintenance(ctx context.Context) {
	hourly := time.NewTicker(maintenanceInterval)
	defer hourly.Stop()
	epoch := time.NewTicker(epochInterval)
	defer epoch.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-hourly.C:
			s.maintain(ctx)
		case <-epoch.C:
			if err := s.LoadEpoch(ctx); err != nil && ctx.Err() == nil {
				s.logger.Error("server epoch refresh failed", "err", err)
			}
		}
	}
}

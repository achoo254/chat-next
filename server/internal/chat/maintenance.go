package chat

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Maintenance timing.
const (
	maintenanceInterval = time.Hour
	epochInterval       = 30 * time.Second
	// partitionsAhead is how many days of log partitions exist in advance,
	// so a stopped maintenance loop has weeks before writes fail.
	partitionsAhead = 30
	// partitionsWarnDays: fewer days of partitions ahead than this is logged
	// as a warning (writes fail on the first day without one).
	partitionsWarnDays = 7
	dedupeRetention    = 7 * 24 * time.Hour
	maintenanceLimit   = 10 * time.Minute
)

// EnsurePartitions creates the daily partitions of the logs and the outbox
// ahead of time, warns when fewer than partitionsWarnDays days are left,
// and drops the ones past retention. Creating and dropping are separate
// transactions; a partition is dropped only after DETACH PARTITION ...
// CONCURRENTLY, which never holds a lock that blocks writers of the parent
// for the whole drop.
func (s *Service) EnsurePartitions(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("chat: partitions: %w", err)
	}
	defer conn.Release()
	// Never queue behind a long transaction for a lock on a parent table.
	if _, err := conn.Exec(ctx, `SET lock_timeout = '5s'`); err != nil {
		return fmt.Errorf("chat: partitions: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), `RESET lock_timeout`) }()
	createErr := error(nil)
	if _, err := conn.Exec(ctx, `SELECT chat_create_day_partitions($1)`, partitionsAhead); err != nil {
		createErr = fmt.Errorf("chat: create partitions: %w", err)
	}
	var ahead int
	if err := conn.QueryRow(ctx, `SELECT chat_day_partitions_ahead()`).Scan(&ahead); err != nil {
		return errors.Join(createErr, fmt.Errorf("chat: partitions ahead: %w", err))
	}
	if ahead < partitionsWarnDays {
		s.logger.Warn("log partitions cover fewer days ahead than expected; writes fail on the first day without one",
			"days_ahead", ahead, "want_at_least", partitionsWarnDays)
	}
	return errors.Join(createErr, dropExpiredPartitions(ctx, conn, s.cfg.LogRetentionDays))
}

type expiredPartition struct {
	parent, part, state string
}

// dropExpiredPartitions detaches (concurrently, each statement in its own
// implicit transaction) and drops the partitions past retention. A detach
// interrupted earlier is finalized; a table detached but not dropped is
// dropped. One failure does not stop the others.
func dropExpiredPartitions(ctx context.Context, conn *pgxpool.Conn, keepDays int) error {
	rows, err := conn.Query(ctx, `SELECT parent, part, state FROM chat_expired_day_partitions($1)`, keepDays)
	if err != nil {
		return fmt.Errorf("chat: expired partitions: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (expiredPartition, error) {
		var p expiredPartition
		err := r.Scan(&p.parent, &p.part, &p.state)
		return p, err
	})
	if err != nil {
		return fmt.Errorf("chat: expired partitions: %w", err)
	}
	var errs []error
	for _, p := range list {
		parent, part := pgx.Identifier{p.parent}.Sanitize(), pgx.Identifier{p.part}.Sanitize()
		var detach string
		switch p.state {
		case "attached":
			detach = `ALTER TABLE ` + parent + ` DETACH PARTITION ` + part + ` CONCURRENTLY`
		case "pending":
			detach = `ALTER TABLE ` + parent + ` DETACH PARTITION ` + part + ` FINALIZE`
		}
		if detach != "" {
			if _, err := conn.Exec(ctx, detach); err != nil {
				errs = append(errs, fmt.Errorf("chat: detach %s: %w", p.part, err))
				continue
			}
		}
		if _, err := conn.Exec(ctx, `DROP TABLE `+part); err != nil {
			errs = append(errs, fmt.Errorf("chat: drop %s: %w", p.part, err))
		}
	}
	return errors.Join(errs...)
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
	if _, err := s.pool.Exec(ctx, `DELETE FROM read_receipts WHERE read_at < now() - $1::interval`, s.cfg.ReadReceiptsMaxAge); err != nil {
		s.logger.Error("read receipts cleanup failed", "err", err)
	}
	if n, err := s.purgeDeletedChats(ctx); err != nil {
		s.logger.Error("deleted chats purge failed", "err", err)
	} else if n > 0 {
		s.logger.Info("deleted chats purged", "chats", n)
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

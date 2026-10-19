package watch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"app.local/server/internal/chat"
	"app.local/server/internal/ids"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The daily digest: at DigestHour (Asia/Saigon) the operators' group gets
// the numbers of the day before. ops_digests keeps the last day posted, so
// a restart never posts a day twice, and a process that was down at
// DigestHour posts the latest missed day once when it starts (never a
// backlog of every day missed).
const (
	DigestHour = 8
	// digestErrorsShown: the most frequent client errors listed.
	digestErrorsShown = 3
	digestErrorMax    = 100
	// clientErrorsKeep: older client error counts are deleted.
	clientErrorsKeep = 90 * 24 * time.Hour
)

// DigestConfig wires the digest.
type DigestConfig struct {
	TenantID string
	Pool     *pgxpool.Pool
	Group    *Group
	Logger   *slog.Logger
	// Now is the clock (tests).
	Now func() time.Time
}

// Digest posts the daily numbers.
type Digest struct {
	cfg DigestConfig
	// done is the last day known posted (or skipped), so the minute's
	// check costs nothing after it.
	done time.Time
}

// NewDigest returns the daily digest of a tenant.
func NewDigest(cfg DigestConfig) *Digest {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Digest{cfg: cfg}
}

// Run posts each day's digest until ctx ends.
func (d *Digest) Run(ctx context.Context) {
	ticker := time.NewTicker(Every)
	defer ticker.Stop()
	for {
		if err := d.Once(ctx); err != nil && ctx.Err() == nil {
			d.cfg.Logger.Warn("watch: daily digest failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// DueDay is the day the digest at now covers: yesterday from DigestHour
// on, the day before until then (Asia/Saigon).
func DueDay(now time.Time) time.Time {
	day := chat.SaigonDay(now).AddDate(0, 0, -1)
	if now.In(chat.Saigon).Hour() < DigestHour {
		day = day.AddDate(0, 0, -1)
	}
	return day
}

// Once posts the digest of the due day unless it was posted already.
func (d *Digest) Once(ctx context.Context) error {
	day := DueDay(d.cfg.Now())
	if !d.done.Before(day) {
		return nil
	}
	var last time.Time
	err := d.cfg.Pool.QueryRow(ctx, `SELECT last_day FROM ops_digests WHERE tenant_id = $1`, d.cfg.TenantID).Scan(&last)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("watch: digest marker: %w", err)
	}
	if err == nil && !last.Before(day) {
		d.done = last
		return nil
	}
	hook, err := d.cfg.Group.Hook(ctx)
	if err != nil {
		return err
	}
	if hook == "" {
		d.cfg.Logger.Info("watch: no operators' group; daily digest skipped", "day", day.Format(time.DateOnly))
		d.done = day
		return nil
	}
	stats, err := d.Stats(ctx, day)
	if err != nil {
		return err
	}
	// The hook's idempotency key covers a crash between the post and the
	// marker.
	if err := d.cfg.Group.Post(ctx, "digest", DigestNotice(stats)); err != nil {
		return err
	}
	if _, err := d.cfg.Pool.Exec(ctx, `
		INSERT INTO ops_digests (tenant_id, last_day) VALUES ($1, $2)
		ON CONFLICT (tenant_id) DO UPDATE SET last_day = greatest(ops_digests.last_day, excluded.last_day), posted_at = now()`,
		d.cfg.TenantID, day); err != nil {
		return fmt.Errorf("watch: store the digest marker: %w", err)
	}
	d.done = day
	d.cfg.Logger.Info("watch: daily digest posted", "day", day.Format(time.DateOnly))
	if _, err := d.cfg.Pool.Exec(ctx, `DELETE FROM client_errors WHERE tenant_id = $1 AND day < $2`,
		d.cfg.TenantID, day.Add(-clientErrorsKeep)); err != nil {
		d.cfg.Logger.Warn("watch: prune client errors", "err", err)
	}
	return nil
}

// ClientErrorCount is one kind of client error and how often it showed.
type ClientErrorCount struct {
	Kind, Message, Location string
	Count                   int64
}

// DigestStats are the numbers of one day.
type DigestStats struct {
	Day time.Time
	// NewUsers signed up; Senders sent at least one message; Messages
	// sent by people (not bots or integrations), with text or a file: not
	// service messages (group created, member added) nor recalled ones.
	NewUsers, Senders, Messages int64
	NewFeedback, OpenFeedback   int64
	NewReports                  int64
	ClientErrors                int64
	TopErrors                   []ClientErrorCount
}

// Stats counts day (Asia/Saigon). Every count reads an index by date (for
// messages, the id index: ids grow with time).
func (d *Digest) Stats(ctx context.Context, day time.Time) (*DigestStats, error) {
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, chat.Saigon)
	end := start.AddDate(0, 0, 1)
	s := &DigestStats{Day: day}
	tenant := d.cfg.TenantID
	err := d.cfg.Pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM users WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 AND NOT is_bot),
			(SELECT count(*) FROM feedback WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3),
			(SELECT count(*) FROM feedback WHERE tenant_id = $1 AND status = 'open'),
			(SELECT count(*) FROM reports WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3),
			(SELECT coalesce(sum(count), 0) FROM client_errors WHERE tenant_id = $1 AND day = $4)`,
		tenant, start, end, day).Scan(&s.NewUsers, &s.NewFeedback, &s.OpenFeedback, &s.NewReports, &s.ClientErrors)
	if err != nil {
		return nil, fmt.Errorf("watch: digest counts: %w", err)
	}
	if err := d.cfg.Pool.QueryRow(ctx, `
		SELECT count(*), count(DISTINCT m.from_id)
		FROM messages m JOIN chats c ON c.id = m.chat_id JOIN users u ON u.id = m.from_id
		WHERE m.id >= $2 AND m.id < $3 AND c.tenant_id = $1 AND NOT u.is_bot AND (m.text <> '' OR m.media_kind <> 0)`,
		tenant, ids.SnowflakeFloor(start), ids.SnowflakeFloor(end)).Scan(&s.Messages, &s.Senders); err != nil {
		return nil, fmt.Errorf("watch: digest messages: %w", err)
	}
	rows, err := d.cfg.Pool.Query(ctx, `
		SELECT kind, message, location, count FROM client_errors WHERE tenant_id = $1 AND day = $2
		ORDER BY count DESC, last_seen DESC LIMIT $3`, tenant, day, digestErrorsShown)
	if err != nil {
		return nil, fmt.Errorf("watch: digest client errors: %w", err)
	}
	s.TopErrors, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (ClientErrorCount, error) {
		var c ClientErrorCount
		var count int32
		err := r.Scan(&c.Kind, &c.Message, &c.Location, &count)
		c.Count = int64(count)
		return c, err
	})
	if err != nil {
		return nil, fmt.Errorf("watch: digest client errors: %w", err)
	}
	return s, nil
}

var clientErrorKindNames = map[string]string{"error": "lỗi", "rejection": "promise lỗi", "render": "lỗi giao diện"}

// DigestNotice is the digest message of s.
func DigestNotice(s *DigestStats) *Notice {
	date := s.Day.Format("02/01/2006")
	n := &Notice{Key: "digest:" + s.Day.Format(time.DateOnly)}
	count := func(v int64) string { return strconv.FormatInt(v, 10) }
	n.Bold("Bản tin ngày " + date).Write("\n")
	n.Write("Người dùng mới: ").Bold(count(s.NewUsers)).Write("\n")
	n.Write("Người gửi tin: ").Bold(count(s.Senders)).Write("\n")
	n.Write("Tin nhắn: ").Bold(count(s.Messages)).Write("\n")
	n.Write("Góp ý mới: ").Bold(count(s.NewFeedback)).Write(" (đang mở: " + count(s.OpenFeedback) + ")\n")
	n.Write("Báo cáo mới: ").Bold(count(s.NewReports)).Write("\n")
	n.Write("Lỗi phía trình duyệt: ").Bold(count(s.ClientErrors))
	for i, e := range s.TopErrors {
		n.Write(fmt.Sprintf("\n%d. ", i+1))
		if name := clientErrorKindNames[e.Kind]; name != "" {
			n.Write("[" + name + "] ")
		}
		n.Write(chat.Excerpt(e.Message, digestErrorMax))
		if e.Location != "" {
			n.Write(" (" + e.Location + ")")
		}
		n.Write(" ×" + count(e.Count))
	}
	return n
}

// Package botbulk sends a bot's bulk messages (POST /bot/v1/messages:bulk):
// one message to many users, each in the bot's private chat, only to users
// who started the bot (the core's consent invariant decides each send).
//
// A job is stored, then sent in the background by Run at the job's pace
// (messages per second, from the bot's tier). Each recipient's message has
// a random_id derived from the job and the user, so a job resumed after a
// crash never sends a user the message twice. A bot's recipients in the
// last 24 hours are capped by its tier (the caller passes the cap).
package botbulk

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"slices"
	"strconv"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"
)

const (
	// MaxRecipients bounds the user ids of one job.
	MaxRecipients = 10000
	// MaxActive bounds a bot's queued and running jobs.
	MaxActive = 5
	// Unlimited is the daily cap of a tier without one.
	Unlimited = -1

	lease    = 30 * time.Second
	tick     = time.Second
	sendTime = 10 * time.Second
	// Finished jobs (their recipient lists) are kept this long, then
	// deleted; cleanEvery rounds look for them.
	keepFinished = 30 * 24 * time.Hour
	cleanEvery   = 3600
)

// Job states.
const (
	StateQueued    = "queued"
	StateRunning   = "running"
	StateDone      = "done"
	StateCancelled = "cancelled"
)

// Reasons a job stopped before its last recipient.
const (
	ReasonCancelled  = "cancelled"
	ReasonBotDeleted = "bot_deleted"
	ReasonRestricted = "bot_restricted"
)

var (
	// ErrNoJob reports a job that does not exist or is another bot's.
	ErrNoJob = errors.New("botbulk: no such job")
	// ErrNoRecipients reports a job without a recipient.
	ErrNoRecipients = errors.New("botbulk: no recipients")
	// ErrTooManyActive reports MaxActive unfinished jobs.
	ErrTooManyActive = errors.New("botbulk: too many unfinished jobs")
)

// QuotaError reports a job over the bot's daily cap.
type QuotaError struct {
	Cap, Left int
}

func (e *QuotaError) Error() string {
	return fmt.Sprintf("botbulk: daily cap %d, %d recipients left", e.Cap, e.Left)
}

// Request is a job to queue: UserIDs, or All users who started the bot.
type Request struct {
	BotID   int64
	UserIDs []int64
	All     bool
	Message chat.BotMessage // ChatID, TopicID, ReplyTo and RandomID are not used
	// Pace is messages per second; Cap the recipients of the last 24
	// hours (Unlimited, or 0 for none at all).
	Pace int
	Cap  int
	// CreatedBy is the operator who queued an announcement; 0 for a bot.
	CreatedBy int64
}

// Job is a job's state.
type Job struct {
	ID         int64
	Text       string
	Content    []byte // entities and keyboard (app.v1.Message), may be empty
	CreatedBy  int64
	State      string
	Reason     string
	Total      int
	Sent       int
	Skipped    int
	Failed     int
	CreatedAt  time.Time
	FinishedAt *time.Time
}

// Service stores and sends the jobs of one tenant.
type Service struct {
	pool   *pgxpool.Pool
	chat   *chat.Service
	tenant string
	logger *slog.Logger
}

// New builds the service.
func New(pool *pgxpool.Pool, chatSvc *chat.Service, tenantID string, logger *slog.Logger) *Service {
	return &Service{pool: pool, chat: chatSvc, tenant: tenantID, logger: logger}
}

// Create checks req and queues it.
func (s *Service) Create(ctx context.Context, req Request) (*Job, error) {
	if req.Pace <= 0 {
		return nil, errors.New("botbulk: pace must be positive")
	}
	ids := uniqueIDs(req.UserIDs)
	if !req.All && len(ids) == 0 {
		return nil, ErrNoRecipients
	}
	if len(ids) > MaxRecipients {
		return nil, fmt.Errorf("botbulk: at most %d recipients", MaxRecipients)
	}
	text, ents, err := s.chat.CheckBotMessage(ctx, req.BotID, req.Message)
	if err != nil {
		return nil, err
	}
	var content []byte
	if c := (&appv1.Message{Entities: ents, ReplyMarkup: req.Message.Markup}); proto.Size(c) > 0 {
		if content, err = proto.Marshal(c); err != nil {
			return nil, fmt.Errorf("botbulk: encode message: %w", err)
		}
	}
	audience := "ids"
	if req.All {
		audience, ids = "all", []int64{}
	}
	var job *Job
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// One bot's jobs are created one at a time: the cap holds.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('botbulk'), $1::int)`, int32(req.BotID%(1<<31))); err != nil {
			return fmt.Errorf("botbulk: lock: %w", err)
		}
		var active, used int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE state IN ('queued', 'running')),
				coalesce(sum(CASE WHEN state = 'cancelled' THEN sent + skipped + failed ELSE total END)
					FILTER (WHERE created_at > now() - interval '24 hours'), 0)
			FROM bot_bulk_jobs WHERE bot_id = $1`, req.BotID).Scan(&active, &used); err != nil {
			return fmt.Errorf("botbulk: usage: %w", err)
		}
		if active >= MaxActive {
			return ErrTooManyActive
		}
		total := len(ids)
		if req.All {
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM bot_user_consent WHERE bot_id = $1`, req.BotID).Scan(&total); err != nil {
				return fmt.Errorf("botbulk: audience: %w", err)
			}
			if total == 0 {
				return ErrNoRecipients
			}
		}
		if req.Cap != Unlimited && used+total > req.Cap {
			return &QuotaError{Cap: req.Cap, Left: max(req.Cap-used, 0)}
		}
		job = &Job{State: StateQueued, Total: total, Text: text, Content: content, CreatedBy: req.CreatedBy}
		return tx.QueryRow(ctx, `
			INSERT INTO bot_bulk_jobs (tenant_id, bot_id, audience, user_ids, text, content, no_link_preview, pace, total, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at`,
			s.tenant, req.BotID, audience, ids, text, content, req.Message.NoLinkPreview, req.Pace, total, req.CreatedBy).
			Scan(&job.ID, &job.CreatedAt)
	})
	if err != nil {
		return nil, err
	}
	return job, nil
}

const jobColumns = `id, text, content, created_by, state, reason, total, sent, skipped, failed, created_at, finished_at`

func scanJob(row pgx.Row) (*Job, error) {
	j := &Job{}
	err := row.Scan(&j.ID, &j.Text, &j.Content, &j.CreatedBy, &j.State, &j.Reason, &j.Total, &j.Sent, &j.Skipped, &j.Failed,
		&j.CreatedAt, &j.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoJob
	}
	if err != nil {
		return nil, fmt.Errorf("botbulk: job: %w", err)
	}
	return j, nil
}

// Get returns a job of the bot.
func (s *Service) Get(ctx context.Context, botID, id int64) (*Job, error) {
	return scanJob(s.pool.QueryRow(ctx, `SELECT `+jobColumns+` FROM bot_bulk_jobs WHERE id = $1 AND bot_id = $2 AND tenant_id = $3`,
		id, botID, s.tenant))
}

// List returns the bot's newest jobs, at most limit.
func (s *Service) List(ctx context.Context, botID int64, limit int) ([]*Job, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+jobColumns+` FROM bot_bulk_jobs WHERE bot_id = $1 AND tenant_id = $2
		ORDER BY id DESC LIMIT $3`, botID, s.tenant, limit)
	if err != nil {
		return nil, fmt.Errorf("botbulk: list: %w", err)
	}
	defer rows.Close()
	var out []*Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("botbulk: list: %w", err)
	}
	return out, nil
}

// Audience counts the users who started the bot (the recipients of an
// "all" job queued now).
func (s *Service) Audience(ctx context.Context, botID int64) (int, error) {
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM bot_user_consent WHERE bot_id = $1`, botID).Scan(&n); err != nil {
		return 0, fmt.Errorf("botbulk: audience: %w", err)
	}
	return n, nil
}

// Cancel stops an unfinished job of the bot (a batch being sent finishes)
// and returns its state.
func (s *Service) Cancel(ctx context.Context, botID, id int64) (*Job, error) {
	if _, err := s.pool.Exec(ctx, `
		UPDATE bot_bulk_jobs SET state = 'cancelled', reason = $4, finished_at = now()
		WHERE id = $1 AND bot_id = $2 AND tenant_id = $3 AND state IN ('queued', 'running')`,
		id, botID, s.tenant, ReasonCancelled); err != nil {
		return nil, fmt.Errorf("botbulk: cancel: %w", err)
	}
	return s.Get(ctx, botID, id)
}

// Run sends the queued jobs until ctx ends: each round, every unfinished
// job sends up to its pace of recipients.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(tick)
	defer t.Stop()
	for n := 0; ; n++ {
		if err := s.Round(ctx); err != nil && ctx.Err() == nil {
			s.logger.Error("bulk send round failed", "err", err)
		}
		if n%cleanEvery == 0 {
			if err := s.Clean(ctx); err != nil && ctx.Err() == nil {
				s.logger.Warn("bulk job cleanup failed", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Clean deletes the jobs finished more than keepFinished ago.
func (s *Service) Clean(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM bot_bulk_jobs WHERE tenant_id = $1 AND finished_at < now() - $2::interval`,
		s.tenant, keepFinished.String()); err != nil {
		return fmt.Errorf("botbulk: clean: %w", err)
	}
	return nil
}

// Round gives every unfinished job one batch, at most one job per bot so
// that a bot's pace holds across its jobs (tests call it directly). A job
// whose batch fails is retried next round; the others still get theirs.
func (s *Service) Round(ctx context.Context) error {
	var after int64
	served := []int64{}
	var failed error
	for {
		j, err := s.claim(ctx, after, served)
		if err != nil {
			return errors.Join(failed, err)
		}
		if j == nil {
			return failed
		}
		after = j.id
		served = append(served, j.botID)
		if err := s.batch(ctx, j); err != nil {
			s.release(j)
			failed = errors.Join(failed, fmt.Errorf("job %d: %w", j.id, err))
		}
	}
}

// work is a claimed job.
type work struct {
	id            int64
	botID         int64
	all           bool
	text          string
	content       []byte
	noLinkPreview bool
	pace          int
	progress      int64
	lease         time.Time // the claim: only its holder records the batch
	botLive       bool
	restricted    bool
}

// claim leases the next unfinished job above after of a bot not served
// this round (several api processes of the tenant share the jobs).
func (s *Service) claim(ctx context.Context, after int64, served []int64) (*work, error) {
	j := &work{}
	var audience string
	err := s.pool.QueryRow(ctx, `
		UPDATE bot_bulk_jobs j SET state = 'running', lease_until = now() + $4::interval
		FROM (
			SELECT id FROM bot_bulk_jobs
			WHERE tenant_id = $1 AND id > $2 AND state IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < now())
				AND bot_id <> ALL($3)
			ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
		) next
		WHERE j.id = next.id
		RETURNING j.id, j.bot_id, j.audience, j.text, j.content, j.no_link_preview, j.pace, j.progress, j.lease_until,
			EXISTS (SELECT 1 FROM bots b WHERE b.user_id = j.bot_id AND b.deleted_at IS NULL),
			EXISTS (SELECT 1 FROM bots b WHERE b.user_id = j.bot_id AND b.restricted_at IS NOT NULL)`,
		s.tenant, after, served, lease.String()).
		Scan(&j.id, &j.botID, &audience, &j.text, &j.content, &j.noLinkPreview, &j.pace, &j.progress, &j.lease,
			&j.botLive, &j.restricted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("botbulk: claim: %w", err)
	}
	j.all = audience == "all"
	return j, nil
}

// release gives a job back after a failed batch, to be retried next round.
func (s *Service) release(j *work) {
	ctx, cancel := context.WithTimeout(context.Background(), sendTime)
	defer cancel()
	if _, err := s.pool.Exec(ctx, `UPDATE bot_bulk_jobs SET lease_until = NULL WHERE id = $1 AND lease_until = $2`, j.id, j.lease); err != nil {
		s.logger.Warn("releasing a bulk job failed", "job_id", j.id, "err", err)
	}
}

// recipient is one user of a batch and the job's progress once handled.
type recipient struct {
	user  int64
	after int64
}

// batch sends the job's next recipients, for at most half the lease, and
// records the outcome while the claim still holds. A rate limit or an
// unavailable core ends the batch before that user, who is retried next
// round. The job is held until the next second, so its pace holds whatever
// process takes it next.
func (s *Service) batch(ctx context.Context, j *work) error {
	switch {
	case !j.botLive:
		return s.stop(ctx, j.id, ReasonBotDeleted)
	case j.restricted:
		return s.stop(ctx, j.id, ReasonRestricted)
	}
	batch, err := s.recipients(ctx, j)
	if err != nil {
		return err
	}
	msg := chat.BotMessage{Text: j.text, NoLinkPreview: j.noLinkPreview}
	if len(j.content) > 0 {
		var c appv1.Message
		if err := proto.Unmarshal(j.content, &c); err != nil {
			return fmt.Errorf("botbulk: decode message: %w", err)
		}
		msg.Entities, msg.Markup = c.GetEntities(), c.GetReplyMarkup()
	}
	deadline := time.Now().Add(lease / 2)
	progress, handled := j.progress, 0
	var sent, skipped, failed int
send:
	for _, r := range batch {
		if time.Now().After(deadline) {
			break
		}
		switch s.sendOne(ctx, j, r.user, msg) {
		case outcomeSent:
			sent++
		case outcomeSkipped:
			skipped++
		case outcomeLater:
			break send
		default:
			failed++
		}
		progress, handled = r.after, handled+1
	}
	finished := handled == len(batch) && len(batch) < j.pace
	tag, err := s.pool.Exec(ctx, `
		UPDATE bot_bulk_jobs SET progress = $3, sent = sent + $4, skipped = skipped + $5, failed = failed + $6,
			lease_until = CASE WHEN $7 THEN NULL ELSE now() + $8::interval END,
			state = CASE WHEN state = 'cancelled' THEN state WHEN $7 THEN 'done' ELSE state END,
			finished_at = CASE WHEN $7 AND state <> 'cancelled' THEN now() ELSE finished_at END
		WHERE id = $1 AND lease_until = $2`, j.id, j.lease, progress, sent, skipped, failed, finished, tick.String())
	if err != nil {
		return fmt.Errorf("botbulk: record batch: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// The lease ran out and another process took the job: it resumes
		// from the recorded progress, and dedupe keeps these sends single.
		s.logger.Warn("bulk batch outlived its lease", "job_id", j.id)
	}
	return nil
}

// recipients returns the job's next batch.
func (s *Service) recipients(ctx context.Context, j *work) ([]recipient, error) {
	var out []recipient
	if !j.all {
		var ids []int64
		// Postgres arrays are 1-based: progress is the count handled.
		if err := s.pool.QueryRow(ctx, `SELECT coalesce(user_ids[$2 + 1:$2 + $3], '{}') FROM bot_bulk_jobs WHERE id = $1`,
			j.id, j.progress, j.pace).Scan(&ids); err != nil {
			return nil, fmt.Errorf("botbulk: recipients: %w", err)
		}
		for i, id := range ids {
			out = append(out, recipient{user: id, after: j.progress + int64(i) + 1})
		}
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT user_id FROM bot_user_consent WHERE bot_id = $1 AND user_id > $2 ORDER BY user_id LIMIT $3`,
		j.botID, j.progress, j.pace)
	if err != nil {
		return nil, fmt.Errorf("botbulk: audience: %w", err)
	}
	users, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("botbulk: audience: %w", err)
	}
	for _, u := range users {
		out = append(out, recipient{user: u, after: u})
	}
	return out, nil
}

func (s *Service) stop(ctx context.Context, id int64, reason string) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE bot_bulk_jobs SET state = 'cancelled', reason = $2, finished_at = now(), lease_until = NULL
		WHERE id = $1 AND state IN ('queued', 'running')`, id, reason); err != nil {
		return fmt.Errorf("botbulk: stop: %w", err)
	}
	return nil
}

type outcome int

const (
	outcomeSent outcome = iota
	outcomeSkipped
	outcomeFailed
	outcomeLater // rate limited or unavailable: retry next round
)

// sendOne sends the job's message to user in the bot's private chat. A
// user without that chat, consent or the right to receive it is skipped.
func (s *Service) sendOne(ctx context.Context, j *work, user int64, msg chat.BotMessage) outcome {
	ctx, cancel := context.WithTimeout(ctx, sendTime)
	defer cancel()
	chatID, err := s.chat.BotPrivateChat(ctx, j.botID, user)
	if err != nil {
		s.logger.Warn("bulk send failed", "job_id", j.id, "bot_id", j.botID, "err", err)
		return outcomeFailed
	}
	if chatID == 0 {
		return outcomeSkipped
	}
	msg.ChatID, msg.RandomID = chatID, randomID(j.id, user)
	_, err = s.chat.SendBotMessage(ctx, j.botID, msg)
	if err == nil {
		return outcomeSent
	}
	switch connect.CodeOf(err) {
	case connect.CodePermissionDenied, connect.CodeNotFound, connect.CodeFailedPrecondition:
		return outcomeSkipped
	case connect.CodeResourceExhausted, connect.CodeUnavailable:
		return outcomeLater
	default:
	}
	s.logger.Warn("bulk send failed", "job_id", j.id, "bot_id", j.botID, "err", err)
	return outcomeFailed
}

// randomID is the random_id of the job's message to user: below 2^53 (ADR
// 0001), the same on every retry.
func randomID(job, user int64) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte("bulk:" + strconv.FormatInt(job, 10) + ":" + strconv.FormatInt(user, 10)))
	return int64(h.Sum64()&(1<<53-1)) | 1 // never 0, which means no random_id
}

func uniqueIDs(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return slices.Compact(out)
}

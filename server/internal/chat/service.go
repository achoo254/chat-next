// Package chat is the messaging core: chats and members, messages, forum
// topics, invite links, privacy and blocks, and the sync logs of ADR 0002
// (per-user pts, per-chat chat_pts for sync_mode=large, server_epoch) with
// the outbox of ADR 0003.
//
// Every mutation runs in one transaction that also appends its updates to
// the logs and writes its outbox row; after commit the updates are rendered
// for each recipient and handed to the realtime Sink. Lock order inside a
// transaction is always: the chat row, then chat_members rows (sorted by
// user id), then user_state rows (sorted by user id, one statement), so
// chats with shared members never deadlock.
package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/ratelimit"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config holds the limits of the messaging core. Zero values take the
// defaults of DefaultConfig.
type Config struct {
	TenantID string
	// PublicOrigin is the web origin invite links point at.
	PublicOrigin string
	// AppScheme is the app's own URL scheme allowed in links (ADR 0004).
	AppScheme string
	// LargeChatThreshold: a chat switches to sync_mode=large when its member
	// count goes above it (ADR 0002).
	LargeChatThreshold int
	// MessageLengthMax counts code points (AppConfig.message_length_max).
	MessageLengthMax int
	EditTimeLimit    time.Duration
	// Read receipts per member: groups up to this size, messages this young.
	ReadReceiptsMemberMax int
	ReadReceiptsMaxAge    time.Duration
	// LogRetentionDays is how long update logs and the outbox are kept.
	LogRetentionDays int
}

// DefaultConfig returns the stage 1 limits; they match rpc.newAppConfig.
func DefaultConfig() Config {
	return Config{
		LargeChatThreshold:    200,
		MessageLengthMax:      4096,
		EditTimeLimit:         48 * time.Hour,
		ReadReceiptsMemberMax: 100,
		ReadReceiptsMaxAge:    7 * 24 * time.Hour,
		LogRetentionDays:      30,
	}
}

// IDSource issues Snowflake message keys.
type IDSource interface {
	Next() (int64, error)
}

// Presence reports whether a user has a foreground realtime session.
type Presence interface {
	Online(userID int64) bool
}

// Sink receives rendered realtime frames (the gateway hub).
type Sink interface {
	// SendUser delivers a frame to every socket of the user.
	SendUser(userID int64, frame *appv1.ServerFrame)
	// ChatViewers lists users with a socket that has the large chat open or
	// visible.
	ChatViewers(chatID int64) []int64
	// SendChatViewers delivers a frame to the user's sockets that have the
	// chat open or visible.
	SendChatViewer(userID, chatID int64, frame *appv1.ServerFrame)
	// ChatActivity reports news in a large chat's log; the sink sends a
	// coalesced chat_activity hint to members not viewing it.
	ChatActivity(chatID, chatPts, topSeq int64)
	// RevokeSession closes the session's sockets with SessionRevokedFrame.
	RevokeSession(sessionID int64, reason appv1.SessionRevokeReason)
	// ForgetChat drops the chat from the user's sockets (open chat, visible
	// set) after the user left it.
	ForgetChat(userID, chatID int64)
	// ResyncAll asks every socket to reconnect and catch up.
	ResyncAll(reason appv1.ResyncReason)
}

// Service implements the messaging core for one tenant.
type Service struct {
	pool     *pgxpool.Pool
	cfg      Config
	ids      IDSource
	previews *linkpreview.Service
	limiter  ratelimit.Limiter
	logger   *slog.Logger

	mu       sync.RWMutex
	sink     Sink
	presence Presence
	epoch    int64
	// previewSlots bounds the link preview fetches running after sends.
	previewSlots chan struct{}

	dispatch *dispatcher
	// background tracks goroutines Stop must wait for; stopCtx ends them.
	background sync.WaitGroup
	stopCtx    context.Context
	stopAll    context.CancelFunc
}

// Deps are the collaborators of the Service.
type Deps struct {
	Pool     *pgxpool.Pool
	IDs      IDSource
	Previews *linkpreview.Service
	Limiter  ratelimit.Limiter
	Logger   *slog.Logger
}

// New returns the Service; call Start before serving.
func New(cfg Config, d Deps) (*Service, error) {
	def := DefaultConfig()
	if cfg.TenantID == "" {
		return nil, errors.New("chat: TenantID is required")
	}
	if cfg.LargeChatThreshold <= 0 {
		cfg.LargeChatThreshold = def.LargeChatThreshold
	}
	if cfg.MessageLengthMax <= 0 {
		cfg.MessageLengthMax = def.MessageLengthMax
	}
	if cfg.EditTimeLimit <= 0 {
		cfg.EditTimeLimit = def.EditTimeLimit
	}
	if cfg.ReadReceiptsMemberMax <= 0 {
		cfg.ReadReceiptsMemberMax = def.ReadReceiptsMemberMax
	}
	if cfg.ReadReceiptsMaxAge <= 0 {
		cfg.ReadReceiptsMaxAge = def.ReadReceiptsMaxAge
	}
	if cfg.LogRetentionDays <= 0 {
		cfg.LogRetentionDays = def.LogRetentionDays
	}
	if d.Pool == nil || d.IDs == nil || d.Previews == nil || d.Limiter == nil || d.Logger == nil {
		return nil, errors.New("chat: missing dependency")
	}
	s := &Service{
		pool: d.Pool, cfg: cfg, ids: d.IDs, previews: d.Previews, limiter: d.Limiter, logger: d.Logger,
	}
	s.stopCtx, s.stopAll = context.WithCancel(context.Background())
	s.dispatch = newDispatcher(s)
	return s, nil
}

// Config returns the effective configuration.
func (s *Service) Config() Config {
	return s.cfg
}

// SetRealtime connects the gateway; until then deliveries are dropped and
// clients rely on GetDifference.
func (s *Service) SetRealtime(sink Sink, presence Presence) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
	s.presence = presence
}

func (s *Service) realtime() (Sink, Presence) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sink, s.presence
}

// Epoch returns the cached server_epoch.
func (s *Service) Epoch() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.epoch
}

// LoadEpoch reads server_epoch; when it changed since the last read every
// socket is asked to resync.
func (s *Service) LoadEpoch(ctx context.Context) error {
	var epoch int64
	if err := s.pool.QueryRow(ctx, `SELECT server_epoch FROM server_meta`).Scan(&epoch); err != nil {
		return fmt.Errorf("chat: read server epoch: %w", err)
	}
	s.mu.Lock()
	changed := s.epoch != 0 && s.epoch != epoch
	s.epoch = epoch
	sink := s.sink
	s.mu.Unlock()
	if changed {
		s.logger.Warn("server epoch changed; asking every client to resync", "epoch", epoch)
		if sink != nil {
			sink.ResyncAll(appv1.ResyncReason_RESYNC_REASON_EPOCH_CHANGED)
		}
	}
	return nil
}

// Start loads the epoch and starts the dispatcher; Run* loops are started
// by the caller. Stop drains the dispatcher.
func (s *Service) Start(ctx context.Context) error {
	if err := s.LoadEpoch(ctx); err != nil {
		return err
	}
	if err := s.EnsurePartitions(ctx); err != nil {
		return err
	}
	s.dispatch.start()
	return nil
}

// Stop cancels background link preview fetches, waits for them and drains
// queued deliveries.
func (s *Service) Stop() {
	s.stopAll()
	s.background.Wait()
	s.dispatch.stop()
}

// ----------------------------------------------------------------- errors

func errInvalid(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

func errNotFound(what string) error {
	return connect.NewError(connect.CodeNotFound, fmt.Errorf("%s not found", what))
}

func errDenied(format string, args ...any) error {
	return connect.NewError(connect.CodePermissionDenied, fmt.Errorf(format, args...))
}

func errPrecondition(format string, args ...any) error {
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(format, args...))
}

func errRateLimited() error {
	return connect.NewError(connect.CodeResourceExhausted, errors.New("too many requests; slow down"))
}

// ----------------------------------------------------------- rate limits

// Rate limit rules per user (stage 1 values, tuned in load tests).
var (
	limitSend    = ratelimit.Rule{Rate: 5, Burst: 30}
	limitWrite   = ratelimit.Rule{Rate: 5, Burst: 30}
	limitCreate  = ratelimit.Rule{Rate: 1.0 / 6, Burst: 10}
	limitJoin    = ratelimit.Rule{Rate: 1.0 / 5, Burst: 10}
	limitReport  = ratelimit.Rule{Rate: 1.0 / 360, Burst: 10}
	limitPreview = ratelimit.Rule{Rate: 1, Burst: 20}
	limitSearch  = ratelimit.Rule{Rate: 1, Burst: 20}
)

func (s *Service) allow(rule ratelimit.Rule, bucket string, userID int64) error {
	if !s.limiter.Allow(rule, fmt.Sprintf("%s:%d", bucket, userID)) {
		return errRateLimited()
	}
	return nil
}

// ------------------------------------------------------------ transactions

// querier is a pool or a transaction.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// inTx runs fn in a transaction; on commit the collected events go to the
// dispatcher. A serialization or deadlock failure is retried a few times.
// The returned txn carries the caller's log positions (txn.ack).
func (s *Service) inTx(ctx context.Context, fn func(t *txn) error) (*txn, error) {
	const attempts = 3
	var err error
	for range attempts {
		var t *txn
		err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			t = &txn{tx: tx, s: s, epoch: s.Epoch()}
			if err := fn(t); err != nil {
				return err
			}
			return t.flush(ctx)
		})
		if err == nil {
			for _, ev := range t.events {
				s.dispatch.enqueue(ev)
			}
			return t, nil
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || (pgErr.Code != "40P01" && pgErr.Code != "40001") {
			return nil, err
		}
		s.logger.Warn("transaction retried", "code", pgErr.Code)
	}
	return nil, err
}

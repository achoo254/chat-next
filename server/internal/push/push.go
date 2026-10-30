// Package push notifies devices of new messages while the app is closed
// (ADR 0003 consumer "push"). Browsers register a Web Push subscription
// for their chat session (PushService); the consumer reads the outbox with
// its own cursor, asks the chat core which subscriptions a new message
// concerns (members other than the sender, chat not muted, notifications on
// for the chat type, sender not blocked, session still usable) and sends
// each an encrypted message (package webpush) unless the user is using the
// app in the foreground somewhere right now: the open app shows the
// message itself, and the web client leaves notifications of a background
// tab to the push when this device has one.
//
// What a notification says follows the user's "Hiện nội dung tin" setting
// for the chat type: with it, the chat (or sender) name and the message
// text; without it only the app name and "Bạn có tin nhắn mới", so neither
// the push service (which only sees ciphertext anyway) nor someone
// glancing at the screen learns more.
//
// Delivery is best effort and at most a few seconds behind the commit:
// commits kick the consumer, sends run on a bounded worker pool, messages
// older than staleAfter are not pushed (a restart after a long outage does
// not ring every phone), and push services keep a message for messageTTL
// with one pending message per chat (Topic). A subscription the push
// service reports gone (404, 410) is deleted; one rejected maxFailures
// times in a row too. Revoking a session deletes its subscription (a
// trigger on user_sessions).
package push

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"app.local/server/internal/chat"
	"app.local/server/internal/webpush"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Locales of the notification text.
const (
	LocaleVI   = "vi"
	LocaleEN   = "en"
	LocaleZhCN = "zh-CN"
)

// ErrDisabled is returned by Register when the server has no VAPID key.
var ErrDisabled = errors.New("web_push_disabled: Web Push is not configured on this server")

// ErrInvalid is returned by Register for a malformed subscription.
var ErrInvalid = errors.New("push: invalid subscription")

// Presence tells whether a user has the app in the foreground on some
// device (the realtime gateway's hub).
type Presence interface {
	Online(userID int64) bool
}

// Config configures New.
type Config struct {
	TenantID string
	// AppName titles notifications that hide the message (brand
	// pushSenderName).
	AppName string
	// Sender sends the messages; nil turns Web Push off (Config reports no
	// key, Register fails with ErrDisabled, the consumer does not run).
	Sender *webpush.Sender
	// SessionIdleTimeout and SessionMaxAge: subscriptions of sessions past
	// either are not sent to (store.SessionIdleTimeout, SessionMaxAge).
	SessionIdleTimeout time.Duration
	SessionMaxAge      time.Duration
}

// Service is the push registration and the consumer of one api process.
type Service struct {
	pool     *pgxpool.Pool
	chat     *chat.Service
	presence Presence
	cfg      Config
	logger   *slog.Logger
	kick     chan struct{}
	now      func() time.Time

	// Consumer state, used by one pass at a time (passMu).
	passMu  sync.Mutex
	loaded  bool
	low     int64
	high    int64
	pending map[int64]time.Time

	queue *deliveries
}

// New returns the Service; run Run in the background and call Kick after
// commits of the chat core.
func New(pool *pgxpool.Pool, chatSvc *chat.Service, presence Presence, cfg Config, logger *slog.Logger) (*Service, error) {
	if pool == nil || chatSvc == nil || presence == nil || logger == nil {
		return nil, errors.New("push: missing dependency")
	}
	if cfg.AppName == "" || cfg.TenantID == "" || cfg.SessionIdleTimeout <= 0 || cfg.SessionMaxAge <= 0 {
		return nil, errors.New("push: incomplete configuration")
	}
	s := &Service{
		pool: pool, chat: chatSvc, presence: presence, cfg: cfg, logger: logger, kick: make(chan struct{}, 1),
		now: time.Now, pending: map[int64]time.Time{},
	}
	if cfg.Sender != nil {
		s.queue = newDeliveries(s)
	}
	return s, nil
}

// Enabled reports whether Web Push is configured.
func (s *Service) Enabled() bool {
	return s.cfg.Sender != nil
}

// Kick asks the consumer to run now; it never blocks.
func (s *Service) Kick() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// WebPushConfig returns the application server key (nil when Web Push is
// off) and the endpoint the session registered ("" when none).
func (s *Service) WebPushConfig(ctx context.Context, sessionID int64) ([]byte, string, error) {
	if s.cfg.Sender == nil {
		return nil, "", nil
	}
	var endpoint string
	err := s.pool.QueryRow(ctx, `
		SELECT coalesce((SELECT endpoint FROM push_subscriptions WHERE session_id = $1 AND tenant_id = $2), '')`,
		sessionID, s.cfg.TenantID).Scan(&endpoint)
	if err != nil {
		return nil, "", fmt.Errorf("push: read registration: %w", err)
	}
	return s.cfg.Sender.PublicKey(), endpoint, nil
}

// Subscription is a browser's push subscription.
type Subscription struct {
	Endpoint string
	Keys     webpush.Keys
	// Locale is LocaleVI, LocaleEN, LocaleZhCN, or "" to keep the current
	// one.
	Locale string
}

// Register stores sub as the session's subscription, replacing the
// session's earlier one and any registration of the same endpoint (the
// browser signed in again with a new session).
func (s *Service) Register(ctx context.Context, userID, sessionID int64, sub Subscription) error {
	if s.cfg.Sender == nil {
		return ErrDisabled
	}
	if _, err := webpush.CheckEndpoint(sub.Endpoint, s.allowLocal()); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if err := sub.Keys.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	switch sub.Locale {
	case "", LocaleVI, LocaleEN, LocaleZhCN:
	default:
		return fmt.Errorf("%w: locale must be vi, en or zh-CN", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("push: register: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	locale := sub.Locale
	if locale == "" {
		if err := tx.QueryRow(ctx, `
			SELECT coalesce((SELECT locale FROM push_subscriptions WHERE session_id = $1 OR endpoint = $2
				ORDER BY session_id = $1 DESC LIMIT 1), $3)`, sessionID, sub.Endpoint, LocaleVI).Scan(&locale); err != nil {
			return fmt.Errorf("push: register: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE session_id = $1 OR endpoint = $2`, sessionID, sub.Endpoint); err != nil {
		return fmt.Errorf("push: register: %w", err)
	}
	// The session must be live and the caller's: a revoked session's
	// trigger would not delete a row inserted after it ran.
	tag, err := tx.Exec(ctx, `
		INSERT INTO push_subscriptions (tenant_id, user_id, session_id, endpoint, p256dh, auth, locale)
		SELECT $1, $2, $3, $4, $5, $6, $7 FROM user_sessions
		WHERE id = $3 AND user_id = $2 AND tenant_id = $1 AND revoked_at IS NULL
		FOR SHARE`,
		s.cfg.TenantID, userID, sessionID, sub.Endpoint, sub.Keys.P256DH, sub.Keys.Auth, locale)
	if err != nil {
		return fmt.Errorf("push: register: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("%w: the session ended", ErrInvalid)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("push: register: %w", err)
	}
	return nil
}

// Unregister removes the session's subscription.
func (s *Service) Unregister(ctx context.Context, sessionID int64) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE session_id = $1 AND tenant_id = $2`,
		sessionID, s.cfg.TenantID); err != nil {
		return fmt.Errorf("push: unregister: %w", err)
	}
	return nil
}

func (s *Service) allowLocal() bool {
	return s.cfg.Sender != nil && s.cfg.Sender.AllowLocal()
}

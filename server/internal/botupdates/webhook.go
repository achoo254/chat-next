package botupdates

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"time"

	"app.local/server/internal/chat"
	"app.local/server/internal/safehttp"
	"app.local/server/internal/sealbox"
	"github.com/jackc/pgx/v5"
)

// Webhook limits.
const (
	// MaxConnectionsDefault is the parallel requests of a webhook when the
	// bot does not choose.
	MaxConnectionsDefault = 40
	MaxConnectionsMax     = 100
	// MaxAttempts is how many times an update is tried before it is
	// dead-lettered.
	MaxAttempts = 10
	// DeadLettersListed bounds ListDeadLetters.
	DeadLettersListed = 100
	// checkURLTimeout bounds the name resolution when a webhook is saved.
	checkURLTimeout = 5 * time.Second
	secretMax       = 256
)

// UpdateKinds are the update kinds a bot can receive, in the order the
// Console lists them.
var UpdateKinds = []string{chat.BotUpdateMessage, chat.BotUpdateMessageEdited, chat.BotUpdateChannelPost, chat.BotUpdateCallback}

var secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)

// WebhookError is a refused webhook setting. Code is stable for clients:
// url_invalid, url_blocked, url_unresolved, secret_invalid,
// secret_required, allowed_updates_invalid, max_connections_invalid.
type WebhookError struct {
	Code        string
	Description string
}

func (e *WebhookError) Error() string { return e.Code + ": " + e.Description }

// ErrNoBot is a bot that does not exist or is deleted.
var ErrNoBot = errors.New("botupdates: no such bot")

// ReplyFunc runs the method a webhook answered with (the body of a 2xx
// answer), as the bot. randomID is derived from (bot_id, update_id), so
// running the same answer twice sends at most one message.
type ReplyFunc func(ctx context.Context, botID int64, randomID int64, body []byte) error

// WebhookOptions enable webhook delivery.
type WebhookOptions struct {
	// TenantID: only bots of this tenant are dispatched by this process.
	TenantID string
	// SessionKey seals the webhook secrets at rest.
	SessionKey []byte
	// Local allows http URLs, loopback addresses and any port (development
	// and end-to-end tests only).
	Local bool
	// Reply runs actions in webhook answers; nil ignores them. SetReply
	// sets it later.
	Reply ReplyFunc
	// Timeout bounds one request; safehttp.DefaultTimeout (10 s) when zero.
	Timeout time.Duration
	// HTTP replaces the outbound client (tests).
	HTTP *safehttp.Client
}

// EnableWebhooks turns on webhook settings and delivery; call it before Run.
func (s *Service) EnableWebhooks(o WebhookOptions) error {
	if o.TenantID == "" {
		return errors.New("botupdates: webhooks need the tenant id")
	}
	box, err := sealbox.New(o.SessionKey, "bot-webhook-secret")
	if err != nil {
		return fmt.Errorf("botupdates: webhook secrets: %w", err)
	}
	client := o.HTTP
	if client == nil {
		client = safehttp.New(safehttp.Options{Timeout: o.Timeout, Development: o.Local})
	}
	s.box = box
	s.webhooks = newDispatcher(s, o.TenantID, client, s.logger.With("part", "webhook"))
	s.webhooks.setReply(o.Reply)
	return nil
}

// SetReply sets the runner of webhook answer actions.
func (s *Service) SetReply(fn ReplyFunc) {
	if s.webhooks != nil {
		s.webhooks.setReply(fn)
	}
}

func (s *Service) requireWebhooks() error {
	if s.webhooks == nil {
		return errors.New("botupdates: webhooks are not enabled")
	}
	return nil
}

// WebhookSettings are what a bot or its owner sets.
type WebhookSettings struct {
	URL string
	// Secret is sent in a header and keys the HMAC signature. Empty keeps
	// the current secret (only when a webhook is set).
	Secret string
	// AllowedUpdates limits the kinds stored for the bot; empty is every
	// kind.
	AllowedUpdates []string
	// MaxConnections is 1 to 100; 0 is MaxConnectionsDefault.
	MaxConnections int
	// DropPending acknowledges every pending update without delivering it.
	DropPending bool
}

func secretAAD(botID int64) []byte {
	return binary.BigEndian.AppendUint64([]byte("bot:"), uint64(botID))
}

// checkSettings validates w and returns the URL and allowed kinds to store.
func (s *Service) checkSettings(ctx context.Context, w *WebhookSettings) error {
	if w.MaxConnections == 0 {
		w.MaxConnections = MaxConnectionsDefault
	}
	if w.MaxConnections < 1 || w.MaxConnections > MaxConnectionsMax {
		return &WebhookError{"max_connections_invalid", fmt.Sprintf("max_connections must be from 1 to %d", MaxConnectionsMax)}
	}
	if w.Secret != "" && !secretPattern.MatchString(w.Secret) {
		return &WebhookError{"secret_invalid", fmt.Sprintf("secret must have 1 to %d characters of A-Z, a-z, 0-9, _ and -", secretMax)}
	}
	var kinds []string
	for _, k := range w.AllowedUpdates {
		if !slices.Contains(UpdateKinds, k) {
			return &WebhookError{"allowed_updates_invalid", fmt.Sprintf("unknown update kind %q (known: %s)", k, strings.Join(UpdateKinds, ", "))}
		}
		if !slices.Contains(kinds, k) {
			kinds = append(kinds, k)
		}
	}
	w.AllowedUpdates = kinds
	ctx, cancel := context.WithTimeout(ctx, checkURLTimeout)
	defer cancel()
	u, err := s.webhooks.client.CheckURL(ctx, strings.TrimSpace(w.URL))
	var dnsErr *safehttp.DNSError
	switch {
	case errors.Is(err, safehttp.ErrBlocked):
		return &WebhookError{"url_blocked", "the url points to a private, local or reserved address"}
	case errors.As(err, &dnsErr):
		return &WebhookError{"url_unresolved", "the url's host name does not resolve"}
	case err != nil:
		return &WebhookError{"url_invalid", strings.TrimPrefix(err.Error(), safehttp.ErrURL.Error()+": ")}
	}
	w.URL = u.String()
	return nil
}

// SetWebhook sets the bot's webhook: updates are POSTed to it from now on,
// a waiting long poll ends with ErrConflict and further polls are refused.
func (s *Service) SetWebhook(ctx context.Context, botID int64, w WebhookSettings) error {
	if err := s.requireWebhooks(); err != nil {
		return err
	}
	if err := s.checkSettings(ctx, &w); err != nil {
		return err
	}
	var sealed []byte
	if w.Secret != "" {
		sealed = s.box.Seal([]byte(w.Secret), secretAAD(botID))
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var hasSecret bool
		err := tx.QueryRow(ctx, `SELECT webhook_secret IS NOT NULL FROM bots WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE`,
			botID).Scan(&hasSecret)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNoBot
		}
		if err != nil {
			return fmt.Errorf("botupdates: load webhook: %w", err)
		}
		if sealed == nil && !hasSecret {
			return &WebhookError{"secret_required", "a secret is required"}
		}
		kinds := w.AllowedUpdates
		if kinds == nil {
			kinds = []string{}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bots SET webhook_url = $2, webhook_secret = coalesce($3, webhook_secret), webhook_max_connections = $4,
				allowed_updates = $5, webhook_set_at = now(), updated_at = now()
			WHERE user_id = $1`, botID, w.URL, sealed, w.MaxConnections, kinds); err != nil {
			return fmt.Errorf("botupdates: set webhook: %w", err)
		}
		return dropPending(ctx, tx, botID, w.DropPending)
	})
	if err != nil {
		return err
	}
	s.endPoll(botID)
	s.webhooks.changed(botID, true)
	s.logger.Info("bot webhook set", "bot_id", botID, "max_connections", w.MaxConnections, "drop_pending", w.DropPending)
	return nil
}

// DeleteWebhook removes the bot's webhook; pending updates stay for long
// poll unless dropPending. Deleting a missing webhook is not an error.
func (s *Service) DeleteWebhook(ctx context.Context, botID int64, drop bool) error {
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE bots SET webhook_url = NULL, webhook_secret = NULL, webhook_max_connections = $2, allowed_updates = '{}',
				webhook_set_at = NULL, updated_at = now()
			WHERE user_id = $1 AND deleted_at IS NULL`, botID, MaxConnectionsDefault)
		if err != nil {
			return fmt.Errorf("botupdates: delete webhook: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNoBot
		}
		return dropPending(ctx, tx, botID, drop)
	})
	if err != nil {
		return err
	}
	if s.webhooks != nil {
		s.webhooks.changed(botID, false)
	}
	return nil
}

func dropPending(ctx context.Context, tx pgx.Tx, botID int64, drop bool) error {
	if !drop {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE bot_updates SET acked = true WHERE bot_id = $1 AND NOT acked AND dead_at IS NULL`, botID); err != nil {
		return fmt.Errorf("botupdates: drop pending updates: %w", err)
	}
	return nil
}

// WebhookInfo is the delivery state of a bot.
type WebhookInfo struct {
	// URL is "" when the bot polls.
	URL            string
	MaxConnections int
	AllowedUpdates []string
	// Pending updates (not delivered, not dead-lettered, not expired).
	Pending     int64
	DeadLetters int64
	// LastError is a failure code (http_502, timeout, tls, connect, dns,
	// blocked_address, secret_unreadable) of the newest failed attempt.
	LastError       string
	LastErrorAt     time.Time
	LastDeliveredAt time.Time
	LastDelivery    time.Duration
	// OpenConnections are the requests in flight now.
	OpenConnections int
}

// WebhookInfo returns the bot's webhook and delivery state.
func (s *Service) WebhookInfo(ctx context.Context, botID int64) (*WebhookInfo, error) {
	info := &WebhookInfo{}
	var url, lastError *string
	var lastErrorAt, lastDeliveredAt *time.Time
	var lastMs *int32
	err := s.pool.QueryRow(ctx, `
		SELECT b.webhook_url, b.webhook_max_connections, b.allowed_updates,
			(SELECT count(*) FROM bot_updates u WHERE u.bot_id = b.user_id AND NOT u.acked AND u.dead_at IS NULL AND u.expires_at > now()),
			(SELECT count(*) FROM bot_updates u WHERE u.bot_id = b.user_id AND NOT u.acked AND u.dead_at IS NOT NULL AND u.expires_at > now()),
			e.last_error, e.last_error_at, d.last_delivered_at, d.last_delivery_ms
		FROM bots b
		LEFT JOIN LATERAL (SELECT last_error, last_error_at FROM bot_delivery_counters
			WHERE bot_id = b.user_id AND last_error_at IS NOT NULL ORDER BY hour DESC LIMIT 1) e ON true
		LEFT JOIN LATERAL (SELECT last_delivered_at, last_delivery_ms FROM bot_delivery_counters
			WHERE bot_id = b.user_id AND last_delivered_at IS NOT NULL ORDER BY hour DESC LIMIT 1) d ON true
		WHERE b.user_id = $1 AND b.deleted_at IS NULL`, botID).Scan(
		&url, &info.MaxConnections, &info.AllowedUpdates, &info.Pending, &info.DeadLetters,
		&lastError, &lastErrorAt, &lastDeliveredAt, &lastMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoBot
	}
	if err != nil {
		return nil, fmt.Errorf("botupdates: webhook info: %w", err)
	}
	if url != nil {
		info.URL = *url
	}
	if lastError != nil && lastErrorAt != nil {
		info.LastError, info.LastErrorAt = *lastError, *lastErrorAt
	}
	if lastDeliveredAt != nil {
		info.LastDeliveredAt = *lastDeliveredAt
		if lastMs != nil {
			info.LastDelivery = time.Duration(*lastMs) * time.Millisecond
		}
	}
	if s.webhooks != nil {
		info.OpenConnections = s.webhooks.open(botID)
	}
	return info, nil
}

// DeadLetter is an update given up after MaxAttempts.
type DeadLetter struct {
	UpdateID int64
	Kind     string
	ChatID   int64
	// ChatTitle names the chat as the bot sees it (the user's name for a
	// private chat).
	ChatTitle   string
	Attempts    int
	LastError   string
	LastErrorAt time.Time
	DeadAt      time.Time
}

// DeadLetters returns the newest dead letters of the bot (at most
// DeadLettersListed) and how many there are.
func (s *Service) DeadLetters(ctx context.Context, botID int64) ([]DeadLetter, int64, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT update_id, kind, chat_id, payload, attempts, coalesce(last_error, ''), coalesce(last_error_at, dead_at), dead_at,
			count(*) OVER ()
		FROM bot_updates WHERE bot_id = $1 AND dead_at IS NOT NULL AND NOT acked AND expires_at > now()
		ORDER BY dead_at DESC, update_id DESC LIMIT $2`, botID, DeadLettersListed)
	if err != nil {
		return nil, 0, fmt.Errorf("botupdates: dead letters: %w", err)
	}
	var total int64
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (DeadLetter, error) {
		var d DeadLetter
		var payload []byte
		var attempts int16
		if err := r.Scan(&d.UpdateID, &d.Kind, &d.ChatID, &payload, &attempts, &d.LastError, &d.LastErrorAt, &d.DeadAt, &total); err != nil {
			return d, err
		}
		d.Attempts = int(attempts)
		d.ChatTitle = chatTitle(d.Kind, payload)
		return d, nil
	})
	if err != nil {
		return nil, 0, fmt.Errorf("botupdates: dead letters: %w", err)
	}
	return list, total, nil
}

// chatTitle reads the chat's name out of a stored update.
func chatTitle(kind string, payload []byte) string {
	type chatJSON struct {
		Title string `json:"title"`
		User  *struct {
			Name string `json:"name"`
		} `json:"user"`
	}
	var v struct {
		Chat    chatJSON `json:"chat"`
		Message struct {
			Chat chatJSON `json:"chat"`
		} `json:"message"`
	}
	if json.Unmarshal(payload, &v) != nil {
		return ""
	}
	c := v.Chat
	if kind == chat.BotUpdateCallback {
		c = v.Message.Chat
	}
	if c.Title == "" && c.User != nil {
		return c.User.Name
	}
	return c.Title
}

// RetryDeadLetters gives the listed dead letters one more attempt each (a
// failure dead-letters them again) and returns how many were found.
func (s *Service) RetryDeadLetters(ctx context.Context, botID int64, ids []int64) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE bot_updates SET dead_at = NULL, attempts = $3, next_attempt_at = NULL
		WHERE bot_id = $1 AND update_id = ANY($2) AND dead_at IS NOT NULL AND NOT acked AND expires_at > now()`,
		botID, ids, MaxAttempts-1)
	if err != nil {
		return 0, fmt.Errorf("botupdates: retry dead letters: %w", err)
	}
	if tag.RowsAffected() > 0 {
		s.notify(botID)
	}
	return tag.RowsAffected(), nil
}

// DiscardDeadLetters drops the listed dead letters and returns how many
// were found.
func (s *Service) DiscardDeadLetters(ctx context.Context, botID int64, ids []int64) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE bot_updates SET acked = true WHERE bot_id = $1 AND update_id = ANY($2) AND dead_at IS NOT NULL AND NOT acked`,
		botID, ids)
	if err != nil {
		return 0, fmt.Errorf("botupdates: discard dead letters: %w", err)
	}
	return tag.RowsAffected(), nil
}

// Stats are a bot's delivery counters over a period.
type Stats struct {
	Received, Delivered, Failed, DeadLettered int64
}

// StatsWindow is the period Stats covers.
const StatsWindow = 24 * time.Hour

// Stats sums the bot's counters of the last StatsWindow (whole hours,
// including the current one).
func (s *Service) Stats(ctx context.Context, botID int64) (Stats, error) {
	var st Stats
	err := s.pool.QueryRow(ctx, `
		SELECT coalesce(sum(received), 0), coalesce(sum(delivered), 0), coalesce(sum(failed), 0), coalesce(sum(dead_lettered), 0)
		FROM bot_delivery_counters WHERE bot_id = $1 AND hour > date_trunc('hour', now()) - make_interval(secs => $2)`,
		botID, StatsWindow.Seconds()).Scan(&st.Received, &st.Delivered, &st.Failed, &st.DeadLettered)
	if err != nil {
		return Stats{}, fmt.Errorf("botupdates: stats: %w", err)
	}
	return st, nil
}

// logAttrs keeps log lines of one bot's delivery together.
func logAttrs(botID, updateID int64) []any {
	return []any{slog.Int64("bot_id", botID), slog.Int64("update_id", updateID)}
}

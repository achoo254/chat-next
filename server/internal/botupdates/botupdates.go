// Package botupdates delivers updates to bots (ADR 0003 consumer "bots").
//
// The consumer reads the outbox with its own cursor (outbox_cursors), asks
// the chat core which rows concern a bot (chat.BotUpdates: messages of
// private chats and groups the bot is in, privacy mode applied, presses of
// its buttons), serializes each update for the bot (package wire) and
// stores it in bot_updates under the bot's next update_id. update_id is
// issued under the bots row lock, so each bot has exactly one writer and
// its ids strictly increase; (bot_id, outbox_id, kind, seq) is unique and
// acknowledged updates stay as tombstones until they expire, so an outbox
// row replayed after a crash, a restart or by another process is a no-op
// even when the bot already acknowledged its updates. A row the core cannot
// turn into updates (corrupt or unknown log entry) is retried a few passes,
// then logged and skipped so it never stalls the other bots.
// Commits of the chat core kick the consumer right away (the after-commit
// path); a slow tick picks up gaps and rows written elsewhere.
//
// Bots fetch updates by long poll (Poll) or get them POSTed to their
// webhook (webhook.go, dispatch.go). A newer poll of the same bot ends the
// older one with ErrConflict, and so does setting a webhook; a poll while a
// webhook is set fails with ErrConflict. Waiting is woken in process when
// updates are stored, with a periodic recheck of the database, which stays
// the source of truth. Updates are kept 24 hours (callbacks 15 minutes); a
// poll with a higher offset acknowledges them, a 2xx answer of the webhook
// acknowledges one (they are no longer returned). When a bot leaves or is
// removed from a chat, its pending updates of that chat are dropped.
//
// The 409 single-poller rule, the in-process wake-ups and the webhook
// dispatcher assume one api process serves the Bot API of a tenant
// (server/README.md).
package botupdates

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"
	"unicode/utf8"

	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/chat"
	"app.local/server/internal/entities"
	"app.local/server/internal/sealbox"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Timings and limits.
const (
	cursorName = "bots"
	passBatch  = 500
	tickEvery  = time.Second
	// gapTTL: an outbox id skipped by the cursor that has not appeared by
	// then belongs to a rolled-back transaction.
	gapTTL = 30 * time.Second
	maxGap = 10000
	// MessageTTL keeps message updates; CallbackTTL keeps button presses
	// (the presser waits AnswerTimeout, the bot may answer later).
	MessageTTL   = 24 * time.Hour
	CallbackTTL  = 15 * time.Minute
	cleanupEvery = 10 * time.Minute
	// recheck bounds how long a waiting poll or press trusts the in-process
	// wake-up alone.
	recheck = 2 * time.Second
	// LongPollMax caps the timeout of a poll.
	LongPollMax = 50 * time.Second
	// AnswerTimeout is how long a button press waits for the bot.
	AnswerTimeout = 10 * time.Second
	// RetryAfterShutdown is the retry hint of a poll refused while the
	// process shuts down.
	RetryAfterShutdown = 5 * time.Second
	// poisonPasses is how many passes in a row an outbox row may fail
	// before it is skipped.
	poisonPasses  = 3
	answerTextMax = 200
	answerURLMax  = 2048
	// countersKept is how long delivery counters are kept.
	countersKept = 48 * time.Hour
)

// ErrConflict ends a long poll superseded by a newer poll of the same bot
// or by a webhook, and refuses a poll while the bot has a webhook.
var ErrConflict = errors.New("botupdates: a newer poll of this bot is running")

// ErrWebhookSet refuses a poll while the bot has a webhook (it wraps
// ErrConflict).
var ErrWebhookSet = fmt.Errorf("%w: updates go to the webhook; delete it to poll", ErrConflict)

// ErrUnavailable refuses a poll once the process shuts down; the bot
// retries after RetryAfterShutdown (on another process after the deploy).
var ErrUnavailable = errors.New("botupdates: the server is shutting down")

// Callback answer errors.
var (
	ErrCallbackNotFound = errors.New("botupdates: unknown or expired callback")
	ErrAnswered         = errors.New("botupdates: callback already answered")
	ErrBadAnswer        = errors.New("botupdates: invalid answer")
)

// Service is the consumer and the long poll of one api process.
type Service struct {
	pool      *pgxpool.Pool
	chat      *chat.Service
	appScheme string
	logger    *slog.Logger
	kick      chan struct{}

	// Consumer state, used by one pass at a time (passMu): the persisted
	// cursor (low), the highest id seen and the gaps between them.
	passMu  sync.Mutex
	loaded  bool
	low     int64
	high    int64
	pending map[int64]time.Time
	// failures counts the failed passes of an outbox row (poison rows);
	// skipped counts the rows given up since start.
	failures map[int64]int
	skipped  int64

	// webhooks delivers to bots with a webhook; nil until EnableWebhooks.
	webhooks *dispatcher
	box      *sealbox.Box

	mu        sync.Mutex
	wake      map[int64]chan struct{}
	polls     map[int64]*poll
	answers   map[string]chan struct{}
	closing   chan struct{}
	closeOnce sync.Once
}

type poll struct {
	superseded chan struct{}
}

// New returns the Service; run Run in the background and connect Kick to
// the chat core's commit observer.
func New(pool *pgxpool.Pool, chatSvc *chat.Service, appScheme string, logger *slog.Logger) (*Service, error) {
	if pool == nil || chatSvc == nil || logger == nil {
		return nil, errors.New("botupdates: missing dependency")
	}
	return &Service{
		pool: pool, chat: chatSvc, appScheme: appScheme, logger: logger, kick: make(chan struct{}, 1),
		pending: map[int64]time.Time{}, failures: map[int64]int{}, wake: map[int64]chan struct{}{}, polls: map[int64]*poll{},
		answers: map[string]chan struct{}{}, closing: make(chan struct{}),
	}, nil
}

// Kick asks the consumer to run now; it never blocks.
func (s *Service) Kick() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// ReleasePolls ends every waiting long poll with an empty result and makes
// new polls fail with ErrUnavailable (server shutdown: requests must not
// hold the drain for 50 seconds, and bots must back off instead of polling
// in a tight loop until the process stops).
func (s *Service) ReleasePolls() {
	s.closeOnce.Do(func() { close(s.closing) })
}

// Run consumes the outbox until ctx ends, and runs the webhook dispatcher
// when webhooks are enabled (it drains its in-flight requests before Run
// returns).
func (s *Service) Run(ctx context.Context) {
	if s.webhooks != nil {
		done := make(chan struct{})
		go func() {
			defer close(done)
			s.webhooks.run(ctx)
		}()
		defer func() { <-done }()
	}
	ticker := time.NewTicker(tickEvery)
	defer ticker.Stop()
	cleanup := time.NewTicker(cleanupEvery)
	defer cleanup.Stop()
	for {
		if err := s.CatchUp(ctx); err != nil && ctx.Err() == nil {
			s.logger.Error("bot update consumer failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-s.kick:
		case <-ticker.C:
		case <-cleanup.C:
			s.cleanup(ctx)
		}
	}
}

// CatchUp runs consumer passes until the outbox head is reached.
func (s *Service) CatchUp(ctx context.Context) error {
	for {
		n, err := s.pass(ctx)
		if err != nil || n < passBatch {
			return err
		}
	}
}

// pass consumes one batch in one transaction holding the cursor row, and
// returns how many new outbox rows it read.
func (s *Service) pass(ctx context.Context) (int, error) {
	s.passMu.Lock()
	defer s.passMu.Unlock()
	var read int
	var stored []int64
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		persisted, err := lockCursor(ctx, tx, s.chat.CursorName(cursorName))
		if err != nil {
			return err
		}
		if !s.loaded || persisted != s.low {
			s.low, s.high, s.pending, s.loaded = persisted, persisted, map[int64]time.Time{}, true
		}
		rows, err := s.chat.ReadOutbox(ctx, s.high, passBatch)
		if err != nil {
			return err
		}
		read = len(rows)
		gaps := make([]int64, 0, len(s.pending))
		for id := range s.pending {
			gaps = append(gaps, id)
		}
		late, err := s.chat.ReadOutboxIDs(ctx, gaps)
		if err != nil {
			return err
		}
		now := time.Now()
		for _, r := range rows {
			if r.ID-s.high <= maxGap {
				for gap := s.high + 1; gap < r.ID; gap++ {
					s.pending[gap] = now
				}
			}
			s.high = r.ID
			delete(s.pending, r.ID)
		}
		for _, r := range late {
			delete(s.pending, r.ID)
		}
		all := append(late, rows...)
		all = slices.DeleteFunc(all, func(r chat.OutboxRow) bool { return now.Sub(r.CreatedAt) > MessageTTL })
		slices.SortFunc(all, func(a, b chat.OutboxRow) int { return cmp.Compare(a.ID, b.ID) })
		updates, err := s.updatesOf(ctx, all)
		if err != nil {
			return err
		}
		if stored, err = s.store(ctx, tx, updates); err != nil {
			return err
		}
		if err := s.dropRemoved(ctx, tx, all); err != nil {
			return err
		}
		low := s.high
		for id, first := range s.pending {
			if now.Sub(first) > gapTTL {
				delete(s.pending, id)
				continue
			}
			low = min(low, id-1)
		}
		if low != persisted {
			if _, err := tx.Exec(ctx, `UPDATE outbox_cursors SET last_id = $2, updated_at = now() WHERE consumer = $1`,
				s.chat.CursorName(cursorName), low); err != nil {
				return fmt.Errorf("botupdates: save cursor: %w", err)
			}
		}
		s.low = low
		return nil
	})
	if err != nil {
		// The in-memory cursor moved with the rolled-back transaction:
		// reload it; replayed rows are no-ops.
		s.loaded = false
		return 0, err
	}
	for _, bot := range stored {
		s.notify(bot)
	}
	return read, nil
}

// lockCursor returns the persisted cursor name under its row lock, creating it
// at the outbox head when missing.
func lockCursor(ctx context.Context, tx pgx.Tx, name string) (int64, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO outbox_cursors (consumer, last_id) SELECT $1, coalesce(max(id), 0) FROM outbox
		ON CONFLICT (consumer) DO NOTHING`, name); err != nil {
		return 0, fmt.Errorf("botupdates: create cursor: %w", err)
	}
	var last int64
	if err := tx.QueryRow(ctx, `SELECT last_id FROM outbox_cursors WHERE consumer = $1 FOR UPDATE`, name).Scan(&last); err != nil {
		return 0, fmt.Errorf("botupdates: lock cursor: %w", err)
	}
	return last, nil
}

// store writes updates under each bot's next update_id and returns the
// bots that got new rows. Bots rows are locked in id order. An update that
// cannot be serialized is logged and skipped.
func (s *Service) store(ctx context.Context, tx pgx.Tx, updates []chat.BotUpdate) ([]int64, error) {
	if len(updates) == 0 {
		return nil, nil
	}
	var bots []int64
	for _, u := range updates {
		bots = append(bots, u.BotID)
	}
	slices.Sort(bots)
	bots = slices.Compact(bots)
	// allowed_updates of the webhook or of the last getUpdates that set it
	// (empty: every kind but the opt-in ones).
	rows, err := tx.Query(ctx, `
		SELECT user_id, next_update_id, allowed_updates
		FROM bots WHERE user_id = ANY($1) AND deleted_at IS NULL ORDER BY user_id FOR UPDATE`, bots)
	if err != nil {
		return nil, fmt.Errorf("botupdates: lock bots: %w", err)
	}
	next := map[int64]int64{}
	allowed := map[int64][]string{}
	for rows.Next() {
		var id, n int64
		var kinds []string
		if err := rows.Scan(&id, &n, &kinds); err != nil {
			rows.Close()
			return nil, fmt.Errorf("botupdates: lock bots: %w", err)
		}
		next[id], allowed[id] = n, kinds
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("botupdates: lock bots: %w", err)
	}
	received := map[int64]int64{}
	for _, u := range updates {
		id, ok := next[u.BotID]
		if !ok || !Wants(allowed[u.BotID], u.Kind) {
			continue
		}
		payload, err := payloadOf(u)
		if err != nil {
			s.logger.Error("bot update skipped", "bot_id", u.BotID, "outbox_id", u.OutboxID, "kind", u.Kind, "err", err)
			continue
		}
		ttl := MessageTTL
		if u.Kind == chat.BotUpdateCallback || u.Kind == chat.BotUpdateInlineQuery {
			ttl = CallbackTTL
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO bot_updates (bot_id, update_id, outbox_id, kind, seq, chat_id, payload, expires_at, queue_key)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT ON CONSTRAINT bot_updates_outbox_key DO NOTHING`,
			u.BotID, id, u.OutboxID, u.Kind, u.Seq(), u.Chat.GetId(), payload, u.At.Add(ttl), queueKey(u))
		if err != nil {
			return nil, fmt.Errorf("botupdates: store update: %w", err)
		}
		if tag.RowsAffected() == 1 {
			next[u.BotID] = id + 1
			received[u.BotID]++
		}
	}
	var ids, values, counts []int64
	for id, n := range received {
		ids, values, counts = append(ids, id), append(values, next[id]), append(counts, n)
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE bots b SET next_update_id = x.n FROM unnest($1::bigint[], $2::bigint[]) AS x(id, n) WHERE b.user_id = x.id`,
			ids, values); err != nil {
			return nil, fmt.Errorf("botupdates: advance update ids: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO bot_delivery_counters (bot_id, hour, received)
			SELECT x.id, date_trunc('hour', now()), x.n FROM unnest($1::bigint[], $2::bigint[]) AS x(id, n)
			ON CONFLICT (bot_id, hour) DO UPDATE SET received = bot_delivery_counters.received + excluded.received`,
			ids, counts); err != nil {
			return nil, fmt.Errorf("botupdates: count received updates: %w", err)
		}
	}
	slices.Sort(ids)
	return ids, nil
}

// queueKey is the delivery queue of an update: updates of one queue reach a
// webhook one at a time, in update_id order. Messages queue by chat,
// button presses and inline queries by the user (negative, apart from chat
// ids).
func queueKey(u chat.BotUpdate) int64 {
	switch {
	case u.Kind == chat.BotUpdateCallback && u.Callback != nil:
		return -u.Callback.FromID
	case u.Kind == chat.BotUpdateInlineQuery && u.Inline != nil:
		return -u.Inline.FromID
	}
	return u.Chat.GetId()
}

// dropRemoved acknowledges, without delivering, the pending updates of
// chats bots were removed from (kicked or left) that were cut before the
// removal; dead letters of those chats go too. The member_changed that
// tells the bot it left or was removed stays.
func (s *Service) dropRemoved(ctx context.Context, tx pgx.Tx, rows []chat.OutboxRow) error {
	removals, err := s.chat.BotRemovals(ctx, rows)
	if err != nil {
		return err
	}
	for _, r := range removals {
		if _, err := tx.Exec(ctx, `
			UPDATE bot_updates SET acked = true
			WHERE bot_id = $1 AND chat_id = $2 AND outbox_id < $3 AND NOT acked
				AND NOT (kind = $4 AND payload->'member'->>'status' IN ('left', 'banned'))`,
			r.BotID, r.ChatID, r.OutboxID, chat.BotUpdateMemberChanged); err != nil {
			return fmt.Errorf("botupdates: drop updates of a left chat: %w", err)
		}
	}
	return nil
}

// updatesOf cuts the updates of rows (in id order). When the batch fails,
// each row is tried alone so one bad row cannot hold back the others: a
// row that keeps failing for poisonPasses passes is logged and skipped,
// earlier failures end the pass (the transaction rolls back and the next
// pass retries; a database hiccup must not drop updates).
func (s *Service) updatesOf(ctx context.Context, rows []chat.OutboxRow) ([]chat.BotUpdate, error) {
	updates, err := s.chat.BotUpdates(ctx, rows)
	if err == nil || ctx.Err() != nil {
		if err == nil {
			for _, r := range rows {
				delete(s.failures, r.ID)
			}
		}
		return updates, err
	}
	var out []chat.BotUpdate
	for _, r := range rows {
		list, err := s.chat.BotUpdates(ctx, []chat.OutboxRow{r})
		if err == nil {
			delete(s.failures, r.ID)
			out = append(out, list...)
			continue
		}
		if ctx.Err() != nil {
			return nil, err
		}
		s.failures[r.ID]++
		if n := s.failures[r.ID]; n < poisonPasses {
			return nil, fmt.Errorf("botupdates: outbox row %d (attempt %d of %d): %w", r.ID, n, poisonPasses, err)
		}
		delete(s.failures, r.ID)
		s.skipped++
		s.logger.Error("bot update consumer skipped an outbox row", "outbox_id", r.ID, "kind", r.Kind,
			"chat_id", r.ChatID, "attempts", poisonPasses, "skipped_total", s.skipped, "err", err)
	}
	return out, nil
}

// payloadOf serializes the update body (without update_id) for the bot.
func payloadOf(u chat.BotUpdate) ([]byte, error) {
	users := wire.IndexUsers(u.Users)
	c := wire.FromChat(u.Chat, users)
	var v any
	switch {
	case u.Kind == chat.BotUpdateMemberChanged && u.Member != nil:
		mc := wire.MemberChanged{Chat: c, Date: u.At.Unix(), Member: wire.ChatMember{
			User: users.UserOf(u.BotID), Status: u.Member.Status, Permissions: u.Member.Permissions,
		}}
		if u.Member.ActorID != 0 {
			from := users.UserOf(u.Member.ActorID)
			mc.From = &from
		}
		v = mc
	case u.Kind == chat.BotUpdateInlineQuery && u.Inline != nil:
		q := u.Inline
		v = wire.InlineQuery{ID: q.ID, From: users.UserOf(q.FromID), Query: q.Query, Offset: q.Offset, ChatType: q.ChatType}
	case u.Kind == chat.BotUpdateReaction && u.Reaction != nil:
		v = wire.Reaction{Chat: c, Seq: u.Reaction.Seq, User: users.UserOf(u.Reaction.UserID), Emoji: u.Reaction.Emoji, Date: u.At.Unix()}
	case u.Message == nil:
		return nil, fmt.Errorf("botupdates: %s update without its content", u.Kind)
	case u.Kind == chat.BotUpdateCallback:
		v = wire.Callback{ID: u.Callback.ID, From: users.UserOf(u.Callback.FromID), Message: wire.FromMessage(u.Message, c, users),
			Data: string(u.Callback.Data)}
	default:
		v = wire.FromMessage(u.Message, c, users)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("botupdates: encode update: %w", err)
	}
	return b, nil
}

func (s *Service) cleanup(ctx context.Context) {
	for _, sql := range []string{
		`DELETE FROM bot_updates WHERE expires_at < now()`,
		`DELETE FROM bot_callbacks WHERE created_at < now() - interval '1 day'`,
		`DELETE FROM bot_inline_queries WHERE created_at < now() - interval '1 day'`,
		fmt.Sprintf(`DELETE FROM bot_delivery_counters WHERE hour < now() - interval '%d seconds'`, int(countersKept.Seconds())),
	} {
		if _, err := s.pool.Exec(ctx, sql); err != nil && ctx.Err() == nil {
			s.logger.Warn("bot update cleanup failed", "err", err)
		}
	}
}

// --------------------------------------------------------------- polling

// Update is a stored update as the Bot API returns it.
type Update struct {
	ID      int64
	Kind    string
	Payload json.RawMessage
}

// MarshalJSON writes {"update_id": ID, <kind>: payload}.
func (u Update) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"update_id": u.ID, u.Kind: u.Payload})
}

func (s *Service) wakeChan(botID int64) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.wake[botID]
	if ch == nil {
		ch = make(chan struct{})
		s.wake[botID] = ch
	}
	return ch
}

func (s *Service) notify(botID int64) {
	s.mu.Lock()
	if ch := s.wake[botID]; ch != nil {
		close(ch)
		delete(s.wake, botID)
	}
	s.mu.Unlock()
	if s.webhooks != nil {
		s.webhooks.wake(botID)
	}
}

// endPoll ends the bot's waiting poll with ErrConflict (a webhook was set).
func (s *Service) endPoll(botID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.polls[botID]; p != nil {
		close(p.superseded)
		delete(s.polls, botID)
	}
}

// Poll acknowledges every update below offset (when offset > 0) and returns
// up to limit updates from offset on, waiting up to timeout for the first
// one. A newer Poll of the same bot ends this one with ErrConflict, and so
// does setting a webhook; while the bot has a webhook Poll fails with
// ErrWebhookSet. Once the process shuts down a waiting poll ends empty and
// a new one fails with ErrUnavailable.
func (s *Service) Poll(ctx context.Context, botID, offset int64, limit int, timeout time.Duration) ([]Update, error) {
	select {
	case <-s.closing:
		return nil, ErrUnavailable
	default:
	}
	var hooked bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bots WHERE user_id = $1 AND webhook_url IS NOT NULL)`,
		botID).Scan(&hooked); err != nil {
		return nil, fmt.Errorf("botupdates: webhook state: %w", err)
	}
	if hooked {
		return nil, ErrWebhookSet
	}
	p := &poll{superseded: make(chan struct{})}
	s.mu.Lock()
	if old := s.polls[botID]; old != nil {
		close(old.superseded)
	}
	s.polls[botID] = p
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.polls[botID] == p {
			delete(s.polls, botID)
		}
		s.mu.Unlock()
	}()
	if offset > 0 {
		// Acknowledged updates stay until they expire: a replay of their
		// outbox rows must find them (see the package comment).
		if _, err := s.pool.Exec(ctx, `
			WITH a AS (
				UPDATE bot_updates SET acked = true, delivered_at = CASE WHEN dead_at IS NULL THEN now() END
				WHERE bot_id = $1 AND update_id < $2 AND NOT acked RETURNING dead_at
			)
			INSERT INTO bot_delivery_counters (bot_id, hour, delivered)
			SELECT $1, date_trunc('hour', now()), count(*) FROM a WHERE dead_at IS NULL HAVING count(*) > 0
			ON CONFLICT (bot_id, hour) DO UPDATE SET delivered = bot_delivery_counters.delivered + excluded.delivered`,
			botID, offset); err != nil {
			return nil, fmt.Errorf("botupdates: acknowledge: %w", err)
		}
	}
	timeout = min(max(timeout, 0), LongPollMax)
	deadline := time.Now().Add(timeout)
	for {
		wake := s.wakeChan(botID)
		list, err := s.read(ctx, botID, offset, limit)
		if err != nil || len(list) > 0 {
			return list, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return list, nil
		}
		timer := time.NewTimer(min(remaining, recheck))
		select {
		case <-wake:
		case <-timer.C:
		case <-p.superseded:
			timer.Stop()
			return nil, ErrConflict
		case <-s.closing:
			timer.Stop()
			return list, nil
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
		timer.Stop()
	}
}

func (s *Service) read(ctx context.Context, botID, offset int64, limit int) ([]Update, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT update_id, kind, payload FROM bot_updates
		WHERE bot_id = $1 AND update_id >= $2 AND NOT acked AND dead_at IS NULL AND expires_at > now()
			AND NOT EXISTS (SELECT 1 FROM bots WHERE user_id = $1 AND webhook_url IS NOT NULL)
		ORDER BY update_id LIMIT $3`, botID, offset, limit)
	if err != nil {
		return nil, fmt.Errorf("botupdates: read: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Update, error) {
		var u Update
		err := r.Scan(&u.ID, &u.Kind, &u.Payload)
		return u, err
	})
	if err != nil {
		return nil, fmt.Errorf("botupdates: read: %w", err)
	}
	if list == nil {
		list = []Update{}
	}
	return list, nil
}

// ------------------------------------------------------------- callbacks

// Answer is the bot's answer to a button press.
type Answer struct {
	Text      string
	ShowAlert bool
	URL       string
}

// Answer records the bot's answer to its callback and wakes the presser.
func (s *Service) Answer(ctx context.Context, botID int64, callbackID string, a Answer) error {
	if !utf8.ValidString(a.Text) || utf8.RuneCountInString(a.Text) > answerTextMax {
		return fmt.Errorf("%w: text has more than %d characters", ErrBadAnswer, answerTextMax)
	}
	if a.URL != "" && (len(a.URL) > answerURLMax || !entities.IsAllowedURL(a.URL, s.appScheme)) {
		return fmt.Errorf("%w: url is not allowed", ErrBadAnswer)
	}
	if len(callbackID) == 0 || len(callbackID) > 64 {
		return ErrCallbackNotFound
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE bot_callbacks SET answered_at = now(), answer_text = $3, answer_alert = $4, answer_url = $5
		WHERE id = $1 AND bot_id = $2 AND answered_at IS NULL AND created_at > now() - $6::interval`,
		callbackID, botID, a.Text, a.ShowAlert, a.URL, CallbackTTL)
	if err != nil {
		return fmt.Errorf("botupdates: answer: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var done bool
		err := s.pool.QueryRow(ctx, `
			SELECT answered_at IS NOT NULL FROM bot_callbacks WHERE id = $1 AND bot_id = $2 AND created_at > now() - $3::interval`,
			callbackID, botID, CallbackTTL).Scan(&done)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return ErrCallbackNotFound
		case err != nil:
			return fmt.Errorf("botupdates: answer: %w", err)
		case done:
			return ErrAnswered
		default:
			return ErrCallbackNotFound
		}
	}
	s.Wake(callbackID)
	return nil
}

// AwaitAnswer waits up to timeout for the answer to a press; answered is
// false when the bot did not answer in time.
func (s *Service) AwaitAnswer(ctx context.Context, callbackID string, timeout time.Duration) (a Answer, answered bool, err error) {
	answered, err = s.Await(ctx, callbackID, timeout, func() (bool, error) {
		err := s.pool.QueryRow(ctx, `
			SELECT answer_text, answer_alert, answer_url FROM bot_callbacks WHERE id = $1 AND answered_at IS NOT NULL`,
			callbackID).Scan(&a.Text, &a.ShowAlert, &a.URL)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("botupdates: read answer: %w", err)
		}
		return true, nil
	})
	if err != nil || !answered {
		return Answer{}, false, err
	}
	return a, true, nil
}

// Await waits up to timeout until answered reports true, checking again
// when Wake(id) runs in this process or every recheck (an answer that
// reached another process).
func (s *Service) Await(ctx context.Context, id string, timeout time.Duration, answered func() (bool, error)) (bool, error) {
	deadline := time.Now().Add(timeout)
	defer func() {
		s.mu.Lock()
		delete(s.answers, id)
		s.mu.Unlock()
	}()
	for {
		s.mu.Lock()
		ch := s.answers[id]
		if ch == nil {
			ch = make(chan struct{})
			s.answers[id] = ch
		}
		s.mu.Unlock()
		ok, err := answered()
		if err != nil || ok {
			return ok, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false, nil
		}
		timer := time.NewTimer(min(remaining, recheck))
		select {
		case <-ch:
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return false, ctx.Err()
		}
		timer.Stop()
	}
}

// Wake ends the Await of id in this process.
func (s *Service) Wake(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch := s.answers[id]; ch != nil {
		close(ch)
		delete(s.answers, id)
	}
}

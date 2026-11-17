package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/sealbox"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// logoutAttempts is how many times a queued logout is tried before it is
// given up (the session then stays listed in the other app).
const logoutAttempts = 10

// Deps are what the engine needs from the rest of the server.
type Deps struct {
	Pool *pgxpool.Pool
	Chat *chat.Service
	// Box seals and opens the login state of external accounts.
	Box *sealbox.Box
	// Adapters is the static set of supported apps, by Adapter.Name.
	Adapters map[string]bridge.Adapter
	// Limiter bounds the logins a user starts; nil means no bound.
	Limiter ratelimit.Limiter
	Logger  *slog.Logger
}

// Engine is the bridge service: it keeps every active external account
// connected and syncing.
type Engine struct {
	cfg      Config
	db       *db
	chat     *chat.Service
	box      *sealbox.Box
	adapters map[string]bridge.Adapter
	logger   *slog.Logger
	limiter  ratelimit.Limiter

	mu      sync.Mutex
	runners map[int64]*runnerHandle
	logins  map[string]*pendingLogin
}

type runnerHandle struct {
	r      *runner
	cancel context.CancelFunc
	done   chan struct{}
}

// New builds the engine; Run starts it.
func New(cfg Config, d Deps) *Engine {
	cfg = cfg.withDefaults()
	return &Engine{cfg: cfg, db: &db{pool: d.Pool, tenantID: cfg.TenantID}, chat: d.Chat, box: d.Box,
		adapters: d.Adapters, logger: d.Logger, limiter: d.Limiter, runners: map[int64]*runnerHandle{}}
}

// Run connects the active accounts and keeps them connected until ctx ends,
// then waits for them to stop.
func (e *Engine) Run(ctx context.Context) {
	t := time.NewTicker(e.cfg.ReconcileEvery)
	defer t.Stop()
	for {
		e.reconcile(ctx)
		select {
		case <-ctx.Done():
			e.waitStopped()
			return
		case <-t.C:
		}
	}
}

func (e *Engine) waitStopped() {
	e.mu.Lock()
	handles := make([]*runnerHandle, 0, len(e.runners))
	for _, h := range e.runners {
		handles = append(handles, h)
	}
	e.mu.Unlock()
	for _, h := range handles {
		<-h.done
	}
}

// reconcile starts a runner for every active account that has none and
// works through the queued logouts.
func (e *Engine) reconcile(ctx context.Context) {
	ids, err := e.db.activeAccountIDs(ctx)
	if err != nil {
		if ctx.Err() == nil {
			e.logger.Error("listing external accounts failed", "err", err)
		}
		return
	}
	for _, id := range ids {
		e.mu.Lock()
		_, running := e.runners[id]
		e.mu.Unlock()
		if !running {
			e.start(ctx, id)
		}
	}
	if err := e.runLogouts(ctx); err != nil && ctx.Err() == nil {
		e.logger.Error("external logouts failed", "err", err)
	}
}

// start connects one account in its own goroutine, reconnecting with
// backoff until it is stopped, needs a new login or is gone.
func (e *Engine) start(ctx context.Context, id int64) {
	ctx, cancel := context.WithCancel(ctx)
	h := &runnerHandle{done: make(chan struct{}), cancel: cancel}
	e.mu.Lock()
	e.runners[id] = h
	e.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			e.mu.Lock()
			delete(e.runners, id)
			e.mu.Unlock()
			close(h.done)
		}()
		e.superviseAccount(ctx, id, h)
	}()
}

func (e *Engine) superviseAccount(ctx context.Context, id int64, h *runnerHandle) {
	backoff := e.cfg.BackoffMin
	for ctx.Err() == nil {
		a, err := e.db.loadAccount(ctx, id)
		if err != nil || a.Status != "active" {
			return
		}
		adapter := e.adapters[a.Source]
		logger := e.logger.With("external_account_id", id, "source", a.Source)
		if adapter == nil {
			_ = e.db.setStatus(ctx, id, "stopped", "unsupported app")
			return
		}
		session, err := e.box.Open(a.Secret, bridge.SecretAAD(a.ID, a.OwnerID, a.Source))
		if err != nil {
			logger.Error("the stored login cannot be opened; the account needs to sign in again")
			_ = e.db.setStatus(ctx, id, "needs_login", "stored login unreadable")
			return
		}
		r := &runner{e: e, account: a, adapter: adapter, logger: logger, cmds: make(chan *chatLink, 8), puppets: map[string]int64{},
			acct: bridge.Account{ID: fmt.Sprint(a.ID), Session: session, State: a.UpdateState}}
		e.mu.Lock()
		h.r = r
		e.mu.Unlock()
		started := time.Now()
		err = r.run(ctx)
		if ctx.Err() != nil {
			return
		}
		switch {
		case errors.Is(err, bridge.ErrSessionRevoked):
			logger.Warn("the other app ended the session; the account needs to sign in again")
			_ = e.db.setStatus(ctx, id, "needs_login", "session ended in the other app")
			return
		case errors.Is(err, errLeaseLost):
			logger.Info("another process holds the account")
			return
		}
		logger.Warn("sync stopped; reconnecting", "err", err, "wait", backoff)
		_ = e.db.setStatus(ctx, id, "active", err.Error())
		if time.Since(started) > 2*e.cfg.BackoffMax {
			backoff = e.cfg.BackoffMin
		}
		if sleep(ctx, backoff) != nil {
			return
		}
		backoff = min(backoff*2, e.cfg.BackoffMax)
	}
}

// Nudge tells a running account to import a chat that was just linked. An
// account that is not running imports it when it connects.
func (e *Engine) Nudge(accountID int64, externalChat string) {
	e.mu.Lock()
	h := e.runners[accountID]
	var r *runner
	if h != nil {
		r = h.r
	}
	e.mu.Unlock()
	if r == nil {
		return
	}
	l, err := e.db.link(context.Background(), accountID, externalChat)
	if err != nil || l == nil || l.BackfillDone {
		return
	}
	select {
	case r.cmds <- l:
	default:
		// The queue is full; the chat is imported at the next connect.
	}
}

// runLogouts logs the sessions of erased accounts out of the other app.
func (e *Engine) runLogouts(ctx context.Context) error {
	rows, err := e.db.pool.Query(ctx, `SELECT id, source, account_id, owner_id, secret, attempts FROM external_logouts ORDER BY id LIMIT 20`)
	if err != nil {
		return fmt.Errorf("bridge: list logouts: %w", err)
	}
	type item struct {
		id, account, owner int64
		source             string
		secret             []byte
		attempts           int
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (item, error) {
		var it item
		err := r.Scan(&it.id, &it.source, &it.account, &it.owner, &it.secret, &it.attempts)
		return it, err
	})
	if err != nil {
		return fmt.Errorf("bridge: list logouts: %w", err)
	}
	for _, it := range items {
		if err := e.logout(ctx, it.source, it.account, it.owner, it.secret); err != nil && it.attempts+1 < logoutAttempts {
			e.logger.Warn("logging out of the other app failed; it is tried again", "source", it.source, "attempts", it.attempts+1, "err", err)
			_, _ = e.db.pool.Exec(ctx, `UPDATE external_logouts SET attempts = attempts + 1 WHERE id = $1`, it.id)
			continue
		} else if err != nil {
			e.logger.Error("giving up logging out of the other app", "source", it.source, "err", err)
		}
		if _, err := e.db.pool.Exec(ctx, `DELETE FROM external_logouts WHERE id = $1`, it.id); err != nil {
			return fmt.Errorf("bridge: finish logout: %w", err)
		}
	}
	return nil
}

// logout ends the session sealed in secret in the other app.
func (e *Engine) logout(ctx context.Context, source string, account, owner int64, secret []byte) error {
	adapter := e.adapters[source]
	if adapter == nil {
		return nil // an app this build does not know: nothing to call
	}
	session, err := e.box.Open(secret, bridge.SecretAAD(account, owner, source))
	if err != nil {
		return nil // unreadable: the session cannot be used either
	}
	err = adapter.Logout(ctx, bridge.Account{ID: fmt.Sprint(account), Session: session})
	if errors.Is(err, bridge.ErrSessionRevoked) {
		return nil
	}
	return err
}

// Window bounds of a chat's history import.
const (
	DefaultWindow = 2000
	MaxWindow     = 100000
)

// EnableChat starts syncing a conversation of the account into a new chat
// of its owner and returns the chat id. history is how many of the newest
// messages to import (0 takes DefaultWindow); it is chosen here, once,
// because seq only grows at the end and older history cannot be added
// later. Enabling a conversation again returns its chat.
func (e *Engine) EnableChat(ctx context.Context, accountID int64, conv bridge.Conversation, history int) (int64, error) {
	if history == 0 {
		history = DefaultWindow
	}
	if history < 1 || history > MaxWindow {
		return 0, fmt.Errorf("bridge: history window must be 1 to %d messages", MaxWindow)
	}
	a, err := e.db.loadAccount(ctx, accountID)
	if err != nil {
		return 0, err
	}
	if existing, err := e.db.link(ctx, accountID, conv.ID); err != nil || existing != nil {
		if err != nil {
			return 0, err
		}
		return existing.ChatID, nil
	}
	ic := chat.ImportedChat{Title: conv.Title}
	switch conv.Kind {
	case bridge.ConvPrivate, bridge.ConvBot:
		if conv.Peer == nil {
			return 0, errors.New("bridge: a private conversation names its other side")
		}
		peer, err := e.db.ensurePuppet(ctx, a, *conv.Peer)
		if err != nil {
			return 0, err
		}
		ic.Kind, ic.Peer = "private", peer
	case bridge.ConvGroup:
		ic.Kind = "group"
	case bridge.ConvChannel:
		ic.Kind = "channel"
	default:
		return 0, fmt.Errorf("bridge: unsupported conversation kind %q", conv.Kind)
	}
	chatID, err := e.chat.CreateImportedChat(ctx, a.OwnerID, ic, func(tx pgx.Tx, chatID int64) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO external_chats (account_id, external_chat_id, chat_id, history_window) VALUES ($1, $2, $3, $4)`,
			accountID, conv.ID, chatID, history)
		return err
	})
	if err != nil {
		return 0, err
	}
	e.Nudge(accountID, conv.ID)
	return chatID, nil
}

// stopRunner disconnects an account's runner and waits for it to end.
func (e *Engine) stopRunner(accountID int64) {
	e.mu.Lock()
	h := e.runners[accountID]
	e.mu.Unlock()
	if h == nil {
		return
	}
	h.cancel()
	<-h.done
}

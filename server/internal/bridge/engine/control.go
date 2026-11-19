package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"app.local/server/internal/ratelimit"
	"github.com/jackc/pgx/v5"
)

// Errors the control calls return; the RPC layer maps them to codes.
var (
	ErrUnknownApp   = errors.New("bridge: unknown app")
	ErrNotFound     = errors.New("bridge: not found")
	ErrRateLimited  = errors.New("bridge: too many sign-in attempts")
	ErrAccountTaken = errors.New("bridge: that account is connected by another user")
	// ErrSendUnsupported: the app cannot be written to from Chat, or the
	// account is signed out.
	ErrSendUnsupported = errors.New("bridge: this app cannot be written to from Chat")
)

// loginTTL is how long an unfinished login waits for the user's next answer.
const loginTTL = 10 * time.Minute

// limitLogin bounds the logins a user starts: each one sends a code to a
// phone, and the other app penalises a flood of them.
var limitLogin = ratelimit.Rule{Rate: 1.0 / 600, Burst: 3}

// pendingLogin is a login between two answers. The adapter's own token stays
// on the server: the client only holds the id of this entry.
type pendingLogin struct {
	owner   int64
	source  string
	token   string
	expires time.Time
}

// LoginStep is the step a user is shown next.
type LoginStep struct {
	Kind    bridge.StepKind
	LoginID string
	Fields  []bridge.Field
	Prompt  string
	// AccountID is set with StepDone.
	AccountID int64
}

// StartLogin begins signing owner in to an app.
func (e *Engine) StartLogin(ctx context.Context, owner int64, source string) (LoginStep, error) {
	adapter := e.adapters[source]
	if adapter == nil {
		return LoginStep{}, ErrUnknownApp
	}
	if e.limiter != nil && !e.limiter.Allow(limitLogin, fmt.Sprintf("bridge-login:%d", owner)) {
		return LoginStep{}, ErrRateLimited
	}
	step, err := adapter.Login(ctx, "", nil)
	if err != nil {
		return LoginStep{}, err
	}
	return e.afterStep(ctx, owner, source, "", step)
}

// ContinueLogin gives the user's answers to the open step of a login.
func (e *Engine) ContinueLogin(ctx context.Context, owner int64, loginID string, input map[string]string) (LoginStep, error) {
	p, ok := e.takeLogin(owner, loginID)
	if !ok {
		return LoginStep{}, ErrNotFound
	}
	step, err := e.adapters[p.source].Login(ctx, p.token, input)
	if err != nil {
		var wrong *bridge.InputError
		if errors.As(err, &wrong) {
			e.putLogin(loginID, p) // the step stays open
		}
		return LoginStep{}, err
	}
	return e.afterStep(ctx, owner, p.source, loginID, step)
}

func (e *Engine) afterStep(ctx context.Context, owner int64, source, loginID string, step bridge.LoginStep) (LoginStep, error) {
	if step.Kind == bridge.StepDone {
		id, err := e.saveLogin(ctx, owner, source, step)
		return LoginStep{Kind: bridge.StepDone, AccountID: id}, err
	}
	if loginID == "" {
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return LoginStep{}, fmt.Errorf("bridge: login id: %w", err)
		}
		loginID = hex.EncodeToString(raw[:])
	}
	e.putLogin(loginID, &pendingLogin{owner: owner, source: source, token: step.Token})
	return LoginStep{Kind: step.Kind, LoginID: loginID, Fields: step.Fields, Prompt: step.Prompt}, nil
}

func (e *Engine) putLogin(id string, p *pendingLogin) {
	p.expires = time.Now().Add(loginTTL)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.logins == nil {
		e.logins = map[string]*pendingLogin{}
	}
	for k, v := range e.logins {
		if time.Now().After(v.expires) {
			delete(e.logins, k)
		}
	}
	e.logins[id] = p
}

// takeLogin removes and returns the login of owner (the caller puts it back
// when the step stays open).
func (e *Engine) takeLogin(owner int64, id string) (*pendingLogin, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p := e.logins[id]
	if p == nil || p.owner != owner || time.Now().After(p.expires) {
		return nil, false
	}
	delete(e.logins, id)
	return p, true
}

// saveLogin stores the login state of a signed-in account, sealed. Signing
// in again to the same account replaces its state and reactivates it; an
// account another user connected is refused.
func (e *Engine) saveLogin(ctx context.Context, owner int64, source string, step bridge.LoginStep) (int64, error) {
	if step.Account == "" {
		return 0, errors.New("bridge: the app did not say which account signed in")
	}
	var id int64
	err := pgx.BeginFunc(ctx, e.db.pool, func(tx pgx.Tx) error {
		var holder int64
		err := tx.QueryRow(ctx, `SELECT id, owner_id FROM external_accounts WHERE source = $1 AND external_ref = $2 FOR UPDATE`, source, step.Account).Scan(&id, &holder)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := tx.QueryRow(ctx, `
				INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, $2, $3, '\x00') RETURNING id`,
				owner, source, step.Account).Scan(&id); err != nil {
				return fmt.Errorf("bridge: create account: %w", err)
			}
		case err != nil:
			return fmt.Errorf("bridge: find account: %w", err)
		case holder != owner:
			return ErrAccountTaken
		}
		sealed := e.box.Seal(step.Session, bridge.SecretAAD(id, owner, source))
		if _, err := tx.Exec(ctx, `
			UPDATE external_accounts SET secret = $2, status = 'active', last_error = '', lease_holder = NULL, lease_until = NULL, updated_at = now()
			WHERE id = $1`, id, sealed); err != nil {
			return fmt.Errorf("bridge: save login: %w", err)
		}
		return nil
	})
	return id, err
}

// Sources lists the apps this build can connect.
func (e *Engine) Sources() []string {
	out := make([]string, 0, len(e.adapters))
	for name := range e.adapters {
		out = append(out, name)
	}
	return out
}

// AccountView is an account of a user with its synced chats.
type AccountView struct {
	ID        int64
	Source    string
	Status    string
	LastError string
	Chats     []ChatView
	// SyncState is the account's one switch: off, syncing or live (ADR 0024).
	SyncState string
	Progress  SyncProgress
}

// SyncProgress is how far the first import of the account's conversations went.
type SyncProgress struct {
	// Conversations has a chat; Done of them are imported.
	Conversations, Done int
	// Messages imported so far, of Expected: a chat imported counts what it took, one
	// still importing its whole window.
	Messages, Expected int64
}

// ChatView is a synced chat.
type ChatView struct {
	ConversationID string
	ChatID         int64
	CaughtUp       bool
	HistoryWindow  int
	Title          string
	// Direction is chat.DirectionIn or chat.DirectionBoth.
	Direction string
	// TopicsSplit is true when the chat is split into topics.
	TopicsSplit bool
}

// Accounts lists the accounts of owner.
func (e *Engine) Accounts(ctx context.Context, owner int64) ([]AccountView, error) {
	rows, err := e.db.pool.Query(ctx, `SELECT id, source, status, last_error, sync_state FROM external_accounts WHERE owner_id = $1 ORDER BY id`, owner)
	if err != nil {
		return nil, fmt.Errorf("bridge: list accounts: %w", err)
	}
	accounts, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (AccountView, error) {
		var a AccountView
		err := r.Scan(&a.ID, &a.Source, &a.Status, &a.LastError, &a.SyncState)
		return a, err
	})
	if err != nil {
		return nil, fmt.Errorf("bridge: list accounts: %w", err)
	}
	for i := range accounts {
		links, err := e.db.links(ctx, accounts[i].ID)
		if err != nil {
			return nil, err
		}
		for _, l := range links {
			accounts[i].Chats = append(accounts[i].Chats, ChatView{ConversationID: l.ExternalChat, ChatID: l.ChatID, CaughtUp: l.BackfillDone, HistoryWindow: l.HistoryMax, Title: l.Title, Direction: l.Direction, TopicsSplit: l.Forum})
		}
		if accounts[i].Progress, err = e.db.syncProgress(ctx, accounts[i].ID); err != nil {
			return nil, err
		}
	}
	return accounts, nil
}

// ownedAccount loads an account of owner (ErrNotFound for any other).
func (e *Engine) ownedAccount(ctx context.Context, owner, id int64) (*accountRow, error) {
	a, err := e.db.loadAccount(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if a.OwnerID != owner {
		return nil, ErrNotFound
	}
	return a, nil
}

// Conversation is a conversation of an account and the chat that copies it.
type Conversation struct {
	bridge.Conversation
	ChatID int64
	// TopicsSplit is true when the chat that copies it is split into topics.
	TopicsSplit bool
}

// Conversations lists the conversations of an account.
func (e *Engine) Conversations(ctx context.Context, owner, accountID int64) ([]Conversation, error) {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return nil, err
	}
	session, err := e.box.Open(a.Secret, bridge.SecretAAD(a.ID, a.OwnerID, a.Source))
	if err != nil {
		return nil, ErrNotFound
	}
	adapter := e.adapters[a.Source]
	if adapter == nil {
		return nil, ErrUnknownApp
	}
	list, err := adapter.ListConversations(ctx, bridge.Account{ID: fmt.Sprint(a.ID), Session: session, State: a.UpdateState})
	if err != nil {
		return nil, err
	}
	links, err := e.db.links(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	linked := make(map[string]*chatLink, len(links))
	for _, l := range links {
		linked[l.ExternalChat] = l
	}
	out := make([]Conversation, len(list))
	for i, c := range list {
		out[i] = Conversation{Conversation: c}
		if l := linked[c.ID]; l != nil {
			out[i].ChatID, out[i].TopicsSplit = l.ChatID, l.Forum
		}
	}
	return out, nil
}

// EnableConversation starts syncing one conversation of owner's account. An
// empty direction takes chat.DirectionBoth, which EnableChatWith lowers to
// chat.DirectionIn for an app that cannot be written to.
func (e *Engine) EnableConversation(ctx context.Context, owner, accountID int64, conversationID string, history int, direction string) (int64, error) {
	if direction == "" {
		direction = chat.DirectionBoth
	}
	list, err := e.Conversations(ctx, owner, accountID)
	if err != nil {
		return 0, err
	}
	for _, c := range list {
		if c.ID == conversationID {
			return e.EnableChatWith(ctx, accountID, c.Conversation, history, direction)
		}
	}
	return 0, ErrNotFound
}

// RemoveChat deletes the chat that copies a conversation and stops its sync.
func (e *Engine) RemoveChat(ctx context.Context, owner, accountID int64, conversationID string) error {
	if _, err := e.ownedAccount(ctx, owner, accountID); err != nil {
		return err
	}
	l, err := e.db.link(ctx, accountID, conversationID)
	if err != nil {
		return err
	}
	if l == nil {
		return ErrNotFound
	}
	return e.chat.DeleteImportedChat(ctx, owner, l.ChatID)
}

// Disconnect signs the account out of the other app. Its chats stay as
// read-only copies, or are deleted with deleteChats, together with the
// contacts imported with them.
func (e *Engine) Disconnect(ctx context.Context, owner, accountID int64, deleteChats bool) error {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return err
	}
	e.stopRunner(a.ID)
	if deleteChats {
		links, err := e.db.links(ctx, a.ID)
		if err != nil {
			return err
		}
		for _, l := range links {
			if err := e.chat.DeleteImportedChat(ctx, owner, l.ChatID); err != nil {
				return err
			}
		}
	}
	if err := e.logout(ctx, a.Source, a.ID, a.OwnerID, a.Secret); err != nil {
		e.logger.Warn("signing out of the other app failed; the account is disconnected here anyway", "source", a.Source, "err", err)
	}
	if deleteChats {
		return e.removeAccount(ctx, a)
	}
	// Chats stay: the account keeps its row (and the links that make them
	// read-only) but loses its login. Nothing queued can be sent any more.
	if _, err = e.db.pool.Exec(ctx, `UPDATE external_chats SET direction = 'in' WHERE account_id = $1`, a.ID); err != nil {
		return err
	}
	if _, err = e.db.pool.Exec(ctx, `
		UPDATE external_outbox SET status = 'cancelled', updated_at = now()
		WHERE account_id = $1 AND status IN ('pending', 'sending', 'failed', 'unknown')`, a.ID); err != nil {
		return err
	}
	_, err = e.db.pool.Exec(ctx, `
		UPDATE external_accounts SET status = 'stopped', secret = '\x00', update_state = NULL, lease_holder = NULL, lease_until = NULL, updated_at = now()
		WHERE id = $1`, a.ID)
	return err
}

// removeAccount deletes the account row and what hangs on it; the contacts
// imported for it lose their names like those of an erased owner.
func (e *Engine) removeAccount(ctx context.Context, a *accountRow) error {
	return pgx.BeginFunc(ctx, e.db.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE users u SET username = 'deleted_' || u.id, name = '', bio = '', photo_file_id = NULL, deleted_at = now(), updated_at = now()
			FROM external_users eu WHERE eu.account_id = $1 AND u.id = eu.user_id AND u.deleted_at IS NULL`, a.ID); err != nil {
			return fmt.Errorf("bridge: erase contacts: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM external_accounts WHERE id = $1`, a.ID); err != nil {
			return fmt.Errorf("bridge: delete account: %w", err)
		}
		return nil
	})
}

// canSend reports whether the adapter of source can be written to.
func (e *Engine) canSend(source string) bool {
	adapter := e.adapters[source]
	if adapter == nil {
		return false
	}
	_, ok := adapter.(bridge.Sender)
	return ok && adapter.Capabilities().Has(bridge.CapSend)
}

// canTopics reports whether the adapter of source reads topics.
func (e *Engine) canTopics(source string) bool {
	adapter := e.adapters[source]
	if adapter == nil {
		return false
	}
	_, ok := adapter.(bridge.TopicReader)
	return ok && adapter.Capabilities().Has(bridge.CapTopics)
}

// SetDirection switches a synced chat of owner's account between receiving
// only and also sending on what owner writes in Chat.
func (e *Engine) SetDirection(ctx context.Context, owner, accountID int64, conversationID, direction string) error {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return err
	}
	l, err := e.db.link(ctx, accountID, conversationID)
	if err != nil {
		return err
	}
	if l == nil {
		return ErrNotFound
	}
	if direction == chat.DirectionBoth && (!e.canSend(a.Source) || a.Status == "stopped") {
		return ErrSendUnsupported
	}
	return e.chat.SetImportedDirection(ctx, owner, l.ChatID, direction)
}

// OutboxItem is something a chat has queued for the app and not finished.
type OutboxItem struct {
	Seq       int64
	Op        string
	Status    string
	LastError string
	Attempts  int
}

// Outbox lists what the chat of owner has queued and not finished, oldest
// first, then the pins the other app refused (each listed only once). A chat that is not linked to an account of owner is ErrNotFound.
func (e *Engine) Outbox(ctx context.Context, owner, chatID int64) ([]OutboxItem, error) {
	var linked bool
	if err := e.db.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM external_chats x JOIN external_accounts a ON a.id = x.account_id WHERE x.chat_id = $1 AND a.owner_id = $2)`,
		chatID, owner).Scan(&linked); err != nil {
		return nil, fmt.Errorf("bridge: outbox owner: %w", err)
	}
	if !linked {
		return nil, ErrNotFound
	}
	rows, err := e.db.pool.Query(ctx, `
		SELECT seq, op, status, last_error, attempts FROM external_outbox
		WHERE chat_id = $1 AND op IN ('send', 'edit', 'delete') AND status IN ('pending', 'sending', 'failed', 'unknown') ORDER BY id`, chatID)
	if err != nil {
		return nil, fmt.Errorf("bridge: list outbox: %w", err)
	}
	scan := func(r pgx.CollectableRow) (OutboxItem, error) {
		var o OutboxItem
		err := r.Scan(&o.Seq, &o.Op, &o.Status, &o.LastError, &o.Attempts)
		return o, err
	}
	items, err := pgx.CollectRows(rows, scan)
	if err != nil {
		return nil, err
	}
	// A change of state the other app refused (a pin, a topic, the info of the group, the
	// state of the chat in the list) was already put back in Chat; the owner is told once
	// (the row is closed as it is listed), with the op that names it. For a topic, seq is
	// its id in the chat.
	refused, err := e.db.pool.Query(ctx, `
		UPDATE external_outbox SET status = 'cancelled', updated_at = now()
		WHERE chat_id = $1 AND op NOT IN ('send', 'edit', 'delete') AND status = 'failed'
		RETURNING seq, op, 'failed', last_error, attempts`, chatID)
	if err != nil {
		return nil, fmt.Errorf("bridge: list refused pins: %w", err)
	}
	pins, err := pgx.CollectRows(refused, scan)
	if err != nil {
		return nil, fmt.Errorf("bridge: list refused pins: %w", err)
	}
	return append(items, pins...), nil
}

// RetryMessage tries again what failed (or has an unknown result) for one
// message of a chat of owner. A send keeps its random id, so if the app did
// take it the retry finds it instead of making a second one. ErrNotFound when
// there is nothing to retry.
func (e *Engine) RetryMessage(ctx context.Context, owner, chatID, seq int64) error {
	tag, err := e.db.pool.Exec(ctx, `
		UPDATE external_outbox o SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '', updated_at = now()
		FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
		WHERE o.chat_id = $1 AND o.seq = $2 AND o.status IN ('failed', 'unknown')
			AND x.chat_id = o.chat_id AND x.direction = 'both' AND a.owner_id = $3 AND a.status = 'active'`, chatID, seq, owner)
	if err != nil {
		return fmt.Errorf("bridge: retry message: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DismissMessage gives up the failed edit or delete of one message of a chat
// of owner. A send is not dismissed: deleting the message gives it up.
func (e *Engine) DismissMessage(ctx context.Context, owner, chatID, seq int64) error {
	tag, err := e.db.pool.Exec(ctx, `
		UPDATE external_outbox o SET status = 'cancelled', updated_at = now()
		FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
		WHERE o.chat_id = $1 AND o.seq = $2 AND o.op IN ('edit', 'delete') AND o.status IN ('failed', 'unknown')
			AND x.chat_id = o.chat_id AND a.owner_id = $3`, chatID, seq, owner)
	if err != nil {
		return fmt.Errorf("bridge: dismiss message: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

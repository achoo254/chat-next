package engine

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"app.local/server/internal/bridge"
	"app.local/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// puppetNameMax is the longest puppet user name, in characters (as users.name).
const puppetNameMax = 64

// querier is what pgx pools and transactions share.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// accountRow is an external account as the engine reads it.
type accountRow struct {
	ID          int64
	OwnerID     int64
	Source      string
	Ref         string
	Status      string
	Secret      []byte
	UpdateState []byte
	// SyncState is off, syncing or live: whether every conversation is synced (ADR 0024).
	SyncState string
}

// chatLink is a synced conversation: the Chat chat it fills.
type chatLink struct {
	ID           int64
	AccountID    int64
	ExternalChat string
	ChatID       int64
	Kind         bridge.ConvKind
	HistoryMax   int
	BackfillDone bool
	Title        string
	// Direction is chat.DirectionIn or chat.DirectionBoth.
	Direction string
	// Forum is true when the Chat chat is split into topics (the copy of a
	// forum conversation made with an adapter that reads topics).
	Forum bool
}

// messageKey is what the other app calls a message.
type messageKey struct {
	account int64
	chat    string
	msg     string
}

// importedMessage is a row of external_messages.
type importedMessage struct {
	ChatID  int64
	Seq     int64
	Version int64
	// ExternalChat is the conversation the message belongs to.
	ExternalChat string
}

// db is the engine's access to the external_* tables.
type db struct {
	pool     *pgxpool.Pool
	tenantID string
}

func (d *db) loadAccount(ctx context.Context, id int64) (*accountRow, error) {
	a := &accountRow{}
	err := d.pool.QueryRow(ctx, `
		SELECT id, owner_id, source, external_ref, status, secret, update_state, sync_state FROM external_accounts WHERE id = $1`, id).
		Scan(&a.ID, &a.OwnerID, &a.Source, &a.Ref, &a.Status, &a.Secret, &a.UpdateState, &a.SyncState)
	if err != nil {
		return nil, fmt.Errorf("bridge: load account: %w", err)
	}
	return a, nil
}

// activeAccountIDs lists the accounts that should be connected.
func (d *db) activeAccountIDs(ctx context.Context) ([]int64, error) {
	rows, err := d.pool.Query(ctx, `SELECT id FROM external_accounts WHERE status = 'active' ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("bridge: list accounts: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[int64])
}

// claimLease takes the account's single connection for ttl, or renews it
// when holder already has it. It reports whether holder now holds it.
func (d *db) claimLease(ctx context.Context, id int64, holder string, ttl time.Duration) (bool, error) {
	tag, err := d.pool.Exec(ctx, `
		UPDATE external_accounts SET lease_holder = $2, lease_until = now() + make_interval(secs => $3)
		WHERE id = $1 AND status = 'active' AND (lease_holder = $2 OR lease_until IS NULL OR lease_until < now())`,
		id, holder, ttl.Seconds())
	if err != nil {
		return false, fmt.Errorf("bridge: claim lease: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (d *db) releaseLease(ctx context.Context, id int64, holder string) {
	_, _ = d.pool.Exec(ctx, `UPDATE external_accounts SET lease_until = NULL, lease_holder = NULL WHERE id = $1 AND lease_holder = $2`, id, holder)
}

func (d *db) setStatus(ctx context.Context, id int64, status, lastError string) error {
	if len(lastError) > 512 {
		lastError = lastError[:512]
	}
	lastError = strings.ToValidUTF8(lastError, "")
	_, err := d.pool.Exec(ctx, `UPDATE external_accounts SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, id, status, lastError)
	if err != nil {
		return fmt.Errorf("bridge: set status: %w", err)
	}
	return nil
}

// saveState stores the adapter's update state; inside an import
// transaction it commits or rolls back with the message it follows.
func saveState(ctx context.Context, q querier, accountID int64, state []byte) error {
	if state == nil {
		return nil
	}
	if _, err := q.Exec(ctx, `UPDATE external_accounts SET update_state = $2, updated_at = now() WHERE id = $1`, accountID, state); err != nil {
		return fmt.Errorf("bridge: save update state: %w", err)
	}
	return nil
}

func (d *db) links(ctx context.Context, accountID int64) ([]*chatLink, error) {
	rows, err := d.pool.Query(ctx, `
		SELECT id, account_id, external_chat_id, chat_id, history_window, backfill_done, title, direction,
			coalesce((SELECT forum FROM chats WHERE id = external_chats.chat_id), false) FROM external_chats
		WHERE account_id = $1 ORDER BY id`, accountID)
	if err != nil {
		return nil, fmt.Errorf("bridge: list synced chats: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (*chatLink, error) {
		l := &chatLink{}
		err := r.Scan(&l.ID, &l.AccountID, &l.ExternalChat, &l.ChatID, &l.HistoryMax, &l.BackfillDone, &l.Title, &l.Direction, &l.Forum)
		return l, err
	})
}

func (d *db) link(ctx context.Context, accountID int64, externalChat string) (*chatLink, error) {
	l := &chatLink{}
	err := d.pool.QueryRow(ctx, `
		SELECT id, account_id, external_chat_id, chat_id, history_window, backfill_done, title, direction,
			coalesce((SELECT forum FROM chats WHERE id = external_chats.chat_id), false) FROM external_chats
		WHERE account_id = $1 AND external_chat_id = $2`, accountID, externalChat).
		Scan(&l.ID, &l.AccountID, &l.ExternalChat, &l.ChatID, &l.HistoryMax, &l.BackfillDone, &l.Title, &l.Direction, &l.Forum)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("bridge: load synced chat: %w", err)
	}
	return l, nil
}

func (d *db) finishBackfill(ctx context.Context, linkID int64, cursor string) error {
	_, err := d.pool.Exec(ctx, `UPDATE external_chats SET backfill_done = true, backfill_cursor = $2 WHERE id = $1`, linkID, cursor)
	if err != nil {
		return fmt.Errorf("bridge: finish backfill: %w", err)
	}
	return nil
}

// lookupMessage finds an imported message. chat may be empty to look the id
// up in any conversation of the account (a delete that names no chat).
func lookupMessage(ctx context.Context, q querier, account int64, chat, msg string) (*importedMessage, error) {
	m := &importedMessage{}
	var err error
	if chat == "" {
		err = q.QueryRow(ctx, `
			SELECT chat_id, seq, source_edit_version, external_chat_id FROM external_messages
			WHERE account_id = $1 AND external_msg_id = $2 LIMIT 1`, account, msg).Scan(&m.ChatID, &m.Seq, &m.Version, &m.ExternalChat)
	} else {
		err = q.QueryRow(ctx, `
			SELECT chat_id, seq, source_edit_version, external_chat_id FROM external_messages
			WHERE account_id = $1 AND external_chat_id = $2 AND external_msg_id = $3`, account, chat, msg).
			Scan(&m.ChatID, &m.Seq, &m.Version, &m.ExternalChat)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("bridge: look up message: %w", err)
	}
	return m, nil
}

// newestSeqUpTo is the seq of the newest imported message of conv whose
// external id, a decimal integer, is at most maxID; 0 when there is none or
// maxID is not a number.
func newestSeqUpTo(ctx context.Context, q querier, account int64, conv, maxID string) (int64, error) {
	upTo, err := strconv.ParseInt(maxID, 10, 64)
	if err != nil {
		return 0, nil
	}
	var seq int64
	err = q.QueryRow(ctx, `
		SELECT coalesce(max(seq), 0) FROM external_messages
		WHERE account_id = $1 AND external_chat_id = $2 AND external_msg_id ~ '^[0-9]{1,18}$'
			AND external_msg_id::bigint <= $3`, account, conv, upTo).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("bridge: newest read message: %w", err)
	}
	return seq, nil
}

// knownMessages returns which of ids are already imported into chat.
func knownMessages(ctx context.Context, q querier, account int64, chat string, ids []string) (map[string]bool, error) {
	rows, err := q.Query(ctx, `SELECT external_msg_id FROM external_messages WHERE account_id = $1 AND external_chat_id = $2 AND external_msg_id = ANY($3)`,
		account, chat, ids)
	if err != nil {
		return nil, fmt.Errorf("bridge: known messages: %w", err)
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("bridge: known messages: %w", err)
	}
	out := make(map[string]bool, len(list))
	for _, id := range list {
		out[id] = true
	}
	return out, nil
}

func insertMessage(ctx context.Context, q querier, k messageKey, chatID, seq, version int64, replyTo string) error {
	_, err := q.Exec(ctx, `
		INSERT INTO external_messages (account_id, external_chat_id, external_msg_id, chat_id, seq, source_edit_version, external_reply_to)
		VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`, k.account, k.chat, k.msg, chatID, seq, version, replyTo)
	if err != nil {
		return fmt.Errorf("bridge: record message: %w", err)
	}
	return nil
}

func setVersion(ctx context.Context, q querier, k messageKey, version int64) error {
	_, err := q.Exec(ctx, `UPDATE external_messages SET source_edit_version = $4 WHERE account_id = $1 AND external_chat_id = $2 AND external_msg_id = $3`,
		k.account, k.chat, k.msg, version)
	if err != nil {
		return fmt.Errorf("bridge: record version: %w", err)
	}
	return nil
}

// tombstoned reports whether a delete for the message arrived first, and
// forgets it (the message is then dropped, once).
func tombstoned(ctx context.Context, q querier, k messageKey) (bool, error) {
	tag, err := q.Exec(ctx, `
		DELETE FROM external_tombstones WHERE account_id = $1 AND external_msg_id = $3 AND external_chat_id IN ($2, '')`,
		k.account, k.chat, k.msg)
	if err != nil {
		return false, fmt.Errorf("bridge: check tombstone: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

func addTombstone(ctx context.Context, q querier, k messageKey) error {
	_, err := q.Exec(ctx, `INSERT INTO external_tombstones (account_id, external_chat_id, external_msg_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		k.account, k.chat, k.msg)
	if err != nil {
		return fmt.Errorf("bridge: record delete: %w", err)
	}
	return nil
}

// pendingReplies finds the messages that reply to a message that had not
// arrived, and clears the wait.
func pendingReplies(ctx context.Context, q querier, k messageKey) ([]int64, error) {
	rows, err := q.Query(ctx, `
		UPDATE external_messages SET external_reply_to = ''
		WHERE account_id = $1 AND external_chat_id = $2 AND external_reply_to = $3 RETURNING seq`, k.account, k.chat, k.msg)
	if err != nil {
		return nil, fmt.Errorf("bridge: pending replies: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[int64])
}

// earliestImported is the date of the oldest live imported message of a
// chat; zero for a chat with none.
func earliestImported(ctx context.Context, q querier, chatID int64) (time.Time, error) {
	var t *time.Time
	if err := q.QueryRow(ctx, `
		SELECT min(m.date) FROM messages m JOIN external_messages e ON e.chat_id = m.chat_id AND e.seq = m.seq
		WHERE m.chat_id = $1 AND m.deleted_at IS NULL`, chatID).Scan(&t); err != nil {
		return time.Time{}, fmt.Errorf("bridge: earliest imported: %w", err)
	}
	if t == nil {
		return time.Time{}, nil
	}
	return *t, nil
}

// ensurePuppet returns the Chat user standing for participant p of the
// account: the owner for the owner's own messages, otherwise a puppet user,
// created on first sight and renamed when the other app renames them.
func (d *db) ensurePuppet(ctx context.Context, a *accountRow, p bridge.Participant) (int64, error) {
	if p.IsSelf {
		return a.OwnerID, nil
	}
	name := cleanName(p.Name)
	for range 2 {
		var id int64
		var current string
		err := d.pool.QueryRow(ctx, `
			SELECT u.id, u.name FROM external_users x JOIN users u ON u.id = x.user_id
			WHERE x.account_id = $1 AND x.external_user_id = $2`, a.ID, p.ID).Scan(&id, &current)
		if err == nil {
			if current != name && !p.NameUnknown {
				if _, err := d.pool.Exec(ctx, `UPDATE users SET name = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, id, name); err != nil {
					return 0, fmt.Errorf("bridge: rename puppet: %w", err)
				}
			}
			return id, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("bridge: find puppet: %w", err)
		}
		id, err = d.createPuppet(ctx, a, p, name)
		if err == nil {
			return id, nil
		}
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "23505" {
			return 0, err
		}
		// A concurrent call made it first: read it.
	}
	return 0, errors.New("bridge: puppet user kept vanishing")
}

// createPuppet never sets users.is_bot, even for a bot of the other app:
// that flag means a bot of this system (a bots row, consent, Bot API), which
// a puppet is not.
func (d *db) createPuppet(ctx context.Context, a *accountRow, p bridge.Participant, name string) (int64, error) {
	var id int64
	err := pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		var err error
		if id, err = store.NextUserID(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (id, tenant_id, idp_sub, username, name, external_source)
			VALUES ($1, $2, NULL, $3, $4, $5)`, id, d.tenantID, fmt.Sprintf("ext_%d", id), name, a.Source); err != nil {
			return fmt.Errorf("bridge: create puppet: %w", err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO external_users (account_id, external_user_id, user_id) VALUES ($1, $2, $3)`, a.ID, p.ID, id)
		if err != nil {
			return fmt.Errorf("bridge: link puppet: %w", err)
		}
		return nil
	})
	return id, err
}

// cleanName makes a contact's display name fit users.name: no control
// characters, trimmed, at most puppetNameMax characters, never empty.
func cleanName(name string) string {
	name = strings.ToValidUTF8(name, "")
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > puppetNameMax {
		name = string([]rune(name)[:puppetNameMax])
	}
	if name == "" {
		return "?"
	}
	return name
}

// lookupTopic finds the Chat topic that stands for a topic of the other app.
func lookupTopic(ctx context.Context, q querier, account int64, chat, ext string) (int64, bool, error) {
	var id int64
	err := q.QueryRow(ctx, `SELECT topic_id FROM external_topics WHERE account_id = $1 AND external_chat_id = $2 AND external_topic_id = $3`,
		account, chat, ext).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("bridge: look up topic: %w", err)
	}
	return id, true, nil
}

// externalTopic is the id the other app gives a Chat topic, if it has one.
func externalTopic(ctx context.Context, q querier, account int64, chat string, topicID int64) (string, bool, error) {
	var ext string
	err := q.QueryRow(ctx, `SELECT external_topic_id FROM external_topics WHERE account_id = $1 AND external_chat_id = $2 AND topic_id = $3`,
		account, chat, topicID).Scan(&ext)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("bridge: look up external topic: %w", err)
	}
	return ext, true, nil
}

func insertTopic(ctx context.Context, q querier, account int64, chat, ext string, topicID int64) error {
	_, err := q.Exec(ctx, `
		INSERT INTO external_topics (account_id, external_chat_id, external_topic_id, topic_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
		account, chat, ext, topicID)
	if err != nil {
		return fmt.Errorf("bridge: record topic: %w", err)
	}
	return nil
}

// unmappedTopics returns which of ids the chat does not have a topic for yet.
func unmappedTopics(ctx context.Context, q querier, account int64, chat string, ids []string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT external_topic_id FROM external_topics WHERE account_id = $1 AND external_chat_id = $2 AND external_topic_id = ANY($3)`,
		account, chat, ids)
	if err != nil {
		return nil, fmt.Errorf("bridge: known topics: %w", err)
	}
	known, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("bridge: known topics: %w", err)
	}
	have := make(map[string]bool, len(known))
	for _, k := range known {
		have[k] = true
	}
	var out []string
	for _, id := range ids {
		if !have[id] {
			out = append(out, id)
		}
	}
	return out, nil
}

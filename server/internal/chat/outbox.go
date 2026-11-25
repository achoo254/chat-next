package chat

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/media"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// The outbox is what Chat sends to the app a chat is linked to (ADR 0022).
// Rows are written here, in the transaction of the message, edit or delete,
// and worked off by the bridge engine; nothing in this file talks to the
// other app. Only a chat linked with direction 'both' to an account of the
// sender queues anything, and only for the sender's own messages.

// Directions of external_chats.direction.
const (
	// DirectionIn: the other app is the source; Chat refuses to send.
	DirectionIn = "in"
	// DirectionBoth: what the owner writes in Chat is sent on.
	DirectionBoth = "both"
)

// outboundLink is where the messages of one user in one chat go.
type outboundLink struct {
	accountID  int64
	externalID string
}

// outboundLink returns the link of chatID if me owns an active external
// account the chat is linked to and the feature goes out to it for this chat
// (for messages: direction 'both'; for the others see FeatureDirection); nil
// otherwise.
func (t *txn) outboundLink(ctx context.Context, chatID, me int64, feat feature.Feature) (*outboundLink, error) {
	var l outboundLink
	var messages string
	var override *string
	err := t.tx.QueryRow(ctx, `
		SELECT x.account_id, x.external_chat_id, x.direction, f.direction
		FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
		LEFT JOIN external_chat_features f ON f.account_id = x.account_id AND f.external_chat_id = x.external_chat_id AND f.feature = $3
		WHERE x.chat_id = $1 AND a.owner_id = $2 AND a.status <> 'stopped'`, chatID, me, string(feat)).Scan(&l.accountID, &l.externalID, &messages, &override)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("chat: outbound link: %w", err)
	}
	if !FeatureDirection(feat, messages, override).Sends() {
		return nil, nil
	}
	return &l, nil
}

// randomSendID returns an id in [1, 2^63) for the other app to recognise a
// repeated send by.
func randomSendID() int64 {
	var b [8]byte
	for {
		_, _ = rand.Read(b[:]) // crypto/rand.Read never fails
		if v := int64(binary.BigEndian.Uint64(b[:]) &^ (1 << 63)); v != 0 {
			return v
		}
	}
}

// queueSend queues the message just posted by me, if it goes to another app.
func (t *txn) queueSend(ctx context.Context, chatID, me, seq int64) error {
	l, err := t.outboundLink(ctx, chatID, me, feature.Messages)
	if err != nil || l == nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature, random_id)
		VALUES ($1, $2, $3, $4, 'send', 'messages', $5)`, l.accountID, l.externalID, chatID, seq, randomSendID()); err != nil {
		return fmt.Errorf("chat: queue send: %w", err)
	}
	return nil
}

// queueForward queues a message me forwarded or copied into chatID, if it goes to
// another app. A forward records the message it came from (fromChat, fromSeq).
func (t *txn) queueForward(ctx context.Context, chatID, me, seq, fromChat, fromSeq int64, forward bool) error {
	if !forward {
		return t.queueSend(ctx, chatID, me, seq)
	}
	l, err := t.outboundLink(ctx, chatID, me, feature.Messages)
	if err != nil || l == nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature, random_id, payload)
		VALUES ($1, $2, $3, $4, 'send', 'messages', $5, jsonb_build_object('from_chat', $6::bigint, 'from_seq', $7::bigint))`,
		l.accountID, l.externalID, chatID, seq, randomSendID(), fromChat, fromSeq); err != nil {
		return fmt.Errorf("chat: queue forward: %w", err)
	}
	return nil
}

// queueEdit queues the new text of a message of me. A message still waiting
// to be sent needs no edit row: it is sent as it is now.
func (t *txn) queueEdit(ctx context.Context, chatID, me, seq int64) error {
	l, err := t.outboundLink(ctx, chatID, me, feature.Messages)
	if err != nil || l == nil {
		return err
	}
	var reachable bool
	if err := t.tx.QueryRow(ctx, `
		SELECT NOT EXISTS (SELECT 1 FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = 'send' AND status IN ('pending', 'failed', 'unknown'))
			AND (EXISTS (SELECT 1 FROM external_messages WHERE chat_id = $1 AND seq = $2)
				OR EXISTS (SELECT 1 FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = 'send' AND status = 'sending'))`,
		chatID, seq).Scan(&reachable); err != nil {
		return fmt.Errorf("chat: queue edit: %w", err)
	}
	if !reachable {
		return nil
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature) VALUES ($1, $2, $3, $4, 'edit', 'messages')
		ON CONFLICT (chat_id, seq, op) DO UPDATE
			SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '', updated_at = now()`,
		l.accountID, l.externalID, chatID, seq); err != nil {
		return fmt.Errorf("chat: queue edit: %w", err)
	}
	return nil
}

// queueDeletes handles messages of me just deleted for everyone: a send that
// has not gone out is cancelled (there is nothing to delete over there), and
// one that has gone, or is going, gets a delete row.
func (t *txn) queueDeletes(ctx context.Context, chatID, me int64, seqs []int64) error {
	l, err := t.outboundLink(ctx, chatID, me, feature.Messages)
	if err != nil || l == nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `
		UPDATE external_outbox SET status = 'cancelled', updated_at = now()
		WHERE chat_id = $1 AND seq = ANY($2) AND status IN ('pending', 'failed', 'unknown')
			AND op IN ('send', 'edit')`, chatID, seqs); err != nil {
		return fmt.Errorf("chat: cancel queued: %w", err)
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature)
		SELECT $1, $2, m.chat_id, m.seq, 'delete', 'messages' FROM messages m
		WHERE m.chat_id = $3 AND m.seq = ANY($4) AND m.from_id = $5 AND m.deleted_at IS NOT NULL
			AND (EXISTS (SELECT 1 FROM external_messages e WHERE e.chat_id = m.chat_id AND e.seq = m.seq)
				OR EXISTS (SELECT 1 FROM external_outbox o WHERE o.chat_id = m.chat_id AND o.seq = m.seq
					AND o.op = 'send' AND o.status IN ('sending', 'sent')))
		ON CONFLICT (chat_id, seq, op) DO UPDATE
			SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '', updated_at = now()`,
		l.accountID, l.externalID, chatID, seqs, me); err != nil {
		return fmt.Errorf("chat: queue delete: %w", err)
	}
	return nil
}

// composerKey marks the context of a send the user typed in Chat's composer.
type composerKey struct{}

// FromComposer marks ctx as the send of a text the user typed, or a file the user
// attached, in Chat's message composer: only the RPCs the apps' composers call
// set it (SendMessage, SendMedia, SendAlbum over /rpc), never a tool, an agent or
// any other caller, so a new caller is not taken for the composer.
func FromComposer(ctx context.Context) context.Context {
	return context.WithValue(ctx, composerKey{}, true)
}

// notFromComposer drops the mark of FromComposer.
func notFromComposer(ctx context.Context) context.Context {
	return context.WithValue(ctx, composerKey{}, false)
}

func fromComposer(ctx context.Context) bool {
	typed, _ := ctx.Value(composerKey{}).(bool)
	return typed
}

// SetComposerOnlyApps names the apps whose linked chats take only what the owner
// types or attaches in Chat's composer (FromComposer): their adapter cannot recognise a
// repeated send on its own (bridge.RetryUnsafe), so nothing is sent from the
// owner's account there that the owner did not write by hand. Call it before
// serving.
func (s *Service) SetComposerOnlyApps(apps []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.composerOnly = make(map[string]bool, len(apps))
	for _, app := range apps {
		s.composerOnly[app] = true
	}
}

// composerOnlyApp reports whether a chat linked to app takes only composer text.
func (s *Service) composerOnlyApp(app string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.composerOnly[app]
}

// linkedSendRule is the gate of a chat linked to another app. plain is a
// text or media message, a forward or a copy from its own user (not a bot's, not
// an inline result, not a service message): the only kind that can be sent on.
// composerOnly says whether an app takes only text typed in the composer.
func linkedSendRule(ctx context.Context, q querier, chatID, me int64, plain bool, composerOnly func(app string) bool) error {
	var direction, status, app string
	var owner int64
	err := q.QueryRow(ctx, `
		SELECT x.direction, a.owner_id, a.status, a.source FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
		WHERE x.chat_id = $1`, chatID).Scan(&direction, &owner, &status, &app)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("chat: check imported chat: %w", err)
	}
	switch {
	case direction != DirectionBoth:
		return errDenied("imported_chat_read_only: this chat is a copy of a chat in another app; sending into it is not available")
	case status == "stopped":
		return errDenied("imported_chat_read_only: the account of this chat is disconnected; sending into it is not available")
	case !plain || me != owner:
		return errDenied("imported_chat_send_unsupported: only your own text and files can be sent on to the other app")
	case composerOnly(app) && !fromComposer(ctx):
		return errComposerOnly()
	}
	return nil
}

// errComposerOnly refuses, in a chat of a composer-only app, anything the owner did
// not type or attach in Chat's composer.
func errComposerOnly() error {
	return errDenied("imported_chat_composer_only: this chat only takes what you type or attach in Chat; forwards, copies, files of other messages and messages sent by tools or agents are not sent to the other app")
}

// composerFileRule is the gate of a file attached to a message for chatID: a chat of
// a composer-only app takes only a file the owner uploaded, not one reused from a
// message they can see (forwarding by file_id), whatever the caller marked.
func composerFileRule(ctx context.Context, q querier, chatID, me int64, f *media.File, composerOnly func(app string) bool) error {
	if f.OwnerID == me {
		return nil
	}
	var app string
	err := q.QueryRow(ctx, `
		SELECT a.source FROM external_chats x JOIN external_accounts a ON a.id = x.account_id WHERE x.chat_id = $1`, chatID).Scan(&app)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("chat: check imported chat: %w", err)
	}
	if composerOnly(app) {
		return errComposerOnly()
	}
	return nil
}

// SetImportedDirection switches a chat the bridge filled between receiving
// only (DirectionIn) and sending on what the owner writes (DirectionBoth).
// Only the owner of the account may. Going back to DirectionIn cancels what
// is queued and not yet gone out. The change is logged: it widens (or
// narrows) what a signed-in session can do in the other app.
func (s *Service) SetImportedDirection(ctx context.Context, owner, chatID int64, direction string) error {
	if direction != DirectionIn && direction != DirectionBoth {
		return errInvalid("direction must be %q or %q", DirectionIn, DirectionBoth)
	}
	_, err := s.inTx(ctx, func(t *txn) error {
		var previous string
		err := t.tx.QueryRow(ctx, `
			SELECT x.direction FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
			WHERE x.chat_id = $1 AND a.owner_id = $2 FOR UPDATE OF x`, chatID, owner).Scan(&previous)
		if isNoRows(err) {
			return errNotFound("chat")
		}
		if err != nil {
			return fmt.Errorf("chat: imported chat: %w", err)
		}
		if previous == direction {
			return nil
		}
		if _, err := t.tx.Exec(ctx, `UPDATE external_chats SET direction = $2 WHERE chat_id = $1`, chatID, direction); err != nil {
			return fmt.Errorf("chat: set direction: %w", err)
		}
		if direction == DirectionIn {
			if err := cancelQueued(ctx, t.tx, chatID); err != nil {
				return err
			}
		}
		s.logger.Info("imported chat direction changed", "chat_id", chatID, "owner_id", owner, "from", previous, "to", direction)
		// The chat reads and writes differently now (a read-only copy has no right to send): the
		// owner's open sessions are told, so a composer gives way to the note or comes back.
		c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+`
			WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF c`, chatID, s.cfg.TenantID))
		if isNoRows(err) {
			return nil // its copy was deleted: nobody is looking at it
		}
		if err != nil {
			return fmt.Errorf("chat: load imported chat: %w", err)
		}
		return t.chatChanged(ctx, c, owner)
	})
	return err
}

// cancelQueued cancels what a chat has queued and not yet sent on.
func cancelQueued(ctx context.Context, tx pgx.Tx, chatID int64) error {
	if _, err := tx.Exec(ctx, `
		UPDATE external_outbox SET status = 'cancelled', updated_at = now()
		WHERE chat_id = $1 AND status IN ('pending', 'failed', 'unknown')`, chatID); err != nil {
		return fmt.Errorf("chat: cancel queued: %w", err)
	}
	return nil
}

// Outbound is a message of Chat as the bridge sends it to another app.
type Outbound struct {
	FromID   int64
	Text     string
	Entities []*appv1.MessageEntity
	// FileID is the public id of the attached file; empty for a text message.
	FileID string
	// ReplyToSeq is the message answered; 0 for none.
	ReplyToSeq int64
	// GroupedID is shared by the items of one album; 0 for none.
	GroupedID int64
	// TopicID is the topic of the message in a forum chat; 0 outside forums.
	TopicID int64
	// Deleted is true once the message was deleted for everyone.
	Deleted bool
}

// OutboundMessage reads a message for the bridge to send, or nil when there
// is no such message. The sender reads at send time, so what goes out is
// what the message says then.
func (s *Service) OutboundMessage(ctx context.Context, chatID, seq int64) (*Outbound, error) {
	var (
		o       Outbound
		content []byte
	)
	err := s.pool.QueryRow(ctx, `
		SELECT from_id, text, content, reply_to_seq, grouped_id, topic_id, deleted_at IS NOT NULL FROM messages WHERE chat_id = $1 AND seq = $2`,
		chatID, seq).Scan(&o.FromID, &o.Text, &content, &o.ReplyToSeq, &o.GroupedID, &o.TopicID, &o.Deleted)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("chat: read outbound message: %w", err)
	}
	if len(content) > 0 {
		var c appv1.Message
		if err := proto.Unmarshal(content, &c); err != nil {
			return nil, fmt.Errorf("chat: decode outbound message: %w", err)
		}
		o.Entities = c.GetEntities()
		o.FileID = c.GetMedia().GetFileId()
	}
	return &o, nil
}

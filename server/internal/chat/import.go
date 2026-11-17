package chat

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// importBatchMax bounds the messages of one Append: a transaction holds the
// chat row's lock for its whole length.
const importBatchMax = 500

// ErrImportChatGone reports that the chat an import writes into is deleted,
// unknown or not one the import may write to. It is permanent: the bridge
// stops syncing that chat instead of retrying.
var ErrImportChatGone = errors.New("chat: import target is gone")

// ImportMessage is a message of another app, already mapped to Chat ids.
type ImportMessage struct {
	// FromID is the puppet user of the sender, or the owner for the owner's
	// own messages.
	FromID int64
	// Date is when it was sent in the other app (never after now).
	Date time.Time
	Text string
	// Entities are exactly the spans the other app sent; nothing is detected
	// in the plain text.
	Entities []*appv1.MessageEntity
	// ReplyToSeq is the seq of the replied message in this chat, 0 for none.
	ReplyToSeq int64
	// Content carries parts the text cannot (media); its entities and silent
	// flag are replaced.
	Content *appv1.Message
}

// ImportTx is a transaction on one chat the bridge fills with messages of
// another app. The chat row is locked, so an import is serialized with
// every other write into the chat.
type ImportTx struct {
	t     *txn
	c     *chatRow
	owner int64
}

// Tx is the transaction, for the caller's own tables.
func (it *ImportTx) Tx() pgx.Tx { return it.t.tx }

// ChatID is the locked chat.
func (it *ImportTx) ChatID() int64 { return it.c.ID }

// WithImport runs fn in a transaction holding the lock of chatID, a live
// private, group or channel chat of the tenant that owner is a member of
// (ErrImportChatGone otherwise). A serialization failure retries fn.
func (s *Service) WithImport(ctx context.Context, chatID, owner int64, fn func(*ImportTx) error) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+`
			WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF c`, chatID, s.cfg.TenantID))
		if isNoRows(err) {
			return ErrImportChatGone
		}
		if err != nil {
			return fmt.Errorf("chat: load chat: %w", err)
		}
		if c.Type != typePrivate && c.Type != typeGroup && c.Type != typeChannel {
			return ErrImportChatGone
		}
		var member bool
		if err := t.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL)`,
			chatID, owner).Scan(&member); err != nil {
			return fmt.Errorf("chat: import owner: %w", err)
		}
		if !member {
			return ErrImportChatGone
		}
		return fn(&ImportTx{t: t, c: c, owner: owner})
	})
	return err
}

// content validates msg and returns the stored text and content. Mentions
// of users who are not members of the chat are dropped, not rejected: the
// text still reads right and one odd span must not stop an import.
func (it *ImportTx) content(ctx context.Context, msg ImportMessage) (string, *appv1.Message, error) {
	content := &appv1.Message{}
	if msg.Content != nil {
		content = &appv1.Message{Media: msg.Content.GetMedia()}
	}
	hasMedia := len(media.MessageFiles(content)) > 0
	text, ents, err := it.t.s.validateEntities(msg.Text, msg.Entities, hasMedia)
	if err != nil {
		return "", nil, err
	}
	if ents, err = it.keepMemberMentions(ctx, ents); err != nil {
		return "", nil, err
	}
	content.Entities = ents
	content.Silent = true
	return text, content, nil
}

func (it *ImportTx) keepMemberMentions(ctx context.Context, ents []*appv1.MessageEntity) ([]*appv1.MessageEntity, error) {
	ids := mentionedUsers(ents, 0)
	if len(ids) == 0 {
		return ents, nil
	}
	rows, err := it.t.tx.Query(ctx, `SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id = ANY($2) AND left_at IS NULL`, it.c.ID, ids)
	if err != nil {
		return nil, fmt.Errorf("chat: mentioned members: %w", err)
	}
	members, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: mentioned members: %w", err)
	}
	ok := make(map[int64]bool, len(members))
	for _, id := range members {
		ok[id] = true
	}
	out := make([]*appv1.MessageEntity, 0, len(ents))
	for _, e := range ents {
		if e.GetType() == appv1.EntityType_ENTITY_TYPE_MENTION_NAME && !ok[e.GetUserId()] {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// Append stores msgs, oldest first, as new messages of the chat and returns
// their seqs in the same order. Each keeps its original date; the chat keeps
// the date of its newest message. Messages are silent (no push) and the
// owner's read position moves to the newest, so an import adds no unread.
// Only the owner gets an update: puppet users have no log.
func (it *ImportTx) Append(ctx context.Context, msgs []ImportMessage) ([]int64, error) {
	if len(msgs) == 0 {
		return nil, nil
	}
	if len(msgs) > importBatchMax {
		return nil, errInvalid("an import batch holds at most %d messages", importBatchMax)
	}
	members, err := it.t.fanoutMembers(ctx, it.c)
	if err != nil {
		return nil, err
	}
	seqs := make([]int64, len(msgs))
	for i, msg := range msgs {
		text, content, err := it.content(ctx, msg)
		if err != nil {
			return nil, err
		}
		if err := it.t.s.checkReply(ctx, it.t.tx, it.c.ID, msg.ReplyToSeq); err != nil {
			return nil, err
		}
		ev := it.t.event(kindMessageNew, it.c.ID, msg.FromID)
		posted, err := it.t.postMessage(ctx, ev, it.c, members, newMessage{
			fromID: msg.FromID, replyTo: msg.ReplyToSeq, text: text, content: content, date: msg.Date,
		})
		if err != nil {
			return nil, err
		}
		seqs[i] = posted.Seq
	}
	if err := it.markOwnerRead(ctx); err != nil {
		return nil, err
	}
	return seqs, nil
}

// markOwnerRead moves the owner's read position to the newest message.
func (it *ImportTx) markOwnerRead(ctx context.Context) error {
	if _, err := it.t.tx.Exec(ctx, `
		INSERT INTO chat_read_states (chat_id, user_id, topic_id, read_inbox_max_seq) VALUES ($1, $2, 0, $3)
		ON CONFLICT (chat_id, user_id, topic_id) DO UPDATE
			SET read_inbox_max_seq = greatest(chat_read_states.read_inbox_max_seq, excluded.read_inbox_max_seq), updated_at = now()`,
		it.c.ID, it.owner, it.c.LastSeq); err != nil {
		return fmt.Errorf("chat: import read position: %w", err)
	}
	return nil
}

// Edit replaces the content of the message at seq, marking it edited. It is
// not bound by authorship or the edit window: the other app decides. It
// reports false, changing nothing, when the message is gone or the content
// is unchanged.
func (it *ImportTx) Edit(ctx context.Context, seq int64, msg ImportMessage) (bool, error) {
	text, content, err := it.content(ctx, msg)
	if err != nil {
		return false, err
	}
	m, err := it.t.s.liveMessage(ctx, it.t.tx, it.c.ID, seq)
	if isNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if m.Text == text && sameContent(m.Content, content) {
		return false, nil
	}
	if err := it.t.rewriteMessage(ctx, it.c, 0, m, text, content, true, false); err != nil {
		return false, err
	}
	return true, nil
}

// Delete removes the messages at seqs for everyone (silently skipping the
// ones already gone).
func (it *ImportTx) Delete(ctx context.Context, seqs []int64) error {
	if len(seqs) == 0 {
		return nil
	}
	return it.t.deleteMessages(ctx, it.c, true, 0, seqs)
}

// SetReply points the message at seq to the message at replyTo, for a reply
// whose original arrived later. It changes nothing else (no edit mark).
func (it *ImportTx) SetReply(ctx context.Context, seq, replyTo int64) error {
	if _, err := it.t.tx.Exec(ctx, `UPDATE messages SET reply_to_seq = $3, changed_at = now()
		WHERE chat_id = $1 AND seq = $2 AND deleted_at IS NULL`, it.c.ID, seq, replyTo); err != nil {
		return fmt.Errorf("chat: set reply: %w", err)
	}
	return nil
}

// sameContent reports whether stored (the encoded content of a message)
// equals content, so an edit that changes nothing is not written.
func sameContent(stored []byte, content *appv1.Message) bool {
	var raw []byte
	if proto.Size(content) > 0 {
		var err error
		if raw, err = proto.Marshal(content); err != nil {
			return false
		}
	}
	return bytes.Equal(stored, raw)
}

// refuseReadOnlyImport denies sending into a chat the bridge fills from
// another app and that only receives (external_chats.direction = 'in').
// Sending back is a later step (ADR 0022).
func refuseReadOnlyImport(ctx context.Context, q querier, chatID int64) error {
	var readOnly bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM external_chats WHERE chat_id = $1 AND direction = 'in')`, chatID).Scan(&readOnly); err != nil {
		return fmt.Errorf("chat: check imported chat: %w", err)
	}
	if readOnly {
		return errDenied("imported_chat_read_only: this chat is a copy of a chat in another app; sending into it is not available")
	}
	return nil
}

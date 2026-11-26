package chat

import (
	"context"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge/feature"
	"github.com/jackc/pgx/v5"
)

// Mentions of a user stay unread until the user sees the message itself (as in Telegram),
// whatever their read position: unread_mentions_count counts them and the "@" button walks
// them oldest first (GetUnreadMentions), marking each read once shown (ReadMentions).

// unreadMentionsMax bounds GetUnreadMentions and ReadMentions.
const unreadMentionsMax = 100

// GetUnreadMentions lists the messages of a chat (or of one forum topic) that mention me
// and that I have not seen, oldest first.
func (s *Service) GetUnreadMentions(ctx context.Context, me, chatID, topicID int64) ([]int64, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	var topics []int64
	if topicID != 0 {
		if !c.Forum {
			return nil, errInvalid("this chat has no topics")
		}
		topics = []int64{topicID}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT mm.seq FROM message_mentions mm JOIN messages msg ON msg.chat_id = mm.chat_id AND msg.seq = mm.seq
		WHERE mm.user_id = $1 AND mm.chat_id = $2 AND NOT mm.read AND msg.from_id <> $1 AND msg.deleted_at IS NULL
			AND msg.seq > greatest($3::bigint, $4::bigint - 1) AND ($5::bigint[] IS NULL OR msg.topic_id = ANY($5))
			AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $1 AND h.chat_id = msg.chat_id AND h.seq = msg.seq)
		ORDER BY mm.seq LIMIT $6`, me, c.ID, m.JoinedSeq, m.VisibleFrom, topics, unreadMentionsMax)
	if err != nil {
		return nil, fmt.Errorf("chat: unread mentions: %w", err)
	}
	seqs, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: unread mentions: %w", err)
	}
	return seqs, nil
}

// ReadMentions marks my mentions in the given messages read: I saw them. My sessions get
// the new count; a chat synced with another app tells it too.
func (s *Service) ReadMentions(ctx context.Context, me, chatID int64, seqs []int64) (*appv1.SyncAck, error) {
	if len(seqs) == 0 || len(seqs) > unreadMentionsMax {
		return nil, errInvalid("between 1 and %d seqs", unreadMentionsMax)
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, false)
		if err != nil {
			return err
		}
		rows, err := t.tx.Query(ctx, `
			UPDATE message_mentions SET read = true
			WHERE user_id = $1 AND chat_id = $2 AND seq = ANY($3) AND NOT read
			RETURNING seq`, me, c.ID, seqs)
		if err != nil {
			return fmt.Errorf("chat: read mentions: %w", err)
		}
		read, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return fmt.Errorf("chat: read mentions: %w", err)
		}
		if len(read) == 0 {
			return nil
		}
		t.tellReadCounts(c, m)
		return t.queueMentionsRead(ctx, c.ID, me, read)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// tellReadCounts sends my sessions my read position with the counts as they are after this
// transaction (taken after pts allocation, as ReadHistory does), when only the counts moved.
func (t *txn) tellReadCounts(c *chatRow, m *memberRow) {
	inbox := &appv1.UpdateRead{ChatId: c.ID}
	ev := t.event(kindRead, c.ID, m.UserID)
	t.toUsers(ev, []int64{m.UserID}, &appv1.Update{Kind: &appv1.Update_Read{Read: inbox}})
	t.beforeWrite = append(t.beforeWrite, func(ctx context.Context) error {
		rs, err := t.s.readState(ctx, t.tx, c, m)
		if err != nil {
			return err
		}
		inbox.MaxSeq, inbox.UnreadCount, inbox.UnreadMentionsCount, inbox.TopSeq = rs.readInbox, rs.unread, rs.mentions, rs.topSeq
		if c.SyncMode == syncLarge {
			inbox.ChatPts = rs.chatPts
		}
		return nil
	})
}

// queueMentionsRead tells the other app of a synced chat that the owner saw these messages
// that mention them, one row per message.
func (t *txn) queueMentionsRead(ctx context.Context, chatID, me int64, seqs []int64) error {
	l, err := t.outboundLink(ctx, chatID, me, feature.Read)
	if err != nil || l == nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO external_outbox (account_id, external_chat_id, chat_id, seq, op, feature)
		SELECT $1, $2, $3, s, 'read_mention', 'read' FROM unnest($4::bigint[]) s
		ON CONFLICT (chat_id, seq, op) DO NOTHING`,
		l.accountID, l.externalID, chatID, seqs); err != nil {
		return fmt.Errorf("chat: queue mentions read: %w", err)
	}
	return nil
}

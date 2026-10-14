package chat

import (
	"context"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// generalTopicID is the default topic of a forum; messages posted without a
// topic land there.
const (
	generalTopicID    = 1
	generalTopicTitle = "General"
	iconColorMax      = 0xFFFFFF
)

type topicRow struct {
	ChatID    int64
	ID        int64
	Title     string
	IconColor int32
	CreatorID int64
	CreatedAt time.Time
	Pinned    bool
	Closed    bool
	Hidden    bool
	TopSeq    int64
}

const topicColumns = `t.chat_id, t.id, t.title, t.icon_color, t.creator_id, t.created_at, t.pinned, t.closed, t.hidden, t.top_seq`

func scanTopic(row pgx.Row) (*topicRow, error) {
	t := &topicRow{}
	err := row.Scan(&t.ChatID, &t.ID, &t.Title, &t.IconColor, &t.CreatorID, &t.CreatedAt, &t.Pinned, &t.Closed, &t.Hidden, &t.TopSeq)
	return t, err
}

func (t *topicRow) render() *appv1.ForumTopic {
	return &appv1.ForumTopic{
		ChatId: t.ChatID, Id: t.ID, Title: t.Title, IconColor: t.IconColor, CreatorId: t.CreatorID,
		CreatedAt: t.CreatedAt.Unix(), Pinned: t.Pinned, Closed: t.Closed, Hidden: t.Hidden, TopSeq: t.TopSeq,
	}
}

// createGeneralTopic adds the General topic to a chat whose row is locked.
func (t *txn) createGeneralTopic(ctx context.Context, c *chatRow, creator int64) error {
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO forum_topics (chat_id, id, title, creator_id, top_seq) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT DO NOTHING`, c.ID, generalTopicID, generalTopicTitle, creator, c.LastSeq); err != nil {
		return fmt.Errorf("chat: create General topic: %w", err)
	}
	if _, err := t.tx.Exec(ctx, `UPDATE chats SET last_topic_id = greatest(last_topic_id, $2) WHERE id = $1`, c.ID, generalTopicID); err != nil {
		return fmt.Errorf("chat: create General topic: %w", err)
	}
	c.LastTopicID = max(c.LastTopicID, generalTopicID)
	return nil
}

// enableForum turns topics on for a group: earlier messages and read
// positions move to General.
func (t *txn) enableForum(ctx context.Context, c *chatRow, actor int64) error {
	if err := t.createGeneralTopic(ctx, c, actor); err != nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `UPDATE messages SET topic_id = $2 WHERE chat_id = $1 AND topic_id = 0`, c.ID, generalTopicID); err != nil {
		return fmt.Errorf("chat: move messages to General: %w", err)
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO chat_read_states (chat_id, user_id, topic_id, read_inbox_max_seq)
		SELECT chat_id, user_id, $2, read_inbox_max_seq FROM chat_read_states WHERE chat_id = $1 AND topic_id = 0
		ORDER BY user_id
		ON CONFLICT DO NOTHING`, c.ID, generalTopicID); err != nil {
		return fmt.Errorf("chat: move read positions to General: %w", err)
	}
	c.Forum = true
	topic, err := scanTopic(t.tx.QueryRow(ctx, `SELECT `+topicColumns+` FROM forum_topics t WHERE t.chat_id = $1 AND t.id = $2`,
		c.ID, generalTopicID))
	if err != nil {
		return fmt.Errorf("chat: load General topic: %w", err)
	}
	return t.topicChanged(ctx, c, actor, topic)
}

func (t *txn) topicChanged(ctx context.Context, c *chatRow, actor int64, topic *topicRow) error {
	members, err := t.fanoutMembers(ctx, c)
	if err != nil {
		return err
	}
	ev := t.event(kindTopicChanged, c.ID, actor)
	return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_TopicChanged{TopicChanged: &appv1.UpdateTopicChanged{
		Topic: topic.render(),
	}}})
}

// forumFor loads a forum chat for a member.
func (s *Service) forumFor(ctx context.Context, q querier, chatID, me int64, lock bool) (*chatRow, *memberRow, error) {
	c, m, err := s.activeChatFor(ctx, q, chatID, me, lock)
	if err != nil {
		return nil, nil, err
	}
	if !c.Forum {
		return nil, nil, errInvalid("this chat has no topics")
	}
	return c, m, nil
}

// GetForumTopics lists a forum's topics with my read state and their top
// messages.
func (s *Service) GetForumTopics(ctx context.Context, me, chatID int64) (*appv1.GetForumTopicsResponse, error) {
	c, m, err := s.forumFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+topicColumns+`, coalesce(r.read_inbox_max_seq, 0),
			(SELECT count(*) FROM messages msg
				WHERE msg.chat_id = t.chat_id AND msg.topic_id = t.id AND msg.from_id <> $2 AND msg.deleted_at IS NULL
					AND msg.seq > greatest(coalesce(r.read_inbox_max_seq, 0), $3, $4 - 1)
					AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $2 AND h.chat_id = msg.chat_id AND h.seq = msg.seq))
		FROM forum_topics t
		LEFT JOIN chat_read_states r ON r.chat_id = t.chat_id AND r.user_id = $2 AND r.topic_id = t.id
		WHERE t.chat_id = $1
		ORDER BY t.pinned DESC, t.top_seq DESC, t.id`, c.ID, me, m.JoinedSeq, m.VisibleFrom)
	if err != nil {
		return nil, fmt.Errorf("chat: list topics: %w", err)
	}
	defer rows.Close()
	resp := &appv1.GetForumTopicsResponse{}
	var tops []int64
	for rows.Next() {
		tr := &topicRow{}
		var read int64
		var unread int32
		if err := rows.Scan(&tr.ChatID, &tr.ID, &tr.Title, &tr.IconColor, &tr.CreatorID, &tr.CreatedAt, &tr.Pinned, &tr.Closed,
			&tr.Hidden, &tr.TopSeq, &read, &unread); err != nil {
			return nil, fmt.Errorf("chat: list topics: %w", err)
		}
		topic := tr.render()
		topic.ReadInboxMaxSeq, topic.UnreadCount = max(read, m.JoinedSeq), unread
		resp.Topics = append(resp.Topics, topic)
		if tr.TopSeq >= max(m.VisibleFrom, 1) {
			tops = append(tops, tr.TopSeq)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: list topics: %w", err)
	}
	rows.Close()
	msgs, err := loadMessages(ctx, s.pool, map[int64][]int64{c.ID: tops})
	if err != nil {
		return nil, err
	}
	hidden, err := loadHidden(ctx, s.pool, []int64{me}, map[int64][]int64{c.ID: tops})
	if err != nil {
		return nil, err
	}
	var list []*messageRow
	for _, seq := range tops {
		if mr, ok := msgs[msgKey{c.ID, seq}]; ok && !mr.Deleted && !hidden[hiddenKey{me, msgKey{c.ID, seq}}] {
			list = append(list, mr)
		}
	}
	resp.Messages, resp.Users, err = s.renderMessages(ctx, s.pool, me, list)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// topicUnread counts my unread messages in one topic.
func (s *Service) topicUnread(ctx context.Context, q querier, chatID int64, m *memberRow, topicID int64) (int32, error) {
	var n int32
	err := q.QueryRow(ctx, `
		SELECT count(*) FROM messages msg
		LEFT JOIN chat_read_states r ON r.chat_id = msg.chat_id AND r.user_id = $2 AND r.topic_id = msg.topic_id
		WHERE msg.chat_id = $1 AND msg.topic_id = $3 AND msg.from_id <> $2 AND msg.deleted_at IS NULL
			AND msg.seq > greatest(coalesce(r.read_inbox_max_seq, 0), $4, $5 - 1)
			AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $2 AND h.chat_id = msg.chat_id AND h.seq = msg.seq)`,
		chatID, m.UserID, topicID, m.JoinedSeq, m.VisibleFrom).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("chat: topic unread: %w", err)
	}
	return n, nil
}

func cleanIconColor(v int32) (int32, error) {
	if v < 0 || v > iconColorMax {
		return 0, errInvalid("icon_color must be 0xRRGGBB")
	}
	return v, nil
}

// CreateForumTopic opens a topic (members with MANAGE_TOPICS).
func (s *Service) CreateForumTopic(ctx context.Context, me, chatID int64, title string, iconColor int32) (*appv1.ForumTopic, *appv1.SyncAck, error) {
	title, err := cleanTitle(title)
	if err != nil {
		return nil, nil, err
	}
	if iconColor, err = cleanIconColor(iconColor); err != nil {
		return nil, nil, err
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, nil, err
	}
	var topic *topicRow
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.forumFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if !c.can(m, permManageTopics) {
			return errDenied("you cannot create topics in this chat")
		}
		var id int64
		if err := t.tx.QueryRow(ctx, `UPDATE chats SET last_topic_id = last_topic_id + 1 WHERE id = $1 RETURNING last_topic_id`,
			chatID).Scan(&id); err != nil {
			return fmt.Errorf("chat: next topic id: %w", err)
		}
		topic, err = scanTopic(t.tx.QueryRow(ctx, `
			INSERT INTO forum_topics AS t (chat_id, id, title, icon_color, creator_id) VALUES ($1, $2, $3, $4, $5)
			RETURNING `+topicColumns, chatID, id, title, iconColor, me))
		if err != nil {
			return fmt.Errorf("chat: create topic: %w", err)
		}
		return t.topicChanged(ctx, c, me, topic)
	})
	if err != nil {
		return nil, nil, err
	}
	return topic.render(), t.ack(me, chatID), nil
}

// changeTopic loads a topic under the chat lock, checks who may change it
// (admins; the topic's creator with MANAGE_TOPICS unless adminOnly), lets
// edit change it and announces the result.
func (s *Service) changeTopic(ctx context.Context, me, chatID, topicID int64, adminOnly bool,
	edit func(t *topicRow) (changed bool, err error),
) (*appv1.ForumTopic, *appv1.SyncAck, error) {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, nil, err
	}
	var topic *topicRow
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.forumFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		topic, err = scanTopic(t.tx.QueryRow(ctx, `SELECT `+topicColumns+` FROM forum_topics t WHERE t.chat_id = $1 AND t.id = $2`,
			chatID, topicID))
		if isNoRows(err) {
			return errNotFound("topic")
		}
		if err != nil {
			return fmt.Errorf("chat: load topic: %w", err)
		}
		creatorMay := !adminOnly && topic.ID != generalTopicID && topic.CreatorID == me && c.can(m, permManageTopics)
		if !m.isAdmin() && !creatorMay {
			return errDenied("you cannot change this topic")
		}
		changed, err := edit(topic)
		if err != nil || !changed {
			return err
		}
		if _, err := t.tx.Exec(ctx, `
			UPDATE forum_topics SET title = $3, icon_color = $4, pinned = $5, closed = $6, hidden = $7 WHERE chat_id = $1 AND id = $2`,
			chatID, topicID, topic.Title, topic.IconColor, topic.Pinned, topic.Closed, topic.Hidden); err != nil {
			return fmt.Errorf("chat: update topic: %w", err)
		}
		return t.topicChanged(ctx, c, me, topic)
	})
	if err != nil {
		return nil, nil, err
	}
	return topic.render(), t.ack(me, chatID), nil
}

// EditForumTopic renames, recolours or (admins) pins a topic.
func (s *Service) EditForumTopic(ctx context.Context, me int64, req *appv1.EditForumTopicRequest) (*appv1.ForumTopic, *appv1.SyncAck, error) {
	var title string
	var icon int32
	var err error
	if req.Title != nil {
		if title, err = cleanTitle(req.GetTitle()); err != nil {
			return nil, nil, err
		}
	}
	if req.IconColor != nil {
		if icon, err = cleanIconColor(req.GetIconColor()); err != nil {
			return nil, nil, err
		}
	}
	return s.changeTopic(ctx, me, req.GetChatId(), req.GetTopicId(), req.Pinned != nil, func(t *topicRow) (bool, error) {
		before := *t
		if req.Title != nil {
			t.Title = title
		}
		if req.IconColor != nil {
			t.IconColor = icon
		}
		if req.Pinned != nil {
			t.Pinned = req.GetPinned()
		}
		return *t != before, nil
	})
}

// CloseForumTopic closes or reopens a topic.
func (s *Service) CloseForumTopic(ctx context.Context, me, chatID, topicID int64, closed bool) (*appv1.ForumTopic, *appv1.SyncAck, error) {
	return s.changeTopic(ctx, me, chatID, topicID, false, func(t *topicRow) (bool, error) {
		if t.Closed == closed {
			return false, nil
		}
		t.Closed = closed
		return true, nil
	})
}

// HideForumTopic hides or shows a topic in the list (admins only).
func (s *Service) HideForumTopic(ctx context.Context, me, chatID, topicID int64, hidden bool) (*appv1.ForumTopic, *appv1.SyncAck, error) {
	return s.changeTopic(ctx, me, chatID, topicID, true, func(t *topicRow) (bool, error) {
		if t.Hidden == hidden {
			return false, nil
		}
		t.Hidden = hidden
		return true, nil
	})
}

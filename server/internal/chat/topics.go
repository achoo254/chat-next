package chat

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"regexp"
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
	// topicsPerChatMax bounds a forum (topics are never deleted, so
	// chats.last_topic_id is their number).
	topicsPerChatMax = 1000
	topicsPageDef    = 100
	topicsPageMax    = 500
)

type topicRow struct {
	ChatID       int64
	ID           int64
	Title        string
	IconColor    int32
	Icon         string
	CreatorID    int64
	CreatedAt    time.Time
	Pinned       bool
	Closed       bool
	Hidden       bool
	TopSeq       int64
	MessageCount int32
}

const topicColumns = `t.chat_id, t.id, t.title, t.icon_color, t.icon, t.creator_id, t.created_at, t.pinned, t.closed, t.hidden,
	t.top_seq, t.message_count`

// topicFields are the scan targets of topicColumns.
func (t *topicRow) topicFields() []any {
	return []any{&t.ChatID, &t.ID, &t.Title, &t.IconColor, &t.Icon, &t.CreatorID, &t.CreatedAt, &t.Pinned, &t.Closed, &t.Hidden,
		&t.TopSeq, &t.MessageCount}
}

func scanTopic(row pgx.Row) (*topicRow, error) {
	t := &topicRow{}
	err := row.Scan(t.topicFields()...)
	return t, err
}

func (t *topicRow) render() *appv1.ForumTopic {
	return &appv1.ForumTopic{
		ChatId: t.ChatID, Id: t.ID, Title: t.Title, IconColor: t.IconColor, Icon: t.Icon, CreatorId: t.CreatorID,
		CreatedAt: t.CreatedAt.Unix(), Pinned: t.Pinned, Closed: t.Closed, Hidden: t.Hidden, TopSeq: t.TopSeq,
		MessageCount: t.MessageCount,
	}
}

var topicIconPattern = regexp.MustCompile(`^([a-z][a-z0-9-]{0,31})?$`)

// cleanIcon checks a topic icon name (empty is the default icon).
func cleanIcon(icon string) (string, error) {
	if !topicIconPattern.MatchString(icon) {
		return "", errInvalid("icon must be an icon name: lowercase letters, digits and '-', at most 32")
	}
	return icon, nil
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
		UPDATE forum_topics SET message_count = (SELECT count(*) FROM messages
			WHERE chat_id = $1 AND topic_id = $2 AND deleted_at IS NULL)
		WHERE chat_id = $1 AND id = $2`, c.ID, generalTopicID); err != nil {
		return fmt.Errorf("chat: count General messages: %w", err)
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

// topicCursor is the opaque GetForumTopics cursor: the sort key (pinned,
// top_seq, id) of the last topic returned.
type topicCursor struct {
	pinned     bool
	topSeq, id int64
}

func (c topicCursor) encode() string {
	b := make([]byte, 17)
	if c.pinned {
		b[0] = 1
	}
	binary.BigEndian.PutUint64(b[1:9], uint64(c.topSeq))
	binary.BigEndian.PutUint64(b[9:], uint64(c.id))
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeTopicCursor(s string) (topicCursor, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != 17 || b[0] > 1 {
		return topicCursor{}, errInvalid("invalid cursor")
	}
	return topicCursor{pinned: b[0] == 1, topSeq: int64(binary.BigEndian.Uint64(b[1:9])), id: int64(binary.BigEndian.Uint64(b[9:]))}, nil
}

// GetForumTopics lists a page of a forum's topics with my read state and
// their top messages: pinned first, then newest message first.
func (s *Service) GetForumTopics(ctx context.Context, me, chatID int64, cursor string, limit int32) (*appv1.GetForumTopicsResponse, error) {
	c, m, err := s.forumFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = topicsPageDef
	}
	limit = min(limit, topicsPageMax)
	// The first page starts above every key.
	after := topicCursor{pinned: true, topSeq: 1 << 62, id: -1}
	if cursor != "" {
		if after, err = decodeTopicCursor(cursor); err != nil {
			return nil, err
		}
	}
	pinned := 0
	if after.pinned {
		pinned = 1
	}
	// Sorted by (pinned, top_seq, -id) descending; the page continues below
	// the cursor's key.
	rows, err := s.pool.Query(ctx, `
		SELECT `+topicColumns+`, coalesce(r.read_inbox_max_seq, 0),
			(SELECT count(*) FROM (SELECT 1 FROM messages msg
				WHERE msg.chat_id = t.chat_id AND msg.topic_id = t.id AND msg.from_id <> $2 AND msg.deleted_at IS NULL
					AND msg.seq > greatest(coalesce(r.read_inbox_max_seq, 0), $3, $4 - 1)
					AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $2 AND h.chat_id = msg.chat_id AND h.seq = msg.seq)
				LIMIT $8) n),
			(SELECT count(*) FROM (SELECT 1 FROM message_mentions mm
				JOIN messages msg ON msg.chat_id = mm.chat_id AND msg.seq = mm.seq
				WHERE mm.user_id = $2 AND mm.chat_id = t.chat_id AND msg.topic_id = t.id AND msg.from_id <> $2
					AND msg.deleted_at IS NULL AND msg.seq > greatest(coalesce(r.read_inbox_max_seq, 0), $3, $4 - 1)
					AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $2 AND h.chat_id = msg.chat_id AND h.seq = msg.seq)
				LIMIT $8) mn)
		FROM forum_topics t
		LEFT JOIN chat_read_states r ON r.chat_id = t.chat_id AND r.user_id = $2 AND r.topic_id = t.id
		WHERE t.chat_id = $1 AND (t.pinned::int, t.top_seq, -t.id) < ($5::int, $6::bigint, $7::bigint)
		ORDER BY t.pinned DESC, t.top_seq DESC, t.id LIMIT $9`,
		c.ID, me, m.JoinedSeq, m.VisibleFrom, pinned, after.topSeq, -after.id, unreadMax, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list topics: %w", err)
	}
	defer rows.Close()
	resp := &appv1.GetForumTopicsResponse{}
	var page []*topicRow
	unread, mentions := map[int64]int32{}, map[int64]int32{}
	read := map[int64]int64{}
	for rows.Next() {
		tr := &topicRow{}
		var r, n, mn int64
		if err := rows.Scan(append(tr.topicFields(), &r, &n, &mn)...); err != nil {
			return nil, fmt.Errorf("chat: list topics: %w", err)
		}
		page = append(page, tr)
		read[tr.ID], unread[tr.ID], mentions[tr.ID] = r, int32(min(n, unreadMax)), int32(min(mn, unreadMax))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: list topics: %w", err)
	}
	rows.Close()
	if len(page) > int(limit) {
		page = page[:limit]
		last := page[len(page)-1]
		resp.NextCursor = topicCursor{pinned: last.Pinned, topSeq: last.TopSeq, id: last.ID}.encode()
	}
	var tops []int64
	for _, tr := range page {
		topic := tr.render()
		topic.ReadInboxMaxSeq, topic.UnreadCount = max(read[tr.ID], m.JoinedSeq), unread[tr.ID]
		topic.UnreadMentionsCount = mentions[tr.ID]
		resp.Topics = append(resp.Topics, topic)
		if tr.TopSeq >= max(m.VisibleFrom, 1) {
			tops = append(tops, tr.TopSeq)
		}
	}
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

// topicUnread counts my unread messages in one topic, up to unreadMax.
func (s *Service) topicUnread(ctx context.Context, q querier, chatID int64, m *memberRow, topicID int64) (int32, error) {
	var n int64
	err := q.QueryRow(ctx, `
		SELECT count(*) FROM (SELECT 1 FROM messages msg
			LEFT JOIN chat_read_states r ON r.chat_id = msg.chat_id AND r.user_id = $2 AND r.topic_id = msg.topic_id
			WHERE msg.chat_id = $1 AND msg.topic_id = $3 AND msg.from_id <> $2 AND msg.deleted_at IS NULL
				AND msg.seq > greatest(coalesce(r.read_inbox_max_seq, 0), $4, $5 - 1)
				AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $2 AND h.chat_id = msg.chat_id AND h.seq = msg.seq)
			LIMIT $6) n`,
		chatID, m.UserID, topicID, m.JoinedSeq, m.VisibleFrom, unreadMax).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("chat: topic unread: %w", err)
	}
	return int32(min(n, unreadMax)), nil
}

func cleanIconColor(v int32) (int32, error) {
	if v < 0 || v > iconColorMax {
		return 0, errInvalid("icon_color must be 0xRRGGBB")
	}
	return v, nil
}

// CreateForumTopic opens a topic (members with MANAGE_TOPICS).
func (s *Service) CreateForumTopic(ctx context.Context, me int64, req *appv1.CreateForumTopicRequest) (*appv1.ForumTopic, *appv1.SyncAck, error) {
	chatID := req.GetChatId()
	title, err := cleanTitle(req.GetTitle())
	if err != nil {
		return nil, nil, err
	}
	iconColor, err := cleanIconColor(req.GetIconColor())
	if err != nil {
		return nil, nil, err
	}
	icon, err := cleanIcon(req.GetIcon())
	if err != nil {
		return nil, nil, err
	}
	if err := s.allow(ctx, limitTopic, "topic", me); err != nil {
		return nil, nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
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
		if c.LastTopicID >= topicsPerChatMax {
			return errPrecondition("a group has at most %d topics", topicsPerChatMax)
		}
		var id int64
		if err := t.tx.QueryRow(ctx, `UPDATE chats SET last_topic_id = last_topic_id + 1 WHERE id = $1 RETURNING last_topic_id`,
			chatID).Scan(&id); err != nil {
			return fmt.Errorf("chat: next topic id: %w", err)
		}
		topic, err = scanTopic(t.tx.QueryRow(ctx, `
			INSERT INTO forum_topics AS t (chat_id, id, title, icon_color, icon, creator_id) VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING `+topicColumns, chatID, id, title, iconColor, icon, me))
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
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
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
			UPDATE forum_topics SET title = $3, icon_color = $4, icon = $5, pinned = $6, closed = $7, hidden = $8
			WHERE chat_id = $1 AND id = $2`,
			chatID, topicID, topic.Title, topic.IconColor, topic.Icon, topic.Pinned, topic.Closed, topic.Hidden); err != nil {
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
	var glyph string
	if req.Icon != nil {
		if glyph, err = cleanIcon(req.GetIcon()); err != nil {
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
		if req.Icon != nil {
			t.Icon = glyph
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

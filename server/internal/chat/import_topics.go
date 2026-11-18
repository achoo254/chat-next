package chat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// ErrTooManyTopics is returned by ImportTx.CreateTopic when the forum already
// holds the most topics a chat may have. The bridge then puts the messages of
// the topic it could not open in the General topic.
var ErrTooManyTopics = errors.New("chat: the forum holds the most topics a chat may have")

// TopicImport describes a topic of another app, already mapped.
type TopicImport struct {
	Title string
	// IconColor is 0xRRGGBB, 0 for none; anything outside that range is dropped.
	IconColor int
	Closed    bool
	Pinned    bool
	Hidden    bool
	// Created is when the topic was opened in the other app; zero means now.
	// It never lies in the future.
	Created time.Time
}

// cleanImportedTopicTitle fits a title of another app into what a topic holds:
// valid text on one line, cut at the limit, never empty.
func cleanImportedTopicTitle(title string) string {
	title = strings.Join(strings.Fields(strings.ToValidUTF8(title, "")), " ")
	if utf8.RuneCountInString(title) > titleMax {
		title = string([]rune(title)[:titleMax])
	}
	if title == "" {
		title = "Topic"
	}
	return title
}

func importedIconColor(c int) int {
	if c < 0 || c > iconColorMax {
		return 0
	}
	return c
}

// CreateTopic opens a topic in the forum chat and tells the chat's members. It
// asks nothing of anyone (the bridge opens a topic because the other app did),
// takes no rate limit and sends no notification. It returns the Chat topic id.
func (it *ImportTx) CreateTopic(ctx context.Context, ti TopicImport) (int64, error) {
	if !it.c.Forum {
		return 0, errInvalid("this chat has no topics")
	}
	if it.c.LastTopicID >= topicsPerChatMax {
		return 0, ErrTooManyTopics
	}
	created := ti.Created
	if created.IsZero() || created.After(time.Now()) {
		created = time.Now()
	}
	var id int64
	if err := it.t.tx.QueryRow(ctx, `UPDATE chats SET last_topic_id = last_topic_id + 1 WHERE id = $1 RETURNING last_topic_id`,
		it.c.ID).Scan(&id); err != nil {
		return 0, fmt.Errorf("chat: next topic id: %w", err)
	}
	it.c.LastTopicID = id
	topic, err := scanTopic(it.t.tx.QueryRow(ctx, `
		INSERT INTO forum_topics AS t (chat_id, id, title, icon_color, creator_id, created_at, pinned, closed, hidden)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING `+topicColumns,
		it.c.ID, id, cleanImportedTopicTitle(ti.Title), importedIconColor(ti.IconColor), it.owner, created, ti.Pinned, ti.Closed, ti.Hidden))
	if err != nil {
		return 0, fmt.Errorf("chat: create imported topic: %w", err)
	}
	if err := it.t.topicChanged(ctx, it.c, it.owner, topic); err != nil {
		return 0, err
	}
	return id, nil
}

// UpdateTopic applies what the other app says a topic is now (name, colour,
// closed, pinned, hidden) and tells the members when something changed. It
// reports whether anything did.
func (it *ImportTx) UpdateTopic(ctx context.Context, topicID int64, ti TopicImport) (bool, error) {
	if !it.c.Forum {
		return false, errInvalid("this chat has no topics")
	}
	old, err := scanTopic(it.t.tx.QueryRow(ctx, `SELECT `+topicColumns+` FROM forum_topics t WHERE t.chat_id = $1 AND t.id = $2 FOR UPDATE`, it.c.ID, topicID))
	if isNoRows(err) {
		return false, errNotFound("topic")
	}
	if err != nil {
		return false, fmt.Errorf("chat: load imported topic: %w", err)
	}
	title, color := cleanImportedTopicTitle(ti.Title), importedIconColor(ti.IconColor)
	if old.Title == title && int(old.IconColor) == color && old.Pinned == ti.Pinned && old.Closed == ti.Closed && old.Hidden == ti.Hidden {
		return false, nil
	}
	topic, err := scanTopic(it.t.tx.QueryRow(ctx, `
		UPDATE forum_topics AS t SET title = $3, icon_color = $4, pinned = $5, closed = $6, hidden = $7
		WHERE t.chat_id = $1 AND t.id = $2 RETURNING `+topicColumns,
		it.c.ID, topicID, title, color, ti.Pinned, ti.Closed, ti.Hidden))
	if err != nil {
		return false, fmt.Errorf("chat: update imported topic: %w", err)
	}
	if err := it.t.topicChanged(ctx, it.c, it.owner, topic); err != nil {
		return false, err
	}
	return true, nil
}

// checkTopics refuses a batch that names a topic the chat does not have (or any
// topic in a chat without topics), before anything is written.
func (it *ImportTx) checkTopics(ctx context.Context, msgs []ImportMessage) error {
	seen := map[int64]bool{}
	for _, m := range msgs {
		if m.TopicID == 0 || seen[m.TopicID] {
			continue
		}
		seen[m.TopicID] = true
		if !it.c.Forum {
			return errInvalid("topic_id on a chat without topics")
		}
		var ok bool
		if err := it.t.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM forum_topics WHERE chat_id = $1 AND id = $2)`, it.c.ID, m.TopicID).Scan(&ok); err != nil {
			return fmt.Errorf("chat: check imported topic: %w", err)
		}
		if !ok {
			return errInvalid("the chat has no topic %d", m.TopicID)
		}
	}
	return nil
}

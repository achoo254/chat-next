package chat

import (
	"context"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
)

// SetPinned pins or unpins the message at seq as the other app says. Unlike
// PinMessage it asks for no right and posts no service message: the other app
// already shows its own, and an import of many pins must not add one line each.
// It reports whether anything changed: false when the message is gone, is a
// service message, or is already in the wanted state.
func (it *ImportTx) SetPinned(ctx context.Context, seq int64, pinned bool) (bool, error) {
	m, err := it.t.s.liveMessage(ctx, it.t.tx, it.c.ID, seq)
	if isNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if isService(m) {
		return false, nil
	}
	query := `DELETE FROM pinned_messages WHERE chat_id = $1 AND seq = $2`
	if pinned {
		query = `INSERT INTO pinned_messages (chat_id, seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`
	}
	tag, err := it.t.tx.Exec(ctx, query, it.c.ID, seq)
	if err != nil {
		return false, fmt.Errorf("chat: set pinned: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err := it.t.refreshPinned(ctx, it.c); err != nil {
		return false, fmt.Errorf("chat: set pinned: %w", err)
	}
	members, err := it.t.fanoutMembers(ctx, it.c)
	if err != nil {
		return false, err
	}
	ev := it.t.event(kindPin, it.c.ID, it.owner)
	if err := it.t.toChat(ctx, ev, it.c, members, &appv1.Update{Kind: &appv1.Update_Pin{Pin: &appv1.UpdatePin{
		ChatId: it.c.ID, Seq: seq, Pinned: pinned,
	}}}); err != nil {
		return false, err
	}
	return true, nil
}

// SetTopicPinned pins or unpins a topic as the other app says, or puts it back
// when the other app refused a pin made in Chat. It reports whether the topic
// changed.
func (it *ImportTx) SetTopicPinned(ctx context.Context, topicID int64, pinned bool) (bool, error) {
	if !it.c.Forum {
		return false, nil
	}
	topic, err := scanTopic(it.t.tx.QueryRow(ctx, `
		UPDATE forum_topics AS t SET pinned = $3 WHERE t.chat_id = $1 AND t.id = $2 AND t.pinned <> $3 RETURNING `+topicColumns,
		it.c.ID, topicID, pinned))
	if isNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("chat: set topic pinned: %w", err)
	}
	if err := it.t.topicChanged(ctx, it.c, it.owner, topic); err != nil {
		return false, err
	}
	return true, nil
}

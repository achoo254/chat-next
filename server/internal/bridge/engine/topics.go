package engine

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// generalTopicID is the id of the General topic of every forum chat.
const generalTopicID = 1

// convTopics is what the runner knows about the topics of one forum
// conversation: what the other app listed, when it last did, and the topics
// that did not fit in the chat (their messages go in General).
type convTopics struct {
	info     map[string]bridge.Topic
	fetched  time.Time
	overflow map[string]bool
}

func (r *runner) convTopics(conv string) *convTopics {
	if r.topics == nil {
		r.topics = map[string]*convTopics{}
	}
	t := r.topics[conv]
	if t == nil {
		t = &convTopics{info: map[string]bridge.Topic{}, overflow: map[string]bool{}}
		r.topics[conv] = t
	}
	return t
}

// topicReader is the adapter's topic reading, when this conversation uses it.
func (r *runner) topicReader(l *chatLink) (bridge.TopicReader, bool) {
	tr, ok := r.adapter.(bridge.TopicReader)
	if !ok || !l.Forum || !r.adapter.Capabilities().Has(bridge.CapTopics) {
		return nil, false
	}
	return tr, true
}

// loadTopics asks the other app for the topics of the conversation.
func (r *runner) loadTopics(ctx context.Context, l *chatLink) error {
	tr, ok := r.topicReader(l)
	if !ok {
		return nil
	}
	list, err := retryRateLimit(ctx, func() ([]bridge.Topic, error) { return tr.ListTopics(ctx, r.acct, l.ExternalChat) })
	if err != nil {
		return err
	}
	ct := r.convTopics(l.ExternalChat)
	ct.fetched = time.Now()
	for _, t := range list {
		ct.info[t.ID] = t
	}
	return nil
}

// syncTopics opens, in the chat, every topic the other app lists, oldest
// first, and updates the ones it already had: before history is imported, so the
// messages find their topics and an empty topic is there too.
func (r *runner) syncTopics(ctx context.Context, l *chatLink) error {
	if _, ok := r.topicReader(l); !ok {
		return nil
	}
	if err := r.loadTopics(ctx, l); err != nil {
		return err
	}
	list := make([]bridge.Topic, 0, len(r.convTopics(l.ExternalChat).info))
	for _, t := range r.convTopics(l.ExternalChat).info {
		list = append(list, t)
	}
	slices.SortFunc(list, func(a, b bridge.Topic) int {
		if a.General != b.General {
			if a.General {
				return -1
			}
			return 1
		}
		return a.Created.Compare(b.Created)
	})
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		for _, t := range list {
			if _, err := r.upsertTopic(ctx, it, l, t); err != nil {
				return err
			}
		}
		return nil
	})
}

func topicImport(t bridge.Topic) chat.TopicImport {
	return chat.TopicImport{Title: t.Title, IconColor: t.IconColor, Closed: t.Closed, Pinned: t.Pinned, Hidden: t.Hidden, Created: t.Created}
}

// upsertTopic opens the topic in the chat or updates the one it stands for, and
// returns the Chat topic id (0 when the chat could not hold another topic).
func (r *runner) upsertTopic(ctx context.Context, it *chat.ImportTx, l *chatLink, t bridge.Topic) (int64, error) {
	ct := r.convTopics(l.ExternalChat)
	id, ok, err := lookupTopic(ctx, it.Tx(), r.account.ID, l.ExternalChat, t.ID)
	if err != nil {
		return 0, err
	}
	switch {
	case ok:
		_, err = it.UpdateTopic(ctx, id, topicImport(t))
		return id, err
	case t.General:
		if err := insertTopic(ctx, it.Tx(), r.account.ID, l.ExternalChat, t.ID, generalTopicID); err != nil {
			return 0, err
		}
		_, err = it.UpdateTopic(ctx, generalTopicID, chat.TopicImport{Title: t.Title, IconColor: t.IconColor, Closed: t.Closed, Pinned: t.Pinned, Hidden: t.Hidden})
		return generalTopicID, err
	}
	id, err = it.CreateTopic(ctx, topicImport(t))
	if errors.Is(err, chat.ErrTooManyTopics) {
		if !ct.overflow[t.ID] {
			ct.overflow[t.ID] = true
			r.logger.Warn("the chat holds the most topics it may; messages of further topics go in General", "topic", t.ID)
		}
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return id, insertTopic(ctx, it.Tx(), r.account.ID, l.ExternalChat, t.ID, id)
}

// prepareTopics makes sure what is needed to open the topics of msgs is known,
// before any chat transaction: when a message names a topic the chat does not
// have, the other app is asked for its topics (at most once in
// Config.TopicRefreshGap, so a busy forum does not turn into a stream of calls).
func (r *runner) prepareTopics(ctx context.Context, l *chatLink, msgs []bridge.Message) error {
	if _, ok := r.topicReader(l); !ok {
		return nil
	}
	var ids []string
	for _, m := range msgs {
		if m.Topic != "" && !slices.Contains(ids, m.Topic) {
			ids = append(ids, m.Topic)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	missing, err := unmappedTopics(ctx, r.e.db.pool, r.account.ID, l.ExternalChat, ids)
	if err != nil || len(missing) == 0 {
		return err
	}
	ct := r.convTopics(l.ExternalChat)
	for _, id := range missing {
		if _, known := ct.info[id]; !known && time.Since(ct.fetched) >= r.e.cfg.TopicRefreshGap {
			return r.loadTopics(ctx, l)
		}
	}
	return nil
}

// topicIDs returns, for the messages of a batch, the Chat topic of each topic
// of the other app they name, opening the topics that are new. A message that
// names none, or a topic the chat could not take, is for the General topic (0).
func (r *runner) topicIDs(ctx context.Context, it *chat.ImportTx, l *chatLink, msgs []bridge.Message) (map[string]int64, error) {
	if !l.Forum {
		return nil, nil
	}
	out := map[string]int64{}
	ct := r.convTopics(l.ExternalChat)
	for _, m := range msgs {
		if m.Topic == "" {
			continue
		}
		if _, done := out[m.Topic]; done {
			continue
		}
		if ct.overflow[m.Topic] {
			out[m.Topic] = 0
			continue
		}
		id, ok, err := lookupTopic(ctx, it.Tx(), r.account.ID, l.ExternalChat, m.Topic)
		if err != nil {
			return nil, err
		}
		if !ok {
			t, known := ct.info[m.Topic]
			if !known {
				// Listed nowhere (the topic was deleted, or the list is out of date): a plain name keeps the messages together.
				t = bridge.Topic{ID: m.Topic, Title: "Topic " + m.Topic}
			}
			if id, err = r.upsertTopic(ctx, it, l, t); err != nil {
				return nil, err
			}
		}
		out[m.Topic] = id
	}
	return out, nil
}

// onTopic applies a change of a topic reported live.
func (r *runner) onTopic(ctx context.Context, ev bridge.Event, tc bridge.TopicChange) (bool, error) {
	l := r.links[tc.Conversation]
	if l == nil || !l.BackfillDone {
		return false, nil
	}
	if _, ok := r.topicReader(l); !ok {
		return false, nil
	}
	r.convTopics(l.ExternalChat).info[tc.Topic.ID] = tc.Topic
	err := r.withLink(ctx, l, func(it *chat.ImportTx) error {
		if _, err := r.upsertTopic(ctx, it, l, tc.Topic); err != nil {
			return err
		}
		return saveState(ctx, it.Tx(), r.account.ID, ev.State)
	})
	return true, err
}

// doTopicEdit sends the name and the closed state wanted for a topic, and when the
// other app refuses puts the topic back to what it has there.
func (r *runner) doTopicEdit(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	writer, ok := r.adapter.(bridge.TopicWriter)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "topic_unsupported: this app cannot change topics from Chat", time.Time{})
	}
	ext, found, err := externalTopic(ctx, db.pool, r.account.ID, h.ExternalChat, h.Seq)
	if err != nil {
		return err
	}
	if !found {
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	var p struct {
		Title  string `json:"title"`
		Closed bool   `json:"closed"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	if err := db.startSending(ctx, []int64{h.ID}); err != nil {
		return err
	}
	if err := writer.EditTopic(ctx, r.acct, h.ExternalChat, ext, bridge.TopicEdit{Title: &p.Title, Closed: &p.Closed}); err != nil {
		if serr := r.settleCall(ctx, []*outboxRow{h}, err); serr != nil {
			return serr
		}
		var status string
		if qerr := db.pool.QueryRow(ctx, `SELECT status FROM external_outbox WHERE id = $1`, h.ID).Scan(&status); qerr != nil {
			return qerr
		}
		if l := r.links[h.ExternalChat]; status == "failed" && l != nil {
			return r.syncTopics(ctx, l) // the other app is the source: Chat shows its topics again
		}
		return nil
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}

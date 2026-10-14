package chat

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// bulkMessages inserts n messages from author into a topic straight into
// the table (fast; no updates), as if they had been sent.
func (h *harness) bulkMessages(chatID, author, topicID int64, n int) {
	h.t.Helper()
	ctx := context.Background()
	if _, err := h.st.Pool().Exec(ctx, `
		INSERT INTO messages (chat_id, seq, id, topic_id, from_id, text)
		SELECT $1, c.last_seq + g, (1 << 40) + c.last_seq + g, $3, $2, 'bulk'
		FROM chats c, generate_series(1, $4::int) g WHERE c.id = $1`, chatID, author, topicID, n); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET last_seq = last_seq + $2 WHERE id = $1`, chatID, n); err != nil {
		h.t.Fatal(err)
	}
	if topicID != 0 {
		if _, err := h.st.Pool().Exec(ctx, `UPDATE forum_topics SET top_seq = (SELECT last_seq FROM chats WHERE id = $1)
			WHERE chat_id = $1 AND id = $2`, chatID, topicID); err != nil {
			h.t.Fatal(err)
		}
	}
}

func TestUnreadCountsAreCappedAndBatched(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	busy := h.group(a, b)
	h.bulkMessages(busy, a, 0, unreadMax+100)
	forum, err := h.svc.CreateGroup(ctx, a, "forum", []int64{b}, true)
	if err != nil {
		t.Fatal(err)
	}
	h.bulkMessages(forum.GetChat().GetId(), a, generalTopicID, unreadMax+5)
	// A since_join newcomer counts only what came after joining.
	quiet := h.group(a, b)
	h.send(a, quiet, "before c")
	if _, err := h.svc.SetHistoryVisibility(ctx, a, quiet, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddMembers(ctx, a, quiet, []int64{c}); err != nil {
		t.Fatal(err)
	}
	last := h.send(a, quiet, "after c").GetMessage().GetSeq()
	if _, err := h.svc.AddMembers(ctx, a, busy, []int64{c}); err != nil {
		t.Fatal(err)
	}
	dl, err := h.svc.GetDialogs(ctx, b, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	unread := map[int64]int32{}
	for _, d := range dl.GetDialogs() {
		unread[d.GetChatId()] = d.GetUnreadCount()
	}
	if unread[busy] != unreadMax || unread[forum.GetChat().GetId()] != unreadMax {
		t.Fatalf("unread counts = %v, want %d where more are unread", unread, unreadMax)
	}
	topics, err := h.svc.GetForumTopics(ctx, b, forum.GetChat().GetId(), "", 0)
	if err != nil || topics.GetTopics()[0].GetUnreadCount() != unreadMax {
		t.Fatalf("topic unread = %v, %v", topics, err)
	}
	peer, err := h.svc.GetPeerDialogs(ctx, c, []int64{quiet, busy})
	if err != nil || len(peer.GetDialogs()) != 2 {
		t.Fatalf("newcomer dialogs = %v, %v", peer, err)
	}
	q, bz := peer.GetDialogs()[0], peer.GetDialogs()[1]
	// Unread for c: the "added c" service message and what followed.
	if q.GetChatId() != quiet || q.GetTopSeq() != last || q.GetUnreadCount() != 2 {
		t.Fatalf("since_join dialog = %v", q)
	}
	if bz.GetChatId() != busy || bz.GetUnreadCount() != 1 || len(peer.GetMessages()) != 2 {
		t.Fatalf("busy dialog of a newcomer = %v (messages %d)", bz, len(peer.GetMessages()))
	}
}

func TestForumTopicsArePagedAndBounded(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	resp, err := h.svc.CreateGroup(ctx, a, "forum", []int64{b}, true)
	if err != nil {
		t.Fatal(err)
	}
	chatID := resp.GetChat().GetId()
	for _, title := range []string{"one", "two", "three", "four"} {
		if _, _, err := h.svc.CreateForumTopic(ctx, a, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: title}); err != nil {
			t.Fatal(err)
		}
	}
	pinned := true
	if _, _, err := h.svc.EditForumTopic(ctx, a, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: 4, Pinned: &pinned}); err != nil {
		t.Fatal(err)
	}
	h.send(a, chatID, "general news")
	var order []int64
	cursor := ""
	for range 5 {
		page, err := h.svc.GetForumTopics(ctx, b, chatID, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, tp := range page.GetTopics() {
			order = append(order, tp.GetId())
		}
		if cursor = page.GetNextCursor(); cursor == "" {
			break
		}
	}
	// Pinned first, then newest message first, then by id.
	if want := []int64{4, 1, 2, 3, 5}; !slices.Equal(order, want) {
		t.Fatalf("topic order = %v, want %v", order, want)
	}
	if _, err := h.svc.GetForumTopics(ctx, b, chatID, "garbage", 2); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad cursor: %v", err)
	}
	// Reading the whole forum writes positions only for topics with unread
	// messages (General here), plus the chat-level one.
	if _, err := h.svc.ReadHistory(ctx, b, chatID, 1<<40, 0); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM chat_read_states WHERE chat_id = $1 AND user_id = $2`, chatID, b).
		Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("read of the whole forum wrote %d positions, want 2 (chat and General)", rows)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET last_topic_id = $2 WHERE id = $1`, chatID, topicsPerChatMax); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreateForumTopic(ctx, a, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "one too many", IconColor: 0}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("topic over the cap: %v", err)
	}
}

func TestDispatcherAndSweeperDeliverOnce(t *testing.T) {
	if !newIDSet().addIfAbsent(1) {
		t.Fatal("first add refused")
	}
	set := newIDSet()
	var wins atomic.Int32
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			if set.addIfAbsent(7) {
				wins.Add(1)
			}
		})
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("%d goroutines won the same id", wins.Load())
	}

	h := newHarness(t, nil)
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	h.drain()
	ctx := context.Background()
	st := &sweepState{pending: map[int64]time.Time{}}
	if err := h.st.Pool().QueryRow(ctx, `SELECT coalesce(max(id), 0) FROM outbox`).Scan(&st.cursor); err != nil {
		t.Fatal(err)
	}
	// The dispatcher queue is slow: the sweeper delivers first.
	d := h.svc.dispatch
	d.stop()
	before := len(h.sink.updatesOf(b))
	h.send(a, chatID, "once")
	if _, err := h.st.Pool().Exec(ctx, `UPDATE outbox SET created_at = created_at - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.sweep(ctx, st); err != nil {
		t.Fatal(err)
	}
	// Another sweep moves the cursor on; the id must still be remembered.
	if err := h.svc.sweep(ctx, st); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := h.st.Pool().QueryRow(ctx, `SELECT max(id) FROM outbox`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	r, err := h.svc.readOutbox(ctx, `id = $1`, id)
	if err != nil || len(r) != 1 {
		t.Fatalf("outbox row = %v, %v", r, err)
	}
	ev, err := h.svc.rebuildEvent(ctx, r[0])
	if err != nil {
		t.Fatal(err)
	}
	d.run(ev) // the late dispatcher
	if n := len(h.sink.updatesOf(b)) - before; n != 1 {
		t.Fatalf("delivered %d times, want once", n)
	}
}

func TestPartitionMaintenanceDetachesThenDrops(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	pool := h.st.Pool()
	for _, sql := range []string{
		// Past retention: still attached, and left detached by an earlier run.
		`CREATE TABLE user_updates_20000101 PARTITION OF user_updates FOR VALUES FROM ('2000-01-01 00:00:00+00') TO ('2000-01-02 00:00:00+00')`,
		`CREATE TABLE outbox_20000102 (LIKE outbox)`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.EnsurePartitions(ctx); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"user_updates_20000101", "outbox_20000102"} {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, name).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("%s survived maintenance", name)
		}
	}
	var ahead int
	if err := pool.QueryRow(ctx, `SELECT chat_day_partitions_ahead()`).Scan(&ahead); err != nil || ahead < partitionsAhead {
		t.Fatalf("days of partitions ahead = %d, %v", ahead, err)
	}
	// The peer lookup of private chats has an index on either side.
	var indexed bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'private_chats'
		AND indexdef LIKE '%(tenant_id, user_high)%')`).Scan(&indexed); err != nil || !indexed {
		t.Fatalf("private_chats (tenant_id, user_high) index missing: %v", err)
	}
}

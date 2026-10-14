package chat

import (
	"context"
	"fmt"
	"math/rand/v2"
	"slices"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"golang.org/x/sync/errgroup"
)

// checkContiguous asserts that a user's log holds pts 1..n exactly once.
func checkContiguous(t *testing.T, h *harness, userID int64) int64 {
	t.Helper()
	var n, lo, hi int64
	if err := h.st.Pool().QueryRow(context.Background(),
		`SELECT count(*), coalesce(min(pts), 0), coalesce(max(pts), 0) FROM user_updates WHERE user_id = $1`, userID).
		Scan(&n, &lo, &hi); err != nil {
		t.Fatal(err)
	}
	state, err := h.svc.State(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	if n != hi || (n > 0 && lo != 1) || hi != state.GetPts() {
		t.Fatalf("user %d log: %d rows, pts %d..%d, state %d (want 1..n, no gap or duplicate)", userID, n, lo, hi, state.GetPts())
	}
	return n
}

func TestConcurrentSendsKeepSeqAndPtsContiguous(t *testing.T) {
	h := newHarness(t, nil)
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b, c)
	const sends = 1000
	senders := []int64{a, b, c}
	var g errgroup.Group
	g.SetLimit(32)
	for i := range sends {
		g.Go(func() error {
			_, err := h.svc.SendMessage(context.Background(), senders[i%3], &appv1.SendMessageRequest{
				ChatId: chatID, Text: fmt.Sprint("m", i), RandomId: int64(i + 1),
			})
			return err
		})
	}
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	var count, maxSeq int64
	if err := h.st.Pool().QueryRow(context.Background(), `SELECT count(*), max(seq) FROM messages WHERE chat_id = $1`, chatID).
		Scan(&count, &maxSeq); err != nil {
		t.Fatal(err)
	}
	if count != sends+1 || maxSeq != sends+1 {
		t.Fatalf("messages: %d, max seq %d; want %d contiguous", count, maxSeq, sends+1)
	}
	for _, u := range senders {
		if n := checkContiguous(t, h, u); n != sends+1 {
			t.Fatalf("user %d has %d updates, want %d", u, n, sends+1)
		}
	}
}

func TestRetrySameRandomIDPostsOnce(t *testing.T) {
	h := newHarness(t, nil)
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	var g errgroup.Group
	acks := make([]*appv1.SendMessageResponse, 100)
	for i := range acks {
		g.Go(func() error {
			resp, err := h.svc.SendMessage(context.Background(), a, &appv1.SendMessageRequest{ChatId: chatID, Text: "once", RandomId: 4242})
			acks[i] = resp
			return err
		})
	}
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	for _, r := range acks {
		if r.GetMessage().GetSeq() != acks[0].GetMessage().GetSeq() || r.GetAck().GetPts() != acks[0].GetAck().GetPts() ||
			r.GetMessage().GetRandomId() != 4242 {
			t.Fatalf("retry answered %v, first %v", r, acks[0])
		}
	}
	var n int
	if err := h.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM messages WHERE chat_id = $1 AND text = 'once'`, chatID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("%d messages for one random_id", n)
	}
	// The id is bound to its chat.
	other := h.group(a, b)
	if _, err := h.svc.SendMessage(context.Background(), a, &appv1.SendMessageRequest{ChatId: other, Text: "x", RandomId: 4242}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("random_id reused in another chat: %v", err)
	}
}

// Twenty chats of 150 members with 30% shared members, sending in parallel:
// no deadlock, every log contiguous.
func TestOverlappingChatsDoNotDeadlock(t *testing.T) {
	if testing.Short() {
		t.Skip("large fan-out")
	}
	h := newHarness(t, nil)
	owner := h.user("owner")
	shared := make([]int64, 45)
	for i := range shared {
		shared[i] = h.user("shared")
	}
	var chats []int64
	var everyone []int64
	everyone = append(everyone, shared...)
	for range 20 {
		members := slices.Clone(shared)
		for range 104 {
			u := h.user("member")
			members = append(members, u)
			everyone = append(everyone, u)
		}
		chats = append(chats, h.group(owner, members...))
	}
	var g errgroup.Group
	g.SetLimit(20)
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range 300 {
		chatID := chats[rng.IntN(len(chats))]
		from := shared[rng.IntN(len(shared))]
		g.Go(func() error {
			_, err := h.svc.SendMessage(context.Background(), from, &appv1.SendMessageRequest{ChatId: chatID, Text: fmt.Sprint(i)})
			return err
		})
	}
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	for _, u := range append(shared, everyone[len(everyone)-5:]...) {
		checkContiguous(t, h, u)
	}
	checkContiguous(t, h, owner)
}

func TestSwitchToLargeKeepsEveryMessageOnce(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.LargeChatThreshold = 3 })
	a, b, c, d := h.user("a"), h.user("b"), h.user("c"), h.user("d")
	chatID := h.group(a, b, c)
	ctx := context.Background()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := range 60 {
			if _, err := h.svc.SendMessage(ctx, b, &appv1.SendMessageRequest{ChatId: chatID, Text: fmt.Sprint("during ", i)}); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	failed, _, err := h.svc.AddMembers(ctx, a, chatID, []int64{d})
	if err != nil || len(failed) > 0 {
		t.Fatalf("AddMembers: %v %v", failed, err)
	}
	wg.Wait()
	chat, _, err := h.svc.GetChat(ctx, a, chatID)
	if err != nil || chat.GetSyncMode() != appv1.SyncMode_SYNC_MODE_LARGE {
		t.Fatalf("chat after the threshold = %v, %v", chat, err)
	}
	// An old member: message_new from the per-user log until the switch,
	// then the chat's own log from the announced base.
	seen := map[int64]int{}
	base := int64(-1)
	for _, u := range h.logOf(c) {
		if m := u.GetMessageNew().GetMessage(); m != nil && m.GetChatId() == chatID {
			seen[m.GetSeq()]++
		}
		if mc := u.GetChatModeChanged(); mc != nil {
			base = mc.GetChatPts()
		}
	}
	if base < 0 {
		t.Fatal("no chat_mode_changed in the log")
	}
	resp, err := h.svc.GetChatDifference(ctx, c, &appv1.GetChatDifferenceRequest{ChatId: chatID, ChatPts: base, ServerEpoch: h.svc.Epoch()})
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range resp.GetFull().GetUpdates() {
		if m := u.GetMessageNew().GetMessage(); m != nil {
			seen[m.GetSeq()]++
		}
	}
	last, _, err := h.svc.chatFor(ctx, h.st.Pool(), chatID, a, false)
	if err != nil {
		t.Fatal(err)
	}
	for seq := int64(1); seq <= last.LastSeq; seq++ {
		if seen[seq] != 1 {
			t.Fatalf("seq %d seen %d times (want exactly once across both logs)", seq, seen[seq])
		}
	}
	// The newcomer starts from its own log too.
	foundAdded := false
	for _, u := range h.logOf(d) {
		if ma := u.GetMemberAdded(); ma != nil && slices.Contains(ma.GetUserIds(), d) {
			foundAdded = true
		}
	}
	if !foundAdded {
		t.Fatal("newcomer of a large chat has no member_added in its log")
	}
	// Large chats show up in GetDifference.large_chats.
	diff, err := h.svc.GetDifference(ctx, c, &appv1.GetDifferenceRequest{ServerEpoch: h.svc.Epoch()})
	if err != nil {
		t.Fatal(err)
	}
	if l := diff.GetFull().GetLargeChats(); len(l) != 1 || l[0].GetChatId() != chatID || l[0].GetChatPts() != resp.GetState().GetChatPts() {
		t.Fatalf("large_chats = %v", l)
	}
}

func TestTooLongAndEpoch(t *testing.T) {
	h := newHarness(t, nil)
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	for i := range 5 {
		h.send(a, chatID, fmt.Sprint(i))
	}
	ctx := context.Background()
	// Retention dropped the oldest entries.
	if _, err := h.st.Pool().Exec(ctx, `DELETE FROM user_updates WHERE user_id = $1 AND pts <= 2`, b); err != nil {
		t.Fatal(err)
	}
	resp, err := h.svc.GetDifference(ctx, b, &appv1.GetDifferenceRequest{Pts: 1, ServerEpoch: h.svc.Epoch()})
	if err != nil || resp.GetTooLong() == nil {
		t.Fatalf("difference over a dropped range = %v, %v", resp, err)
	}
	if resp, err := h.svc.GetDifference(ctx, b, &appv1.GetDifferenceRequest{Pts: 2, ServerEpoch: h.svc.Epoch()}); err != nil || len(resp.GetFull().GetUpdates()) != 4 {
		t.Fatalf("difference from the retained edge = %v, %v", resp, err)
	}
	if resp, err := h.svc.GetDifference(ctx, b, &appv1.GetDifferenceRequest{Pts: 99, ServerEpoch: h.svc.Epoch()}); err != nil || resp.GetTooLong() == nil {
		t.Fatalf("difference from the future = %v, %v", resp, err)
	}
	// Failover or restore: operators bump the epoch.
	old := h.svc.Epoch()
	if _, err := h.st.Pool().Exec(ctx, `UPDATE server_meta SET server_epoch = server_epoch + 1`); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.LoadEpoch(ctx); err != nil {
		t.Fatal(err)
	}
	if h.svc.Epoch() != old+1 || h.sink.resyncs != 1 {
		t.Fatalf("epoch %d, resyncs %d", h.svc.Epoch(), h.sink.resyncs)
	}
	if resp, err := h.svc.GetDifference(ctx, b, &appv1.GetDifferenceRequest{Pts: 6, ServerEpoch: old}); err != nil || resp.GetTooLong() == nil ||
		resp.GetState().GetServerEpoch() != old+1 {
		t.Fatalf("difference with the old epoch = %v, %v", resp, err)
	}
	if ack := h.send(a, chatID, "after").GetAck(); ack.GetServerEpoch() != old+1 {
		t.Fatalf("ack epoch = %d", ack.GetServerEpoch())
	}
}

func TestTenantsAreIsolated(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	if err := h.st.EnsureTenant(ctx, "other", "inetdev.io.vn", "inetdev.io.vn"); err != nil {
		t.Fatal(err)
	}
	other := newHarnessOn(t, h.st, "other", nil)
	a, b := h.user("a"), h.user("b")
	stranger := other.user("stranger")
	chatID := h.group(a, b)
	if _, _, err := other.svc.GetChat(ctx, stranger, chatID); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("other tenant reads the chat: %v", err)
	}
	if _, err := other.svc.SendMessage(ctx, stranger, &appv1.SendMessageRequest{ChatId: chatID, Text: "hi"}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("other tenant posts: %v", err)
	}
	failed, _, err := h.svc.AddMembers(ctx, a, chatID, []int64{stranger})
	if err != nil || !slices.Equal(failed, []int64{stranger}) {
		t.Fatalf("adding a user of another tenant: %v %v", failed, err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, a, stranger); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("private chat across tenants: %v", err)
	}
	if users, err := h.svc.GetUsers(ctx, a, []int64{stranger, b}); err != nil || len(users) != 1 || users[0].GetId() != b {
		t.Fatalf("GetUsers across tenants = %v, %v", users, err)
	}
	if found, err := h.svc.SearchUsers(ctx, a, "stranger", 10); err != nil || len(found) != 0 {
		t.Fatalf("search across tenants = %v, %v", found, err)
	}
	if _, err := other.svc.JoinByInvite(ctx, stranger, inviteOf(t, h, a, chatID)); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("invite used from another tenant: %v", err)
	}
}

func inviteOf(t *testing.T, h *harness, admin, chatID int64) string {
	t.Helper()
	inv, err := h.svc.ExportInviteLink(context.Background(), admin, chatID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	return inv.GetLink()
}

func TestSweeperDeliversWhatTheDispatcherMissed(t *testing.T) {
	h := newHarness(t, nil)
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	h.drain()
	ctx := context.Background()
	st := &sweepState{pending: map[int64]time.Time{}}
	if err := h.st.Pool().QueryRow(ctx, `SELECT coalesce(max(id), 0) FROM outbox`).Scan(&st.cursor); err != nil {
		t.Fatal(err)
	}
	// The dispatcher is gone (queue full or stopped): the event is only in
	// the outbox.
	h.svc.dispatch.stop()
	before := len(h.sink.updatesOf(b))
	sent := h.send(a, chatID, "missed")
	// A revoked session reaches the outbox through the trigger.
	sessID, err := h.st.CreateSession(ctx, newSessionFor(a))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.RevokeOtherSessions(ctx, testTenant, a, 0); err != nil {
		t.Fatal(err)
	}
	// Young rows wait for the dispatcher; age them past the grace period.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE outbox SET created_at = created_at - interval '1 second' WHERE kind <> 'session_revoked'`); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.sweep(ctx, st); err != nil {
		t.Fatal(err)
	}
	got := h.sink.updatesOf(b)[before:]
	if len(got) != 1 || got[0].GetMessageNew().GetMessage().GetSeq() != sent.GetMessage().GetSeq() || got[0].GetPts() == 0 {
		t.Fatalf("sweeper delivered %v", got)
	}
	if !slices.Contains(h.sink.revoked, sessID) {
		t.Fatalf("revoked sessions %v, want %d", h.sink.revoked, sessID)
	}
	// A second sweep delivers nothing twice.
	if err := h.svc.sweep(ctx, st); err != nil {
		t.Fatal(err)
	}
	if n := len(h.sink.updatesOf(b)[before:]); n != 1 {
		t.Fatalf("delivered %d times", n)
	}
}

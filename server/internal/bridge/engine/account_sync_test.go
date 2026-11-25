package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"image/color"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/contracttest"
	"app.local/server/internal/bridge/engine"
)

// chatOf is the chat that copies a conversation, 0 when it has none.
func (e *env) chatOf(conv string) int64 {
	var id int64
	_ = e.st.Pool().QueryRow(context.Background(), `SELECT chat_id FROM external_chats WHERE account_id = $1 AND external_chat_id = $2`, e.account, conv).Scan(&id)
	return id
}

func (e *env) syncState() string {
	var s string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT sync_state FROM external_accounts WHERE id = $1`, e.account).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func TestOneSwitchSyncsEveryConversationAndGoesLive(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	e.group("g2")
	e.fake.AddHistory("g2", e.msg("n1", minh, "nhóm hai", 2))
	e.fake.AddConversation(bridge.Conversation{ID: "p1", Kind: bridge.ConvPrivate, Title: "Lan", Peer: &lan})
	e.fake.AddHistory("p1", e.msg("q1", lan, "chào", 3))
	eng := e.start()

	time.Sleep(200 * time.Millisecond)
	if e.chatOf("g1") != 0 || e.syncState() != engine.SyncOff {
		t.Fatalf("something was synced before the switch was turned on (state %s)", e.syncState())
	}
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.chatOf("g1") != 0 && e.chatOf("g2") != 0 && e.chatOf("p1") != 0 },
		func() string { return "not every conversation got a chat" })
	e.waitTexts(e.chatOf("g1"), []string{"nhóm một"})
	e.waitTexts(e.chatOf("g2"), []string{"nhóm hai"})
	e.waitTexts(e.chatOf("p1"), []string{"chào"})
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	// every chat is two-way
	var both int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_chats WHERE account_id = $1 AND direction = 'both'`, e.account).Scan(&both); err != nil || both != 3 {
		t.Fatalf("%d two-way chats (err %v), want 3", both, err)
	}
	// turning it on again changes nothing
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil || e.syncState() != engine.SyncLive {
		t.Fatalf("again: %v, state %s", err, e.syncState())
	}
}

func TestAConversationThatAppearsLaterJoinsOnItsOwnWithItsMessage(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })

	// somebody writes from a conversation Chat has never seen
	e.group("g3")
	first := e.msg("x1", minh, "nhóm mới", 5)
	first.Conversation = "g3"
	e.fake.Push(bridge.Event{Message: &first})
	e.eventually(func() bool { return e.chatOf("g3") != 0 }, func() string { return "the new conversation got no chat" })
	e.waitTexts(e.chatOf("g3"), []string{"nhóm mới"})
}

func TestAConversationTheOtherAppRefusesDoesNotStopTheSyncOfTheOthers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	e.group("bad")
	e.fake.AddHistory("bad", e.msg("b1", lan, "không đọc được", 1))
	e.group("g2")
	e.fake.AddHistory("g2", e.msg("n1", minh, "nhóm hai", 2))
	e.fake.SetGroupInfoRemotely("g2", bridge.GroupInfo{Title: "Nhóm hai đổi tên", About: ""})
	e.fake.SetDialogState("g2", bridge.DialogState{Pinned: true})
	e.fake.Refuse("bad")
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	e.waitTexts(e.chatOf("g1"), []string{"nhóm một"})
	e.waitTexts(e.chatOf("g2"), []string{"nhóm hai"})
	// the looks at the state go on past the refused conversation
	e.eventually(func() bool { t2, _ := e.chatInfo(e.chatOf("g2")); return t2 == "Nhóm hai đổi tên" }, func() string { return "the info of g2 did not come in" })
	e.waitOwner(e.chatOf("g2"), func(s ownerState) bool { return s.pinned }, "the state of g2 did not come in")
	// and the account was never reconnected for it
	if n := e.fake.SubscribeCalls(); n != 1 {
		t.Fatalf("the account connected %d times: a refusal stopped its sync", n)
	}
}

func TestAnImportedConversationRefusedLaterDoesNotKeepTheAccountReconnecting(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.fake.Refuse("g1") // its pins, topics, state and info are refused from now on
	e.start()           // a new run reads the pins of every imported chat first
	time.Sleep(500 * time.Millisecond)
	if n := e.fake.SubscribeCalls(); n != 2 {
		t.Fatalf("the account connected %d times over two runs: a refusal stopped a run", n)
	}
	// and it still takes what comes
	m := e.msg("m3", lan, "tin mới", 3)
	e.fake.Push(bridge.Event{Message: &m})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin mới"})
}

func TestAReadTheOtherAppRefusedIsNotAskedAgainEveryLook(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	e.group("bad")
	e.fake.AddHistory("bad", e.msg("b1", lan, "bị từ chối", 1))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	e.fake.Refuse("bad")
	// many looks: the invites of each group are read once in five
	e.eventually(func() bool { return e.fake.InviteReads("g1") >= 4 }, func() string { return "the invites are not read" })
	if n := e.fake.InviteReads("bad"); n > 2 {
		t.Fatalf("the refused conversation was asked %d times, want it left alone after the refusal", n)
	}
}

func (e *env) directionOf(conv string) string {
	var d string
	_ = e.st.Pool().QueryRow(context.Background(), `SELECT direction FROM external_chats WHERE account_id = $1 AND external_chat_id = $2`, e.account, conv).Scan(&d)
	return d
}

func TestAGroupDeletedInTheOtherAppKeepsItsCopyReadOnlyAndOneOnlyMissingStaysTwoWay(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.fake.AddConversation(bridge.Conversation{ID: "gone", Kind: bridge.ConvChannel, Title: "Kênh bị xoá", Ref: "hash-1"})
	e.group("archived")
	e.group("kept")
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })

	e.fake.Remove("gone", true)
	e.fake.Remove("archived", false)
	e.eventually(func() bool { return e.directionOf("gone") == "in" },
		func() string { return "the deleted channel's copy is still " + e.directionOf("gone") })
	if ref, _ := e.fake.GoneRef("gone"); ref != "hash-1" {
		t.Fatalf("asked with ref %q, want the one listed before (hash-1)", ref)
	}
	if _, asked := e.fake.GoneRef("archived"); !asked {
		t.Fatal("the archived chat was never asked about")
	}
	if d := e.directionOf("archived"); d != "both" {
		t.Fatalf("a chat only missing from the list became %q, want both", d)
	}
	if d := e.directionOf("kept"); d != "both" {
		t.Fatalf("a listed chat became %q", d)
	}
	if e.chatOf("gone") == 0 {
		t.Fatal("the copy of the deleted channel was removed, want it kept read-only")
	}
}

func TestAConversationGoneFromTheOtherAppWhoseCopyWasDeletedInChatIsNotReadAnyMore(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	e.group("dead")
	e.fake.AddHistory("dead", e.msg("d1", lan, "nhóm bị xoá ở cả hai bên", 1))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	copyID := e.chatOf("dead")
	e.waitTexts(copyID, []string{"nhóm bị xoá ở cả hai bên"})

	// the conversation is deleted in the other app, then its copy in Chat
	e.fake.Remove("dead", true)
	if _, err := e.st.Pool().Exec(ctx, `UPDATE chats SET deleted_at = now() WHERE id = $1`, copyID); err != nil {
		t.Fatal(err)
	}
	// the engine lets the link go at its next listing; the reads of the group stop
	e.eventually(func() bool { return e.chatOf("dead") == 0 }, func() string { return "the link of the deleted copy is still there" })
	after := e.fake.InviteReads("dead")
	base := e.fake.InviteReads("g1")
	e.eventually(func() bool { return e.fake.InviteReads("g1") >= base+4 }, func() string { return "the looks do not go on" })
	if n := e.fake.InviteReads("dead"); n != after {
		t.Fatalf("the deleted copy was still read: %d reads, then %d", after, n)
	}
	if n := e.fake.SubscribeCalls(); n != 1 {
		t.Fatalf("the account connected %d times: the deleted conversation stopped its sync", n)
	}
	var keys int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_messages WHERE chat_id = $1`, copyID).Scan(&keys); err != nil || keys != 0 {
		t.Fatalf("%d message keys of the deleted copy are left (err %v)", keys, err)
	}
}

func TestAConversationStillListedGetsANewCopyWithItsHistoryWhenItsCopyWasDeletedInChat(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "nhóm một", 1))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	old := e.chatOf("g1")
	e.waitTexts(old, []string{"nhóm một"})

	if _, err := e.st.Pool().Exec(ctx, `UPDATE chats SET deleted_at = now() WHERE id = $1`, old); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { id := e.chatOf("g1"); return id != 0 && id != old }, func() string { return "the conversation got no new copy" })
	e.waitTexts(e.chatOf("g1"), []string{"nhóm một"})
}

func TestAConnectedAccountRaisesTheReadOnlyChatsOfTheConversationsItListsAgain(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	// Two read-only copies, as a disconnect leaves them: g1 is still in the app, old is not.
	g1 := e.enable(e.group("g1"), 100)
	old := e.enable(bridge.Conversation{ID: "old", Kind: bridge.ConvGroup, Title: "Nhóm cũ"}, 100)
	if e.directionOf("g1") != "in" || e.directionOf("old") != "in" {
		t.Fatalf("directions before the sync = %q, %q; want both read-only", e.directionOf("g1"), e.directionOf("old"))
	}
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.directionOf("g1") == "both" }, func() string { return "the listed chat stayed read-only" })
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	if got := e.directionOf("old"); got != "in" {
		t.Fatalf("the chat of a conversation the app does not list = %q, want it left read-only", got)
	}
	seq := e.say(g1, "đi")
	e.waitOutbox(g1, seq, "send", "sent")
	if _, err := e.chat.SendMessage(ctx, e.owner, &appv1.SendMessageRequest{ChatId: old, Text: "x"}); err == nil {
		t.Fatal("a chat left read-only accepts messages")
	}
}

// heardOnlyApp is an app that lists only the conversations it heard and cannot say whether
// one is gone (as Zalo): the fake without its bridge.GoneChecker.
type heardOnlyApp struct {
	bridge.Adapter
	bridge.Sender
}

func TestAnAppThatCannotTellAGoneConversationRaisesItsReadOnlyChatsListedOrNot(t *testing.T) {
	e := newEnv(t)
	e.adapter = heardOnlyApp{e.fake, e.fake}
	ctx := context.Background()
	// A read-only copy of a conversation the app has not heard since it started.
	quiet := e.enable(bridge.Conversation{ID: "quiet", Kind: bridge.ConvPrivate, Title: "Lan", Peer: &lan}, 100)
	if got := e.directionOf("quiet"); got != "in" {
		t.Fatalf("direction before the sync = %q, want read-only", got)
	}
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.directionOf("quiet") == "both" }, func() string { return "the unlisted chat stayed read-only" })
	if _, err := e.chat.SendMessage(ctx, e.owner, &appv1.SendMessageRequest{ChatId: quiet, Text: "chào"}); err != nil {
		t.Fatalf("the raised chat refuses a message: %v", err)
	}
}

func TestAnAppThatCannotBeWrittenToNeverRaisesAChat(t *testing.T) {
	e := newEnv(t)
	e.adapter = readOnlyApp{e.fake}
	ctx := context.Background()
	e.group("g1")
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	if got := e.directionOf("g1"); got != "in" {
		t.Fatalf("direction = %q, want in", got)
	}
}

func TestALongWaitFromTheOtherAppDoesNotHoldUpLiveEventsAndTheImportResumesAfterIt(t *testing.T) {
	t.Cleanup(engine.SetMaxInlineWait(20 * time.Millisecond)) // first cleanup: runs after the engine stopped
	e := newEnv(t)
	ctx := context.Background()
	e.group("g0")
	e.fake.AddHistory("g0", e.msg("a1", lan, "một", 1))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.syncState() == engine.SyncLive }, func() string { return "state " + e.syncState() })
	g0 := e.chatOf("g0")

	// a conversation that appears now is asked for its history, and the other app says to wait
	const wait = 1500 * time.Millisecond
	e.group("g1")
	e.fake.AddHistory("g1", bridge.Message{Conversation: "g1", ID: "b1", From: lan, Text: "mới", Date: e.at(5), Version: 1})
	e.fake.FailBackfill(&bridge.RateLimitError{RetryAfter: wait})
	asked := time.Now()
	first := bridge.Message{Conversation: "g1", ID: "b2", From: minh, Text: "kích", Date: e.at(6), Version: 1}
	e.fake.Push(bridge.Event{Message: &first})
	time.Sleep(300 * time.Millisecond)

	// while the wait runs, a live message of an imported chat still arrives
	live := e.msg("a2", lan, "hai", 2)
	live.Conversation = "g0"
	e.fake.Push(bridge.Event{Message: &live})
	e.waitTexts(g0, []string{"một", "hai"})
	if g1 := e.chatOf("g1"); g1 != 0 && e.backfillDone(g1) {
		t.Fatal("the import of g1 finished inside the wait: the loop was held, or the wait was not kept")
	}

	// and the import goes on once the wait is over, not before
	e.eventually(func() bool { g1 := e.chatOf("g1"); return g1 != 0 && e.backfillDone(g1) }, func() string { return "g1 never imported" })
	if took := time.Since(asked); took < wait-200*time.Millisecond {
		t.Fatalf("g1 was imported after %v, before the %v wait was over", took, wait)
	}
	if got := fmt.Sprint(e.texts(e.chatOf("g1"))); !strings.Contains(got, "mới") {
		t.Fatalf("g1 texts = %s, want the imported history in it", got)
	}
}

func TestAnImportStoppedHalfWayByAWaitGoesOnFromThePageItReached(t *testing.T) {
	t.Cleanup(engine.SetMaxInlineWait(20 * time.Millisecond)) // first cleanup: runs after the engine stopped
	e := newEnv(t)
	ctx := context.Background()
	e.group("g1")
	var want []string
	for i := 1; i <= 20; i++ { // three pages of seven
		text := fmt.Sprintf("tin %d", i)
		e.fake.AddHistory("g1", e.msg(fmt.Sprintf("m%d", i), lan, text, i))
		want = append(want, text)
	}
	want = append(want, "tin mới lúc chờ")
	e.fake.BeforePage = func(conv string, page int) {
		if conv == "g1" && page == 2 {
			e.fake.FailBackfill(&bridge.RateLimitError{RetryAfter: 300 * time.Millisecond})
			// and a message arrives while the import waits, newer than every page read
			live := e.msg("m21", lan, "tin mới lúc chờ", 21)
			e.fake.Push(bridge.Event{Message: &live})
		}
	}
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { g1 := e.chatOf("g1"); return g1 != 0 && e.backfillDone(g1) }, func() string { return "g1 never imported" })
	e.waitTexts(e.chatOf("g1"), want)
	// page 1, page 2 refused with the wait, page 2 again, page 3: page 1 is not asked for twice
	if got := e.fake.BackfillCalls(); got != 4 {
		t.Fatalf("history calls = %d, want 4", got)
	}
}

// mediaWaitsOnce is an app that asks to wait at the waitAt-th file read (once), then serves files.
type mediaWaitsOnce struct {
	*contracttest.Fake
	mu     sync.Mutex
	waitAt int
	calls  int
	data   []byte
	// onWait runs when the wait is asked for (a test pushes what happens meanwhile).
	onWait func()
}

func (a *mediaWaitsOnce) FetchMedia(_ context.Context, _ bridge.Account, _ string) (bridge.MediaStream, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	if a.calls == a.waitAt {
		if a.onWait != nil {
			a.onWait()
		}
		return nil, &bridge.RateLimitError{RetryAfter: 300 * time.Millisecond}
	}
	return &bytesStream{Reader: bytes.NewReader(a.data), size: int64(len(a.data))}, nil
}

type bytesStream struct {
	*bytes.Reader
	size int64
}

func (s *bytesStream) Close() error     { return nil }
func (s *bytesStream) MimeType() string { return "image/jpeg" }
func (s *bytesStream) Size() int64      { return s.size }

func TestAFileTheOtherAppMakesWaitForIsCopiedAfterTheWaitNotLabelled(t *testing.T) {
	t.Cleanup(engine.SetMaxInlineWait(20 * time.Millisecond)) // first cleanup: runs after the engine stopped
	e := newEnvWithMedia(t, true)
	app := &mediaWaitsOnce{Fake: e.fake, waitAt: 1, data: jpegOf(t, color.RGBA{B: 200, A: 255})}
	e.adapter = app
	ctx := context.Background()
	e.group("g1")
	photo := e.msg("m1", lan, "", 1)
	photo.Media = []bridge.Media{{Kind: "photo", Ref: "g1/1"}}
	e.fake.AddHistory("g1", photo, e.msg("m2", lan, "sau ảnh", 2))
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { g1 := e.chatOf("g1"); return g1 != 0 && e.backfillDone(g1) }, func() string { return "g1 never imported" })
	var labelled, withFile int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FILTER (WHERE text = '[Ảnh]'), count(*) FILTER (WHERE text = '') FROM messages WHERE chat_id = $1`, e.chatOf("g1")).Scan(&labelled, &withFile); err != nil {
		t.Fatal(err)
	}
	app.mu.Lock()
	calls := app.calls
	app.mu.Unlock()
	if labelled != 0 || withFile != 1 || calls != 2 {
		t.Fatalf("labelled %d, with the file %d, reads %d; want the photo copied on the read after the wait", labelled, withFile, calls)
	}
}

func TestAWaitForAFileKeepsWhatCameBeforeItAndAnEditMadeMeanwhileReachesIt(t *testing.T) {
	t.Cleanup(engine.SetMaxInlineWait(20 * time.Millisecond)) // first cleanup: runs after the engine stopped
	e := newEnvWithMedia(t, true)
	ctx := context.Background()
	e.group("g1")
	// batches of five: the first is text, the second starts with two photos, the other app asks to wait at the second
	var hist []bridge.Message
	for i := 1; i <= 5; i++ {
		hist = append(hist, e.msg(fmt.Sprintf("m%d", i), lan, fmt.Sprintf("tin %d", i), i))
	}
	for i := 6; i <= 7; i++ {
		p := e.msg(fmt.Sprintf("m%d", i), lan, "", i)
		p.Media = []bridge.Media{{Kind: "photo", Ref: fmt.Sprintf("g1/%d", i)}}
		hist = append(hist, p)
	}
	e.fake.AddHistory("g1", hist...)
	app := &mediaWaitsOnce{Fake: e.fake, waitAt: 2, data: jpegOf(t, color.RGBA{R: 90, A: 255})}
	app.onWait = func() {
		// during the wait, someone edits a message the first batch already wrote
		edited := e.msg("m2", lan, "tin 2 (đã sửa)", 2)
		edited.Version = 2
		e.fake.Push(bridge.Event{Edit: &bridge.Edit{Message: edited}})
	}
	e.adapter = app
	eng := e.start()
	if err := eng.StartSync(ctx, e.owner, e.account); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { g1 := e.chatOf("g1"); return g1 != 0 && e.backfillDone(g1) }, func() string { return "g1 never imported" })
	e.waitTexts(e.chatOf("g1"), []string{"tin 1", "tin 2 (đã sửa)", "tin 3", "tin 4", "tin 5"})
	var photos int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FROM messages WHERE chat_id = $1 AND text = ''`, e.chatOf("g1")).Scan(&photos); err != nil || photos != 2 {
		t.Fatalf("photo messages = %d, %v; want both photos copied, not labelled", photos, err)
	}
	app.mu.Lock()
	calls := app.calls
	app.mu.Unlock()
	// m6 copied, m7 asked to wait (m6 written meanwhile), m7 again: m6 is not fetched twice
	if calls != 3 {
		t.Fatalf("file reads = %d, want 3", calls)
	}
}

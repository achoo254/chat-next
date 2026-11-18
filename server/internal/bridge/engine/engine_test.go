package engine_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/contracttest"
	"app.local/server/internal/bridge/engine"
	"app.local/server/internal/chat"
	"app.local/server/internal/ids"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/media"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"google.golang.org/protobuf/proto"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

type allowAll struct{}

func (allowAll) Allow(ratelimit.Rule, string) bool { return true }

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

var (
	me   = bridge.Participant{ID: "me", Name: "Chủ", IsSelf: true}
	lan  = bridge.Participant{ID: "u-lan", Name: "Lan"}
	minh = bridge.Participant{ID: "u-minh", Name: "Minh"}
)

// env is a Chat server, an external account of its owner, and a fake app.
type env struct {
	t       *testing.T
	st      *store.Store
	chat    *chat.Service
	fake    *contracttest.Fake
	box     interface{ Seal(p, aad []byte) []byte }
	owner   int64
	account int64
	base    time.Time
	media   *media.Service
	// adapter, when set, stands in for the fake in the engine's adapter set.
	adapter bridge.Adapter

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

func newEnv(t *testing.T) *env { return newEnvWithMedia(t, false) }

// newEnvWithMedia is newEnv with a file store, for what sends files.
func newEnvWithMedia(t *testing.T, withMedia bool) *env {
	t.Helper()
	ctx := context.Background()
	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, "primary", "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	gen, err := ids.NewSnowflake(7)
	if err != nil {
		t.Fatal(err)
	}
	previews := linkpreview.NewService(st.Pool(), linkpreview.NewFetcher(linkpreview.Options{}), quiet)
	var mediaSvc *media.Service
	if withMedia {
		files, err := media.NewFilesystem(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		if mediaSvc, err = media.New(media.Config{TenantID: "primary", PublicOrigin: "https://media.example.test", UploadMaxBytes: 50 << 20,
			UserQuotaBytes: 1 << 30, SessionKey: bytes.Repeat([]byte{5}, 32)}, st.Pool(), files, allowAll{}, quiet); err != nil {
			t.Fatal(err)
		}
	}
	svc, err := chat.New(chat.Config{TenantID: "primary", PublicOrigin: "https://chat.example.test", AppScheme: "com.example.chat"},
		chat.Deps{Pool: st.Pool(), IDs: gen, Previews: previews, Media: mediaSvc, Limiter: allowAll{}, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Stop)
	u, err := st.UpsertIdPUser(ctx, "primary", store.IdPProfile{Sub: "acc_owner", PreferredUsername: "owner", Name: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	box, err := bridge.NewSecretBox(bytes.Repeat([]byte{3}, 32), nil)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, st: st, chat: svc, fake: contracttest.NewFake("fake"), box: box, owner: u.ID, media: mediaSvc,
		base: time.Now().Add(-48 * time.Hour).Truncate(time.Second)}
	if err := st.Pool().QueryRow(ctx, `INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'fake', 'fake-user-1', '\x00') RETURNING id`,
		u.ID).Scan(&e.account); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE external_accounts SET secret = $2 WHERE id = $1`, e.account,
		box.Seal([]byte("fake-session"), bridge.SecretAAD(e.account, u.ID, "fake"))); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.stop)
	return e
}

func (e *env) engine() *engine.Engine {
	box, _ := bridge.NewSecretBox(bytes.Repeat([]byte{3}, 32), nil)
	var adapter bridge.Adapter = e.fake
	if e.adapter != nil {
		adapter = e.adapter
	}
	return engine.New(engine.Config{TenantID: "primary", PageSize: 7, PageDelay: time.Millisecond, BatchSize: 5, BackoffMin: 10 * time.Millisecond,
		BackoffMax: 40 * time.Millisecond, ReconcileEvery: 30 * time.Millisecond, LeaseTTL: 2 * time.Second, Holder: "test",
		OutboxPoll: 10 * time.Millisecond, SendGap: time.Millisecond},
		engine.Deps{Pool: e.st.Pool(), Chat: e.chat, Box: box, Media: e.media, Adapters: map[string]bridge.Adapter{"fake": adapter}, Logger: quiet})
}

// start runs a new engine process (stopping the previous one first).
func (e *env) start() *engine.Engine {
	e.stop()
	eng := e.engine()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	e.mu.Lock()
	e.cancel, e.done = cancel, done
	e.mu.Unlock()
	go func() {
		defer close(done)
		eng.Run(ctx)
	}()
	return eng
}

func (e *env) stop() {
	e.mu.Lock()
	cancel, done := e.cancel, e.done
	e.cancel, e.done = nil, nil
	e.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (e *env) at(minutes int) time.Time { return e.base.Add(time.Duration(minutes) * time.Minute) }

func (e *env) msg(id string, from bridge.Participant, text string, minutes int) bridge.Message {
	return bridge.Message{Conversation: "g1", ID: id, From: from, Text: text, Date: e.at(minutes), Version: 1}
}

func (e *env) group(conv string) bridge.Conversation {
	c := bridge.Conversation{ID: conv, Kind: bridge.ConvGroup, Title: "Nhóm " + conv}
	e.fake.AddConversation(c)
	return c
}

// texts returns the live message texts of the chat in seq order.
func (e *env) texts(chatID int64) []string {
	e.t.Helper()
	rows, err := e.st.Pool().Query(context.Background(), `SELECT text FROM messages WHERE chat_id = $1 AND deleted_at IS NULL AND text <> '' ORDER BY seq`, chatID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

// eventually waits for cond, failing the test with what() when it never holds.
func (e *env) eventually(cond func() bool, what func() string) {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	e.t.Fatalf("condition never held: %s", what())
}

func (e *env) waitTexts(chatID int64, want []string) {
	e.t.Helper()
	e.eventually(func() bool { return fmt.Sprint(e.texts(chatID)) == fmt.Sprint(want) },
		func() string { return fmt.Sprintf("texts = %v, want %v", e.texts(chatID), want) })
}

func (e *env) backfillDone(chatID int64) bool {
	var done bool
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT backfill_done FROM external_chats WHERE chat_id = $1`, chatID).Scan(&done); err != nil {
		return false
	}
	return done
}

func (e *env) enable(conv bridge.Conversation, window int) int64 {
	e.t.Helper()
	chatID, err := e.start().EnableChat(context.Background(), e.account, conv, window)
	if err != nil {
		e.t.Fatal(err)
	}
	return chatID
}

func numbered(e *env, from bridge.Participant, n int) []bridge.Message {
	out := make([]bridge.Message, n)
	for i := range out {
		out[i] = e.msg(fmt.Sprint(i+1), from, fmt.Sprintf("tin %d", i+1), i)
	}
	return out
}

func TestBackfillTakesTheNewestWindowInTimeOrder(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 30)...)
	chatID := e.enable(conv, 12)
	want := make([]string, 0, 12)
	for i := 19; i <= 30; i++ {
		want = append(want, fmt.Sprintf("tin %d", i))
	}
	e.waitTexts(chatID, want)
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill never finished" })

	// The dates of the other app, not the import time, order and show them.
	var first time.Time
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT min(date) FROM messages WHERE chat_id = $1 AND text <> ''`, chatID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if !first.Equal(e.at(18)) {
		t.Fatalf("oldest imported date = %v, want %v", first, e.at(18))
	}
	var unread int64
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT c.last_seq - r.read_inbox_max_seq FROM chats c JOIN chat_read_states r ON r.chat_id = c.id AND r.user_id = $2 AND r.topic_id = 0 WHERE c.id = $1`,
		chatID, e.owner).Scan(&unread); err != nil || unread != 0 {
		t.Fatalf("unread after backfill = %d, %v", unread, err)
	}
}

func TestRestartDoesNotDuplicateOrLose(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 10)...)
	chatID := e.enable(conv, 100)
	first := make([]string, 10)
	for i := range first {
		first[i] = fmt.Sprintf("tin %d", i+1)
	}
	e.waitTexts(chatID, first)
	e.fake.Push(bridge.Event{Message: ptr(e.msg("11", minh, "tin 11", 11))})
	e.waitTexts(chatID, append(first, "tin 11"))

	// A new process: the account's state is stale on purpose, so the fake
	// replays the live event again.
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE external_accounts SET update_state = NULL WHERE id = $1`, e.account); err != nil {
		t.Fatal(err)
	}
	e.start()
	e.fake.Push(bridge.Event{Message: ptr(e.msg("12", lan, "tin 12", 12))})
	e.waitTexts(chatID, append(first, "tin 11", "tin 12"))
	time.Sleep(200 * time.Millisecond)
	if got := len(e.texts(chatID)); got != 12 {
		t.Fatalf("%d messages after a restart, want 12 (no duplicates)", got)
	}
}

func TestLiveMessageDuringBackfillComesAfterHistory(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 20)...)
	var pushed atomic.Bool
	e.fake.BeforePage = func(c string, page int) {
		if page == 2 && pushed.CompareAndSwap(false, true) {
			e.fake.Push(bridge.Event{Message: ptr(e.msg("21", minh, "tin 21", 21))})
		}
	}
	chatID := e.enable(conv, 100)
	want := make([]string, 0, 21)
	for i := 1; i <= 21; i++ {
		want = append(want, fmt.Sprintf("tin %d", i))
	}
	e.waitTexts(chatID, want)
	if !pushed.Load() {
		t.Fatal("the live message was never pushed during the import")
	}
}

func TestEditBeforeOriginalKeepsTheNewestText(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("1", lan, "mở đầu", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"mở đầu"})
	edited := e.msg("2", lan, "bản đã sửa", 5)
	edited.Version = 2
	e.fake.Push(bridge.Event{Edit: &bridge.Edit{Message: edited}})
	e.fake.Push(bridge.Event{Message: ptr(e.msg("2", lan, "bản gốc", 5))})
	e.waitTexts(chatID, []string{"mở đầu", "bản đã sửa"})
	time.Sleep(150 * time.Millisecond)
	e.waitTexts(chatID, []string{"mở đầu", "bản đã sửa"})
}

func TestEditAndDeleteOfOldMessages(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 3)...)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	// The messages are two days old: neither the 48-hour edit window nor
	// authorship applies to an import.
	older := e.msg("1", lan, "tin 1 sửa", 0)
	older.Version = 9
	e.fake.Push(bridge.Event{Edit: &bridge.Edit{Message: older}})
	e.fake.Push(bridge.Event{Delete: &bridge.Delete{Conversation: "g1", IDs: []string{"2"}}})
	e.waitTexts(chatID, []string{"tin 1 sửa", "tin 3"})
}

func TestDeleteWithoutChatAndDeleteBeforeMessage(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 2)...)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	// A delete that names no conversation finds the message by id.
	e.fake.Push(bridge.Event{Delete: &bridge.Delete{IDs: []string{"1"}}})
	e.waitTexts(chatID, []string{"tin 2"})
	// A delete that arrives before its message: the message never shows.
	e.fake.Push(bridge.Event{Delete: &bridge.Delete{Conversation: "g1", IDs: []string{"3"}}})
	e.fake.Push(bridge.Event{Message: ptr(e.msg("3", lan, "đã xoá trước", 3))})
	e.fake.Push(bridge.Event{Message: ptr(e.msg("4", lan, "tin 4", 4))})
	e.waitTexts(chatID, []string{"tin 2", "tin 4"})
}

func TestReplyBeforeOriginalIsWiredWhenItArrives(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "no backfill" })
	reply := e.msg("2", minh, "trả lời", 2)
	reply.ReplyTo = "1"
	e.fake.Push(bridge.Event{Message: &reply})
	e.fake.Push(bridge.Event{Message: ptr(e.msg("1", lan, "gốc", 1))})
	e.waitTexts(chatID, []string{"trả lời", "gốc"})
	e.eventually(func() bool {
		var replyTo, original int64
		err := e.st.Pool().QueryRow(context.Background(), `
			SELECT (SELECT reply_to_seq FROM messages WHERE chat_id = $1 AND text = 'trả lời'),
				(SELECT seq FROM messages WHERE chat_id = $1 AND text = 'gốc')`, chatID).Scan(&replyTo, &original)
		return err == nil && replyTo != 0 && replyTo == original
	}, func() string { return "the reply never pointed at the original" })
}

func TestParticipantsBecomeMembersAndOwnMessagesAreTheOwners(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("1", lan, "xin chào", 0), e.msg("2", me, "chào lại", 1), e.msg("3", minh, "tôi vào sau", 2))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"xin chào", "chào lại", "tôi vào sau"})
	var members, owned, puppets int
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT (SELECT count(*) FROM chat_members WHERE chat_id = $1 AND left_at IS NULL),
			(SELECT count(*) FROM messages WHERE chat_id = $1 AND from_id = $2 AND text = 'chào lại'),
			(SELECT count(*) FROM users WHERE external_source = 'fake')`, chatID, e.owner).Scan(&members, &owned, &puppets); err != nil {
		t.Fatal(err)
	}
	if members != 3 || owned != 1 || puppets != 2 {
		t.Fatalf("members = %d (want owner + 2 puppets), owner's messages = %d (want 1), puppets = %d (want 2)", members, owned, puppets)
	}
}

func TestPrivateConversationIsAPrivateChatWithAPuppet(t *testing.T) {
	e := newEnv(t)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan, "chào đại ca", 0), e.msg("2", me, "chào Lan", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào đại ca", "chào Lan"})
	var typ string
	var members int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT type, member_count FROM chats WHERE id = $1`, chatID).Scan(&typ, &members); err != nil {
		t.Fatal(err)
	}
	if typ != "private" || members != 2 {
		t.Fatalf("chat = %s with %d members, want private with 2", typ, members)
	}
}

func TestRateLimitWaitsAndContinues(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 6)...)
	e.fake.FailBackfill(&bridge.RateLimitError{RetryAfter: 30 * time.Millisecond})
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3", "tin 4", "tin 5", "tin 6"})
}

func TestDisconnectReconnectsFromTheSavedState(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "no backfill" })
	e.fake.FailSubscribe(errors.New("connection reset"))
	e.fake.Push(bridge.Event{Message: ptr(e.msg("1", lan, "một", 1))})
	e.fake.Push(bridge.Event{Message: ptr(e.msg("2", lan, "hai", 2))})
	e.waitTexts(chatID, []string{"một", "hai"})
	if e.fake.SubscribeCalls() < 1 {
		t.Fatal("never subscribed")
	}
}

func TestRevokedSessionStopsTheAccount(t *testing.T) {
	e := newEnv(t)
	e.fake.FailSubscribe(bridge.ErrSessionRevoked)
	e.start()
	e.eventually(func() bool {
		var status string
		_ = e.st.Pool().QueryRow(context.Background(), `SELECT status FROM external_accounts WHERE id = $1`, e.account).Scan(&status)
		return status == "needs_login"
	}, func() string { return "the account never asked for a new login" })
	calls := e.fake.SubscribeCalls()
	time.Sleep(150 * time.Millisecond)
	if e.fake.SubscribeCalls() != calls {
		t.Fatal("a revoked account kept reconnecting")
	}
}

func TestOnlyOneProcessHoldsAnAccount(t *testing.T) {
	e := newEnv(t)
	if _, err := e.st.Pool().Exec(context.Background(),
		`UPDATE external_accounts SET lease_holder = 'another-process', lease_until = now() + interval '1 hour' WHERE id = $1`, e.account); err != nil {
		t.Fatal(err)
	}
	e.start()
	time.Sleep(200 * time.Millisecond)
	if e.fake.SubscribeCalls() != 0 {
		t.Fatalf("subscribed %d times while another process holds the account", e.fake.SubscribeCalls())
	}
}

func TestErasedAccountIsLoggedOutOfTheOtherApp(t *testing.T) {
	e := newEnv(t)
	e.start()
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE users SET deleted_at = now() WHERE id = $1`, e.owner); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.fake.LogoutCalls() == 1 }, func() string { return fmt.Sprintf("logout calls = %d", e.fake.LogoutCalls()) })
	e.eventually(func() bool {
		var n int
		_ = e.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM external_logouts`).Scan(&n)
		return n == 0
	}, func() string { return "the logout stayed queued" })
}

func TestRemovedChatStopsSyncing(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	chatID := e.enable(conv, 100)
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "no backfill" })
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE chats SET deleted_at = now() WHERE id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	e.fake.Push(bridge.Event{Message: ptr(e.msg("1", lan, "vào chat đã xoá", 1))})
	e.fake.Push(bridge.Event{Message: ptr(e.msg("2", lan, "vẫn không sao", 2))})
	e.eventually(func() bool {
		var n int
		_ = e.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM external_chats WHERE chat_id = $1`, chatID).Scan(&n)
		return n == 0
	}, func() string { return "the link of a deleted chat stayed" })
}

func ptr[T any](v T) *T { return &v }

func TestBackfillInterruptedHalfWayResumesWithoutDuplicates(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 10)...)
	chatID := e.enable(conv, 100)
	first := make([]string, 10)
	for i := range first {
		first[i] = fmt.Sprintf("tin %d", i+1)
	}
	e.waitTexts(chatID, first)
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "no backfill" })
	e.stop()
	// The process died after importing the first ten messages, before it
	// marked the chat as caught up; more history is there when it returns.
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE external_chats SET backfill_done = false WHERE chat_id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	more := make([]bridge.Message, 0, 10)
	for i := 11; i <= 20; i++ {
		more = append(more, e.msg(fmt.Sprint(i), lan, fmt.Sprintf("tin %d", i), i))
	}
	e.fake.AddHistory("g1", more...)
	e.start()
	want := make([]string, 0, 20)
	for i := 1; i <= 20; i++ {
		want = append(want, fmt.Sprintf("tin %d", i))
	}
	e.waitTexts(chatID, want)
}

func TestLoginCreatesASealedActiveAccount(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	eng := e.engine()
	first, err := eng.StartLogin(ctx, e.owner, "fake")
	if err != nil || first.Kind != bridge.StepInput || first.LoginID == "" {
		t.Fatalf("start = %+v, %v", first, err)
	}
	second, err := eng.ContinueLogin(ctx, e.owner, first.LoginID, map[string]string{"phone": "+84900000000"})
	if err != nil || second.LoginID != first.LoginID {
		t.Fatalf("phone step = %+v, %v", second, err)
	}
	var wrong *bridge.InputError
	if _, err := eng.ContinueLogin(ctx, e.owner, second.LoginID, map[string]string{"code": "00000"}); !errors.As(err, &wrong) {
		t.Fatalf("a wrong code = %v, want an input error", err)
	}
	// Another user cannot use the open login.
	if _, err := eng.ContinueLogin(ctx, e.owner+1, second.LoginID, map[string]string{"code": "12345"}); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("login of another user = %v, want ErrNotFound", err)
	}
	done, err := eng.ContinueLogin(ctx, e.owner, second.LoginID, map[string]string{"code": "12345"})
	if err != nil || done.Kind != bridge.StepDone || done.AccountID != e.account {
		t.Fatalf("done = %+v, %v (the account of this user and external id already exists: it is reused)", done, err)
	}
	var status string
	var secret []byte
	if err := e.st.Pool().QueryRow(ctx, `SELECT status, secret FROM external_accounts WHERE id = $1`, e.account).Scan(&status, &secret); err != nil {
		t.Fatal(err)
	}
	box, _ := bridge.NewSecretBox(bytes.Repeat([]byte{3}, 32), nil)
	got, err := box.Open(secret, bridge.SecretAAD(e.account, e.owner, "fake"))
	if status != "active" || err != nil || string(got) != "fake-session" {
		t.Fatalf("status %q, session %q, %v", status, got, err)
	}
	if bytes.Contains(secret, []byte("fake-session")) {
		t.Fatal("the session is stored in the clear")
	}
	// The same external account cannot be connected by another user.
	other, err := e.st.UpsertIdPUser(ctx, "primary", store.IdPProfile{Sub: "acc_other", PreferredUsername: "other", Name: "other"})
	if err != nil {
		t.Fatal(err)
	}
	again, _ := eng.StartLogin(ctx, other.ID, "fake")
	step, _ := eng.ContinueLogin(ctx, other.ID, again.LoginID, map[string]string{"phone": "+84911111111"})
	if _, err := eng.ContinueLogin(ctx, other.ID, step.LoginID, map[string]string{"code": "12345"}); !errors.Is(err, engine.ErrAccountTaken) {
		t.Fatalf("connecting an account of another user = %v, want ErrAccountTaken", err)
	}
	if _, err := eng.StartLogin(ctx, e.owner, "nope"); !errors.Is(err, engine.ErrUnknownApp) {
		t.Fatalf("unknown app = %v", err)
	}
}

func TestConversationsMarkSyncedOnes(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	g1, g2 := e.group("g1"), e.group("g2")
	_ = g2
	eng := e.start()
	chatID, err := eng.EnableConversation(ctx, e.owner, e.account, g1.ID, 50, chat.DirectionIn)
	if err != nil {
		t.Fatal(err)
	}
	list, err := eng.Conversations(ctx, e.owner, e.account)
	if err != nil || len(list) != 2 {
		t.Fatalf("conversations = %v, %v", list, err)
	}
	for _, c := range list {
		if (c.ID == "g1") != (c.ChatID == chatID) {
			t.Fatalf("conversation %s has chat %d (g1 is chat %d)", c.ID, c.ChatID, chatID)
		}
	}
	if _, err := eng.Conversations(ctx, e.owner+1, e.account); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("conversations of another user's account = %v, want ErrNotFound", err)
	}
	if _, err := eng.EnableConversation(ctx, e.owner, e.account, g1.ID, engine.MaxWindow+1, chat.DirectionIn); err == nil {
		t.Fatal("a window above the maximum was accepted")
	}
}

func TestDisconnectKeepsReadOnlyChatsOrDeletesThem(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 3)...)
	eng := e.start()
	chatID, err := eng.EnableChat(ctx, e.account, conv, 100)
	if err != nil {
		t.Fatal(err)
	}
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	if err := eng.Disconnect(ctx, e.owner, e.account, false); err != nil {
		t.Fatal(err)
	}
	if e.fake.LogoutCalls() != 1 {
		t.Fatalf("logout calls = %d, want 1", e.fake.LogoutCalls())
	}
	var status string
	if err := e.st.Pool().QueryRow(ctx, `SELECT status FROM external_accounts WHERE id = $1`, e.account).Scan(&status); err != nil || status != "stopped" {
		t.Fatalf("status = %q, %v", status, err)
	}
	if _, err := e.chat.SendMessage(ctx, e.owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "x"}); err == nil {
		t.Fatal("a kept chat accepts messages after disconnecting")
	}
	if got := e.texts(chatID); len(got) != 3 {
		t.Fatalf("kept chat has %v", got)
	}
	// Removing it deletes the chat for good.
	if err := eng.RemoveChat(ctx, e.owner, e.account, "g1"); err != nil {
		t.Fatal(err)
	}
	var gone bool
	if err := e.st.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM chats WHERE id = $1`, chatID).Scan(&gone); err != nil || !gone {
		t.Fatalf("chat deleted = %v, %v", gone, err)
	}
}

func TestDisconnectTurnsATwoWayChatReadOnlyAndDropsWhatWasQueued(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 2)...)
	eng := e.start()
	chatID, err := eng.EnableChat(ctx, e.account, conv, 100)
	if err != nil {
		t.Fatal(err)
	}
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	if err := e.chat.SetImportedDirection(ctx, e.owner, chatID, chat.DirectionBoth); err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.SendMessage(ctx, e.owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "queued"}); err != nil {
		t.Fatal(err)
	}
	if err := eng.Disconnect(ctx, e.owner, e.account, false); err != nil {
		t.Fatal(err)
	}
	var direction string
	if err := e.st.Pool().QueryRow(ctx, `SELECT direction FROM external_chats WHERE chat_id = $1`, chatID).Scan(&direction); err != nil || direction != chat.DirectionIn {
		t.Fatalf("direction after disconnecting = %q, %v; want the chat read-only", direction, err)
	}
	var live int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_outbox WHERE chat_id = $1 AND status NOT IN ('sent', 'cancelled')`, chatID).Scan(&live); err != nil || live != 0 {
		t.Fatalf("%d queue rows still live after disconnecting, %v", live, err)
	}
}

func TestDisconnectWithDeleteRemovesEverything(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", numbered(e, lan, 2)...)
	eng := e.start()
	chatID, err := eng.EnableChat(ctx, e.account, conv, 100)
	if err != nil {
		t.Fatal(err)
	}
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	if err := eng.Disconnect(ctx, e.owner, e.account, true); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`SELECT count(*) FROM external_accounts`, `SELECT count(*) FROM external_chats`, `SELECT count(*) FROM external_users`,
		`SELECT count(*) FROM users WHERE external_source IS NOT NULL AND deleted_at IS NULL`} {
		var n int
		if err := e.st.Pool().QueryRow(ctx, q).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s = %d, %v, want 0", q, n, err)
		}
	}
}

func TestMessagesWithoutTextOrMediaChatCannotShowGetALabel(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	photo := e.msg("1", lan, "", 0)
	photo.Media = []bridge.Media{{Kind: "photo", Ref: "g1/1"}}
	captioned := e.msg("2", lan, "xem này", 1)
	captioned.Media = []bridge.Media{{Kind: "video", Ref: "g1/2"}}
	captioned.Entities = []bridge.Entity{{Kind: "bold", Offset: 0, Length: 3}}
	doc := e.msg("3", lan, "", 2)
	doc.Media = []bridge.Media{{Kind: "document", Name: "hợp đồng.pdf"}}
	poll := e.msg("4", lan, "", 3)
	poll.Media = []bridge.Media{{Kind: "poll"}}
	empty := e.msg("5", lan, "", 4)
	e.fake.AddHistory("g1", photo, captioned, doc, poll, empty)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"[Ảnh]", "[Video]\nxem này", "[Tệp: hợp đồng.pdf]", "[Bình chọn]", "[Tin nhắn không hỗ trợ]"})
	// The bold span moved with the text it styles ("[Video]\n" is 8 units).
	var raw []byte
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT content FROM messages WHERE chat_id = $1 AND text LIKE '[Video]%'`, chatID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var content appv1.Message
	if err := proto.Unmarshal(raw, &content); err != nil {
		t.Fatal(err)
	}
	if ents := content.GetEntities(); len(ents) != 1 || ents[0].GetOffset() != 8 || ents[0].GetLength() != 3 {
		t.Fatalf("entities = %v, want one bold span at offset 8", ents)
	}
}

func TestSpansChatRefusesDegradeToPlainTextWithoutLosingTheMessage(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	bad := e.msg("1", lan, "mở https://example.com ra", 0)
	bad.Entities = []bridge.Entity{{Kind: "bold", Offset: 0, Length: 3}, {Kind: "bold", Offset: 1, Length: 30}} // overlapping, out of range
	good := e.msg("2", lan, "tin sau", 1)
	e.fake.AddHistory("g1", bad, good)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"mở https://example.com ra", "tin sau"})
}

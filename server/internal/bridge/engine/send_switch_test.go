package engine_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/contracttest"
	"app.local/server/internal/bridge/engine"
	"app.local/server/internal/chat"
)

// gatedApp is the fake as an app written to only once the owner switches sending on.
type gatedApp struct{ *contracttest.Fake }

func (gatedApp) SendGated() {}

// newGatedEnv is newEnv with the fake gated per account.
func newGatedEnv(t *testing.T) *env {
	e := newEnv(t)
	e.adapter = gatedApp{e.fake}
	return e
}

// syncedG1 syncs the account's one conversation g1 (two imported messages) and returns its chat.
func (e *env) syncedG1(eng *engine.Engine) int64 {
	e.t.Helper()
	if err := eng.StartSync(context.Background(), e.owner, e.account); err != nil {
		e.t.Fatal(err)
	}
	e.eventually(func() bool { return e.chatOf("g1") != 0 }, func() string { return "g1 got no chat" })
	chatID := e.chatOf("g1")
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	return chatID
}

func (e *env) addG1() {
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1), e.msg("m2", lan, "tin 2", 2))
}

func (e *env) sendEnabledInDB() bool {
	var on bool
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT send_enabled FROM external_accounts WHERE id = $1`, e.account).Scan(&on); err != nil {
		e.t.Fatal(err)
	}
	return on
}

func (e *env) accountView(eng *engine.Engine) engine.AccountView {
	e.t.Helper()
	list, err := eng.Accounts(context.Background(), e.owner)
	if err != nil || len(list) != 1 {
		e.t.Fatalf("accounts = %v, %v", list, err)
	}
	return list[0]
}

func (e *env) outboxError(chatID, seq int64) string {
	var s string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT last_error FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = 'send'`, chatID, seq).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

// sendingOn syncs g1 with sending switched on and waits for the chat to become two-way.
func (e *env) sendingOn() (*engine.Engine, int64) {
	e.t.Helper()
	e.addG1()
	eng := e.start()
	chatID := e.syncedG1(eng)
	if err := eng.SetSendEnabled(context.Background(), e.owner, e.account, true); err != nil {
		e.t.Fatal(err)
	}
	e.eventually(func() bool { return e.direction(chatID) == chat.DirectionBoth }, func() string { return "the chat did not become two-way" })
	return eng, chatID
}

func TestAGatedAppStaysReadOnlyUntilTheOwnerSwitchesSendingOn(t *testing.T) {
	e := newGatedEnv(t)
	ctx := context.Background()
	if e.sendEnabledInDB() {
		t.Fatal("a new account starts with sending on")
	}
	e.addG1()
	eng := e.start()
	chatID := e.syncedG1(eng)
	if got := e.direction(chatID); got != chat.DirectionIn {
		t.Fatalf("direction while sending is off = %q, want in", got)
	}
	if err := eng.SetDirection(ctx, e.owner, e.account, "g1", chat.DirectionBoth); !errors.Is(err, engine.ErrSendUnsupported) {
		t.Fatalf("raising a chat while sending is off = %v, want ErrSendUnsupported", err)
	}
	if v := e.accountView(eng); !v.SendGated || v.SendEnabled {
		t.Fatalf("view gated=%v enabled=%v, want gated and off", v.SendGated, v.SendEnabled)
	}

	if err := eng.SetSendEnabled(ctx, e.owner, e.account, true); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return e.direction(chatID) == chat.DirectionBoth }, func() string { return "the chat did not become two-way" })
	if v := e.accountView(eng); !v.SendEnabled {
		t.Fatal("the view does not show sending on")
	}
	seq := e.say(chatID, "xin chào")
	e.waitOutbox(chatID, seq, "send", "sent")
	if got := sentTexts(e.fake); len(got) != 1 || got[0] != "xin chào" {
		t.Fatalf("sent = %v", got)
	}
}

func TestSwitchingSendingOffMakesChatsReadOnlyAndCancelsTheQueue(t *testing.T) {
	e := newGatedEnv(t)
	ctx := context.Background()
	_, chatID := e.sendingOn()
	e.stop() // so the message waits in the queue
	seq := e.say(chatID, "không đi")
	if err := e.engine().SetSendEnabled(ctx, e.owner, e.account, false); err != nil {
		t.Fatal(err)
	}
	if got := e.direction(chatID); got != chat.DirectionIn {
		t.Fatalf("direction after switching off = %q, want in", got)
	}
	if got := e.outboxStatus(chatID, seq, "send"); got != "cancelled" {
		t.Fatalf("queued message = %q, want cancelled", got)
	}
	if got := e.outboxError(chatID, seq); !strings.HasPrefix(got, "send_disabled") {
		t.Fatalf("reason = %q, want send_disabled", got)
	}
	e.start()
	time.Sleep(300 * time.Millisecond)
	if got := e.direction(chatID); got != chat.DirectionIn {
		t.Fatalf("a running account raised the chat again while sending is off (%q)", got)
	}
	if got := sentTexts(e.fake); len(got) != 0 {
		t.Fatalf("sent while off: %v", got)
	}
}

func TestARowQueuedBeforeSendingWentOffIsCancelledWhenItsTurnComes(t *testing.T) {
	e := newGatedEnv(t)
	_, chatID := e.sendingOn()
	e.stop()
	seq := e.say(chatID, "không đi")
	// the switch goes off without the queue being cleared (a row picked up meanwhile)
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE external_accounts SET send_enabled = false WHERE id = $1`, e.account); err != nil {
		t.Fatal(err)
	}
	e.start()
	e.waitOutbox(chatID, seq, "send", "cancelled")
	if got := sentTexts(e.fake); len(got) != 0 {
		t.Fatalf("sent while off: %v", got)
	}
}

func TestOnlyTheOwnerTurnsTheSendingSwitchOfAConnectedGatedAccount(t *testing.T) {
	e := newGatedEnv(t)
	ctx := context.Background()
	eng := e.engine()
	if err := eng.SetSendEnabled(ctx, e.owner+1, e.account, true); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("a stranger = %v, want ErrNotFound", err)
	}
	if err := eng.SetSendEnabled(ctx, e.owner, e.account+1000, true); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("an unknown account = %v, want ErrNotFound", err)
	}
	if _, err := e.st.Pool().Exec(ctx, `UPDATE external_accounts SET status = 'needs_login' WHERE id = $1`, e.account); err != nil {
		t.Fatal(err)
	}
	if err := eng.SetSendEnabled(ctx, e.owner, e.account, true); !errors.Is(err, engine.ErrSendUnsupported) {
		t.Fatalf("turning on for an account that is not connected = %v, want ErrSendUnsupported", err)
	}
	if err := eng.SetSendEnabled(ctx, e.owner, e.account, false); err != nil {
		t.Fatalf("turning off is always allowed: %v", err)
	}
	if e.sendEnabledInDB() {
		t.Fatal("the switch is on")
	}
}

func TestDisconnectTurnsTheSendingSwitchOff(t *testing.T) {
	e := newGatedEnv(t)
	eng, _ := e.sendingOn()
	if err := eng.Disconnect(context.Background(), e.owner, e.account, false); err != nil {
		t.Fatal(err)
	}
	if e.sendEnabledInDB() {
		t.Fatal("the switch stayed on after signing out")
	}
}

func TestAnAppThatIsNotGatedIgnoresTheSendingSwitch(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	eng := e.start()
	if err := eng.SetSendEnabled(ctx, e.owner, e.account, false); !errors.Is(err, engine.ErrSendUnsupported) {
		t.Fatalf("switching an app that is not gated = %v, want ErrSendUnsupported", err)
	}
	if got := e.direction(chatID); got != chat.DirectionBoth {
		t.Fatalf("direction = %q: the refused switch touched the chat", got)
	}
	if v := e.accountView(eng); v.SendGated || v.SendEnabled {
		t.Fatalf("view gated=%v enabled=%v, want neither", v.SendGated, v.SendEnabled)
	}
	// sends with the column off, and a failure it cannot classify is tried again on its own
	e.fake.FailSend(errors.New("connection reset"))
	seq := e.say(chatID, "đi")
	e.waitOutbox(chatID, seq, "send", "sent")
}

func TestAGatedSendThatFailedUnclassifiedWaitsForTheOwner(t *testing.T) {
	e := newGatedEnv(t)
	_, chatID := e.sendingOn()
	e.fake.FailSend(errors.New("sidecar gone"))
	seq := e.say(chatID, "có thể đã đi")
	e.waitOutbox(chatID, seq, "send", "unknown")
	time.Sleep(200 * time.Millisecond)
	if got := e.outboxStatus(chatID, seq, "send"); got != "unknown" {
		t.Fatalf("status = %q: the send was tried again on its own", got)
	}
	if got := sentTexts(e.fake); len(got) != 0 {
		t.Fatalf("sent = %v, want nothing", got)
	}
	// a wait the app asked for before taking anything is still waited out and tried again
	e.fake.FailSend(&bridge.RateLimitError{RetryAfter: 50 * time.Millisecond})
	next := e.say(chatID, "chờ rồi đi")
	e.waitOutbox(chatID, next, "send", "sent")
	// and the owner's retry sends the unknown one
	if err := e.engine().RetryMessage(context.Background(), e.owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "send", "sent")
}

func TestAGatedSendLeftInFlightIsUnknownWhenTheAccountStartsAgain(t *testing.T) {
	e := newGatedEnv(t)
	_, chatID := e.sendingOn()
	e.stop()
	seq := e.say(chatID, "đang đi dở")
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE external_outbox SET status = 'sending', attempts = 1 WHERE chat_id = $1 AND seq = $2`, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.start()
	e.waitOutbox(chatID, seq, "send", "unknown")
	time.Sleep(200 * time.Millisecond)
	if got := sentTexts(e.fake); len(got) != 0 {
		t.Fatalf("sent = %v: an interrupted send was repeated on its own", got)
	}
}

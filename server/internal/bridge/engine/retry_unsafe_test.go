package engine_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/contracttest"
	"app.local/server/internal/chat"
)

// noBlindRetryApp is the fake as an app whose sends must not be repeated blindly.
type noBlindRetryApp struct{ *contracttest.Fake }

func (noBlindRetryApp) RetryUnsafe() {}

// newNoBlindRetryEnv is newEnv with the fake marked bridge.RetryUnsafe.
func newNoBlindRetryEnv(t *testing.T) *env {
	e := newEnv(t)
	e.adapter = noBlindRetryApp{e.fake}
	return e
}

// syncedTwoWay syncs the account's one conversation g1 and waits for its chat to be
// two-way, as it is for any app Chat can write to once the account is connected.
func (e *env) syncedTwoWay() int64 {
	e.t.Helper()
	e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1), e.msg("m2", lan, "tin 2", 2))
	eng := e.start()
	if err := eng.StartSync(context.Background(), e.owner, e.account); err != nil {
		e.t.Fatal(err)
	}
	e.eventually(func() bool { return e.chatOf("g1") != 0 }, func() string { return "g1 got no chat" })
	chatID := e.chatOf("g1")
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	if got := e.direction(chatID); got != chat.DirectionBoth {
		e.t.Fatalf("direction of a connected account's chat = %q, want both", got)
	}
	return chatID
}

func TestAnAppThatCannotBeRetriedBlindlySyncsBothWaysWithoutAnyOtherStep(t *testing.T) {
	e := newNoBlindRetryEnv(t)
	chatID := e.syncedTwoWay()
	seq := e.say(chatID, "xin chào")
	e.waitOutbox(chatID, seq, "send", "sent")
	if got := sentTexts(e.fake); len(got) != 1 || got[0] != "xin chào" {
		t.Fatalf("sent = %v", got)
	}
}

func TestADoubtfulSendOfAnAppThatCannotBeRetriedBlindlyWaitsForTheOwner(t *testing.T) {
	e := newNoBlindRetryEnv(t)
	chatID := e.syncedTwoWay()
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
	// and the owner's retry sends the unknown one, telling the app it may repeat a call that went out
	if err := e.engine().RetryMessage(context.Background(), e.owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "send", "sent")
	checkRetryMarks(t, e.fake.Sent(), map[string]bool{"chờ rồi đi": false, "có thể đã đi": true})
}

// checkRetryMarks checks, per text sent, whether the app was told the call may
// repeat one that went out (OutMessage.RetrySince).
func checkRetryMarks(t *testing.T, sent []bridge.OutMessage, want map[string]bool) {
	t.Helper()
	if len(sent) != len(want) {
		t.Fatalf("sent %d messages, want %d", len(sent), len(want))
	}
	for _, m := range sent {
		marked, ok := want[m.Text]
		switch {
		case !ok:
			t.Errorf("sent %q, not expected", m.Text)
		case marked && (m.RetrySince.IsZero() || m.RetrySince.After(time.Now())):
			t.Errorf("%q: RetrySince = %v, want when the send was queued", m.Text, m.RetrySince)
		case !marked && !m.RetrySince.IsZero():
			t.Errorf("%q: RetrySince = %v on a send no earlier call may have made", m.Text, m.RetrySince)
		}
	}
}

func TestASendLeftInFlightOfAnAppThatCannotBeRetriedBlindlyIsUnknownAtTheNextStart(t *testing.T) {
	e := newNoBlindRetryEnv(t)
	chatID := e.syncedTwoWay()
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
	// The owner's retry, in this later run, still says the call may repeat one that went out.
	if err := e.engine().RetryMessage(context.Background(), e.owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "send", "sent")
	checkRetryMarks(t, e.fake.Sent(), map[string]bool{"đang đi dở": true})
}

func TestAnUnclassifiedSendFailureOfAnyOtherAppIsTriedAgainOnItsOwn(t *testing.T) {
	e := newEnv(t)
	chatID := e.syncedTwoWay()
	e.fake.FailSend(errors.New("connection reset"))
	seq := e.say(chatID, "đi")
	e.waitOutbox(chatID, seq, "send", "sent")
	if got := sentTexts(e.fake); len(got) != 1 || got[0] != "đi" {
		t.Fatalf("sent = %v", got)
	}
}

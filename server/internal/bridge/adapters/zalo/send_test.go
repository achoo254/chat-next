package zalo

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func out(rid int64, text string) bridge.OutMessage {
	return bridge.OutMessage{Conversation: "500", Text: text, RandomID: rid}
}

func send(t *testing.T, a *Adapter, m bridge.OutMessage) (bridge.SentRef, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return a.SendMessage(ctx, testAccount, m)
}

// waitPastLastTry lets the last unanswered try settle before the engine retries.
func waitPastLastTry(a *Adapter) { time.Sleep(a.timing.sendAnswer + 20*time.Millisecond) }

// The contract of bridge.Sender: a repeated RandomID creates no second message.
// A first-ever RandomID goes out directly, without reading the history.
func TestSendRepeatedRandomIDCreatesOneZaloMessage(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	first, err := send(t, a, out(1, "xin chào"))
	if err != nil {
		t.Fatal(err)
	}
	again, err := send(t, a, out(1, "xin chào"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first.IDs) != 1 || !slices.Equal(first.IDs, again.IDs) {
		t.Fatalf("refs = %v then %v, want one and the same id", first.IDs, again.IDs)
	}
	if z.created("xin chào") != 1 || z.sends() != 1 || z.historyReads() != 0 {
		t.Fatalf("created %d, sends %d, history reads %d; want 1, 1, 0", z.created("xin chào"), z.sends(), z.historyReads())
	}
}

// The engine reads events and sends from one goroutine: an answer must reach
// SendMessage while the listener's echo waits for the engine.
func TestSendIsAnsweredWhileTheEngineReadsNoEvents(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, true)
	if _, err := send(t, a, out(1, "một")); err != nil {
		t.Fatal(err)
	}
}

func TestSendLostAnswerIsFoundInTheEcho(t *testing.T) {
	z := newZaloSim(t)
	z.dropAnswers = 1
	a, _, _ := simAccount(t, z, false)
	if _, err := send(t, a, out(7, "alo")); err == nil || errors.Is(err, bridge.ErrNotAllowed) {
		t.Fatalf("err = %v, want a retryable error", err)
	}
	waitPastLastTry(a)
	ref, err := send(t, a, out(7, "alo"))
	if err != nil {
		t.Fatal(err)
	}
	if z.created("alo") != 1 || z.sends() != 1 || len(ref.IDs) != 1 {
		t.Fatalf("created %d, sends %d, ref %v", z.created("alo"), z.sends(), ref)
	}
}

// Lost answer and no listener: nothing can tell, so nothing is sent; once the
// listener is back the history finds the message.
func TestSendLostAnswerWithTheListenerDownSendsNothing(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.dropAnswers, z.listenerOff = 1, true })
	if _, err := send(t, a, out(8, "alo")); err == nil {
		t.Fatal("the unanswered send succeeded")
	}
	waitPastLastTry(a)
	if _, err := send(t, a, out(8, "alo")); !errors.Is(err, errUnsure) {
		t.Fatalf("err = %v, want errUnsure", err)
	}
	if z.sends() != 1 {
		t.Fatalf("sends = %d, want 1: a repeated RandomID was sent blindly", z.sends())
	}
	z.set(func(z *zaloSim) { z.listenerOff = false })
	ref, err := send(t, a, out(8, "alo"))
	if err != nil {
		t.Fatal(err)
	}
	if z.created("alo") != 1 || z.sends() != 1 || len(ref.IDs) != 1 {
		t.Fatalf("created %d, sends %d, ref %v", z.created("alo"), z.sends(), ref)
	}
}

// A try Zalo never got is sent again once the history shows no copy.
func TestSendLostRequestIsSentAgainWhenTheHistoryShowsNoCopy(t *testing.T) {
	z := newZaloSim(t)
	z.seed("500", false, "cũ", time.Now().Add(-time.Hour)) // the page reaches back before the first try
	a, _, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.loseSends = 1 })
	if _, err := send(t, a, out(9, "alo")); err == nil {
		t.Fatal("the lost send succeeded")
	}
	waitPastLastTry(a)
	if _, err := send(t, a, out(9, "alo")); err != nil {
		t.Fatal(err)
	}
	if z.created("alo") != 1 || z.sends() != 2 || z.historyReads() != 1 {
		t.Fatalf("created %d, sends %d, history reads %d; want 1, 2, 1", z.created("alo"), z.sends(), z.historyReads())
	}
}

func TestSendRetrySoonAfterAnUnansweredTryWaits(t *testing.T) {
	z := newZaloSim(t)
	z.dropAnswers = 1
	a, _, _ := simAccount(t, z, false)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := a.SendMessage(ctx, testAccount, out(3, "alo")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the deadline", err)
	}
	if _, err := send(t, a, out(3, "alo")); !errors.Is(err, errUnsure) {
		t.Fatalf("err = %v, want errUnsure", err)
	}
	if z.sends() != 1 {
		t.Fatalf("sends = %d, want 1", z.sends())
	}
}

// retry is m as the engine sends it again after the owner retried a send whose
// earlier call may have gone out, queued at since.
func retry(m bridge.OutMessage, since time.Time) bridge.OutMessage {
	m.RetrySince = since
	return m
}

// A RandomID never seen and not a retry is new, right after the adapter started
// too: the owner's own message with the same text, typed on the phone, is not
// taken for it.
func TestSendNewRandomIDGoesOutEvenWhenThePhoneSentTheSameText(t *testing.T) {
	z := newZaloSim(t)
	z.seed("500", true, "ok", time.Now().Add(-30*time.Second)) // typed on the phone
	a, _, _ := simAccount(t, z, false)
	ref, err := send(t, a, out(20, "ok"))
	if err != nil {
		t.Fatal(err)
	}
	if z.sends() != 1 || z.created("ok") != 2 || z.historyReads() != 0 || len(ref.IDs) != 1 || ref.IDs[0] == "5001" {
		t.Fatalf("sends %d, created %d, history reads %d, ref %v; want the text sent without a history check",
			z.sends(), z.created("ok"), z.historyReads(), ref)
	}
}

// A retry of a call that may have gone out (in a process before this one) is
// looked for in the history first: found, it is not sent again; not found on a
// page that reaches back to the send, it goes out.
func TestSendRetryOfAnUnclearSendChecksTheHistory(t *testing.T) {
	z := newZaloSim(t)
	z.seed("500", false, "cũ", time.Now().Add(-time.Hour))
	z.seed("500", true, "đã gửi", time.Now().Add(-2*time.Minute)) // sent by the earlier call
	a, _, _ := simAccount(t, z, false)
	ref, err := send(t, a, retry(out(21, "đã gửi"), time.Now().Add(-5*time.Minute)))
	if err != nil {
		t.Fatal(err)
	}
	if z.sends() != 0 || len(ref.IDs) != 1 || ref.IDs[0] != "5002" {
		t.Fatalf("sends %d, ref %v; want the earlier copy and no send", z.sends(), ref)
	}
	if _, err := send(t, a, retry(out(22, "mới"), time.Now().Add(-5*time.Minute))); err != nil {
		t.Fatal(err)
	}
	if z.created("mới") != 1 || z.created("đã gửi") != 1 || z.historyReads() != 2 {
		t.Fatalf("created mới %d, đã gửi %d, history reads %d; want 1, 1, 2", z.created("mới"), z.created("đã gửi"), z.historyReads())
	}
	// Retried in this process: answered from what this process sent.
	if _, err := send(t, a, retry(out(22, "mới"), time.Now().Add(-5*time.Minute))); err != nil || z.created("mới") != 1 {
		t.Fatalf("err %v, created %d", err, z.created("mới"))
	}
}

// A retry of a call that may have gone out, when neither what was heard nor the
// history can tell, sends nothing.
func TestSendRetryOfAnUnclearSendThatCannotBeCheckedSendsNothing(t *testing.T) {
	z := newZaloSim(t)
	z.seed("500", false, "vừa xong", time.Now().Add(-time.Minute)) // the page does not reach the send
	a, _, _ := simAccount(t, z, false)
	if _, err := send(t, a, retry(out(23, "alo"), time.Now().Add(-10*time.Minute))); !errors.Is(err, errUnsure) {
		t.Fatalf("short page: err = %v, want errUnsure", err)
	}
	z.set(func(z *zaloSim) { z.listenerOff = true })
	if _, err := send(t, a, retry(out(24, "alo"), time.Now().Add(-time.Minute))); !errors.Is(err, errUnsure) {
		t.Fatalf("no history: err = %v, want errUnsure", err)
	}
	if z.sends() != 0 {
		t.Fatalf("sends = %d, want 0", z.sends())
	}
}

func TestSendOnlyToPeopleTheAccountTalksWith(t *testing.T) {
	z := newZaloSim(t)
	z.seed("700", false, "chào", time.Now().Add(-time.Hour))
	a, _, _ := simAccount(t, z, false)
	stranger := bridge.OutMessage{Conversation: "600", Text: "alo", RandomID: 30}
	if _, err := send(t, a, stranger); !errors.Is(err, bridge.ErrNotAllowed) {
		t.Fatalf("err = %v, want ErrNotAllowed", err)
	}
	if _, err := send(t, a, bridge.OutMessage{Conversation: "700", Text: "alo", RandomID: 31}); err != nil {
		t.Fatalf("a person found in the history: %v", err)
	}
	if z.sends() != 1 || z.created("alo") != 1 {
		t.Fatalf("sends %d, created %d; want 1 and 1", z.sends(), z.created("alo"))
	}
}

func TestSendRefusesWhatZaloSendingDoesNotTake(t *testing.T) {
	a, _ := newTestAdapter(t, &fakeRunner{})
	media := out(1, "x")
	media.Media = []bridge.OutMedia{{Kind: "photo"}}
	topic := out(1, "x")
	topic.Topic = "5"
	for name, m := range map[string]bridge.OutMessage{
		"empty":    out(1, ""),
		"too long": out(1, strings.Repeat("ê", maxTextRunes+1)),
		"bad utf8": out(1, "\xff"),
		"media":    media,
		"topic":    topic,
		"group id": {Conversation: "g500", Text: "x", RandomID: 1},
	} {
		if _, err := send(t, a, m); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if _, err := send(t, a, out(1, strings.Repeat("ê", maxTextRunes))); !errors.Is(err, errNotListening) {
		t.Errorf("no listener: err = %v, want errNotListening", err)
	}
	if err := a.EditMessage(context.Background(), testAccount, bridge.EditRequest{}); !errors.Is(err, bridge.ErrNotAllowed) {
		t.Errorf("edit: %v", err)
	}
	if err := a.DeleteMessages(context.Background(), testAccount, bridge.Delete{}); !errors.Is(err, bridge.ErrNotAllowed) {
		t.Errorf("delete: %v", err)
	}
}

func TestSendErrorsAreClassified(t *testing.T) {
	z := newZaloSim(t)
	z.seed("500", false, "cũ", time.Now().Add(-time.Hour))
	a, _, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.failNext = "rate_limited" })
	var limit *bridge.RateLimitError
	if _, err := send(t, a, out(40, "a")); !errors.As(err, &limit) || limit.RetryAfter != rateLimitWait {
		t.Fatalf("err = %v, want a RateLimitError", err)
	}
	// Zalo created nothing, so the retry goes out at once.
	if _, err := send(t, a, out(40, "a")); err != nil || z.created("a") != 1 {
		t.Fatalf("retry: err %v, created %d", err, z.created("a"))
	}
	z.set(func(z *zaloSim) { z.failNext = "refused" })
	if _, err := send(t, a, out(41, "b")); !errors.Is(err, bridge.ErrNotAllowed) || !strings.Contains(err.Error(), "114") {
		t.Fatalf("err = %v, want ErrNotAllowed with Zalo's code", err)
	}
	z.set(func(z *zaloSim) { z.failNext = "session_rejected" })
	if _, err := send(t, a, out(42, "c")); !errors.Is(err, bridge.ErrSessionRevoked) {
		t.Fatalf("err = %v, want ErrSessionRevoked", err)
	}
	// An unclear failure keeps the RandomID open: the retry checks first.
	z.set(func(z *zaloSim) { z.failNext = "network_error" })
	if _, err := send(t, a, out(43, "d")); err == nil || errors.Is(err, bridge.ErrNotAllowed) {
		t.Fatalf("err = %v, want a retryable error", err)
	}
	waitPastLastTry(a)
	before := z.historyReads()
	if _, err := send(t, a, out(43, "d")); err != nil || z.historyReads() != before+1 || z.created("d") != 1 {
		t.Fatalf("retry: err %v, history reads %d, created %d", err, z.historyReads()-before, z.created("d"))
	}
}

func TestSendKeepsTheGapBetweenSends(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	a.timing.sendGap = 200 * time.Millisecond
	for rid := int64(50); rid < 52; rid++ {
		if _, err := send(t, a, out(rid, "x")); err != nil {
			t.Fatal(err)
		}
	}
	z.mu.Lock()
	gap := z.sendTimes[1].Sub(z.sendTimes[0])
	z.mu.Unlock()
	if gap < 190*time.Millisecond {
		t.Fatalf("sends %v apart, want at least the gap", gap)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := a.SendMessage(ctx, testAccount, out(52, "y")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the deadline while waiting for the gap", err)
	}
	if z.sends() != 2 {
		t.Fatalf("sends = %d, want 2", z.sends())
	}
}

func TestSendLogsNoTextOrPerson(t *testing.T) {
	z := newZaloSim(t)
	a, h, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.failNext = "refused" })
	_, _ = send(t, a, out(60, "bí mật gửi đi"))
	_, _ = send(t, a, out(61, "bí mật gửi đi"))
	logged := strings.Join(h.all(), "\n")
	for _, s := range []string{"bí mật", "500", simOwner} {
		if strings.Contains(logged, s) {
			t.Errorf("log contains %q:\n%s", s, logged)
		}
	}
}

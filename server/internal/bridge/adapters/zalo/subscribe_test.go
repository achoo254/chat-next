package zalo

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

const storedSessionJSON = `{"cookie":[{"key":"zpw_sek","value":"secret-cookie"}],"imei":"imei-1","userAgent":"UA","uid":"999"}`

var testAccount = bridge.Account{ID: "7", Session: []byte(storedSessionJSON)}

const (
	accountLine   = `{"ev":"account","uid":"999"}`
	connectedLine = `{"ev":"listener","state":"connected"}`
	// What the sidecar sends when Zalo refuses the stored session, and when Zalo
	// fails (protocol 3, src/login-failure.mjs).
	rejectedLine    = `{"ev":"error","code":"session_rejected","message":"ZcaApiError"}`
	unavailableLine = `{"ev":"error","code":"zalo_unavailable","message":"ZcaApiError"}`
)

// scriptedSession plays a sidecar that takes login_session, then writes
// lines, then (when exitAfter) exits as a crashed sidecar would.
func scriptedSession(t *testing.T, lines []string, exitAfter bool) func(p *fakeProcess) {
	return func(p *fakeProcess) {
		p.emit(readyLine)
		c := p.command(t)
		if !strings.HasPrefix(c, `{"cmd":"login_session","session":{"cookie":`) || strings.Contains(c, `"uid"`) {
			t.Errorf("command = %q, want login_session with the sidecar's part of the stored session", c)
			return
		}
		for _, l := range lines {
			p.emit(l)
		}
		if exitAfter {
			p.exit()
		}
	}
}

// runSubscribe runs Subscribe until it returns and collects what it sent.
func runSubscribe(t *testing.T, a *Adapter, acct bridge.Account) ([]bridge.Event, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out := make(chan bridge.Event, 32)
	err := a.Subscribe(ctx, acct, out)
	close(out)
	var got []bridge.Event
	for ev := range out {
		got = append(got, ev)
	}
	return got, err
}

func TestSubscribeDeliversMessagesOnceAndIgnoresGroups(t *testing.T) {
	lines := []string{
		accountLine,
		connectedLine,
		`{"ev":"message","thread":"user","self":false,"msgType":"webchat","content":"xin chào","msgId":"1001","cliMsgId":"1","uidFrom":"500","idTo":"0","dName":"Lan","ts":"1763700000000","ttl":0}`,
		`{"ev":"message","thread":"user","self":false,"msgType":"webchat","content":"xin chào","msgId":"1001","cliMsgId":"1","uidFrom":"500","idTo":"0","dName":"Lan","ts":"1763700000000","ttl":0}`,
		`{"ev":"message","thread":"group","self":false,"msgType":"webchat","content":"nhóm","msgId":"1002","uidFrom":"501","idTo":"900","dName":"Minh","ts":"1763700000001"}`,
		`{"ev":"message","thread":"user","self":true,"msgType":"chat.sticker","content":{"id":1,"catId":2,"type":7},"msgId":"1003","uidFrom":"999","idTo":"500","ts":1763700000002}`,
		`{"ev":"event","name":"typing","payload":{"uid":"500"}}`,
		`not json at all`,
		`{"ev":"listener","state":"closed","code":1006}`,
	}
	r := &fakeRunner{script: scriptedSession(t, lines, false)}
	a, _ := newTestAdapter(t, r)
	got, err := runSubscribe(t, a, testAccount)
	if err == nil || errors.Is(err, bridge.ErrSessionRevoked) || !strings.Contains(err.Error(), "1006") {
		t.Fatalf("err = %v, want a retryable listener close", err)
	}
	if len(got) != 2 {
		t.Fatalf("events = %d, want 2 (one repeat and one group message dropped)", len(got))
	}
	first, second := got[0].Message, got[1].Message
	if first.Text != "xin chào" || first.Conversation != "500" || first.From.IsSelf || first.From.Name != "Lan" {
		t.Errorf("first = %+v", first)
	}
	if second.Text != labelSticker || second.Conversation != "500" || !second.From.IsSelf || second.From.ID != "999" {
		t.Errorf("second = %+v", second)
	}
	convs, _ := a.ListConversations(context.Background(), testAccount)
	if len(convs) != 1 || convs[0].ID != "500" || convs[0].Title != "Lan" || convs[0].Kind != bridge.ConvPrivate {
		t.Errorf("conversations = %+v", convs)
	}
	// The engine drops messages of a conversation it has not linked yet and
	// reads them back through Backfill once it lists the conversation.
	page, _ := a.Backfill(context.Background(), testAccount, "500", bridge.Cursor{}, 50)
	if len(page.Messages) != 2 || page.Messages[0].ID != "1003" || !page.Done {
		t.Errorf("backfill = %+v, want the two heard messages newest first", page)
	}
	if again, _ := a.Backfill(context.Background(), testAccount, "500", bridge.Cursor{}, 50); len(again.Messages) != 0 {
		t.Errorf("a second backfill handed %d messages again", len(again.Messages))
	}
	r.process(t, 0).waitStdinClosed(t)
}

func TestSubscribeSidecarCrashIsRetryable(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, []string{accountLine, connectedLine}, true)}
	a, _ := newTestAdapter(t, r)
	_, err := runSubscribe(t, a, testAccount)
	if err == nil || errors.Is(err, bridge.ErrSessionRevoked) {
		t.Fatalf("err = %v, want a retryable error", err)
	}
}

func TestSubscribeRefusalsRevokeOnlyWhenTheyLastAnHour(t *testing.T) {
	clock := newFakeClock()
	r := &fakeRunner{script: scriptedSession(t, []string{rejectedLine}, false)}
	a, _ := newTestAdapterAt(t, r, clock.now)
	start := clock.now()
	var err error
	for attempts := 1; ; attempts++ {
		_, err = runSubscribe(t, a, testAccount)
		if errors.Is(err, bridge.ErrSessionRevoked) {
			break
		}
		if err == nil || !strings.Contains(err.Error(), "refused") {
			t.Fatalf("attempt %d: err = %v", attempts, err)
		}
		if attempts > 50 {
			t.Fatal("never revoked")
		}
		clock.advance(5 * time.Minute) // the engine's longest backoff
	}
	if got := clock.elapsed(start); got < revokeMinSpan {
		t.Errorf("revoked after %v of refusals, before %v", got, revokeMinSpan)
	}
}

func TestSubscribeQuickRefusalsDoNotRevoke(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, []string{rejectedLine}, false)}
	a, _ := newTestAdapter(t, r) // real clock: the attempts are milliseconds apart
	for i := 0; i < 2*revokeMinRefusals; i++ {
		if _, err := runSubscribe(t, a, testAccount); err == nil || errors.Is(err, bridge.ErrSessionRevoked) {
			t.Fatalf("attempt %d: err = %v, want retryable", i, err)
		}
	}
	if r.starts() != 2*revokeMinRefusals {
		t.Errorf("sidecars started = %d, want one per Subscribe call", r.starts())
	}
}

func TestSubscribeZaloUnavailableNeverRevokes(t *testing.T) {
	clock := newFakeClock()
	r := &fakeRunner{script: scriptedSession(t, []string{unavailableLine}, false)}
	a, _ := newTestAdapterAt(t, r, clock.now)
	for i := 0; i < 3; i++ { // three quick ones, as the engine's first backoffs
		if _, err := runSubscribe(t, a, testAccount); err == nil || errors.Is(err, bridge.ErrSessionRevoked) {
			t.Fatalf("quick attempt %d: err = %v", i, err)
		}
		clock.advance(2 * time.Second)
	}
	for i := 0; i < 20; i++ { // and hours of them
		if _, err := runSubscribe(t, a, testAccount); err == nil || errors.Is(err, bridge.ErrSessionRevoked) {
			t.Fatalf("attempt %d: err = %v", i, err)
		}
		clock.advance(revokeMinGap)
	}
}

func TestSubscribeOtherFailuresNeitherCountNorClearTheStreak(t *testing.T) {
	clock := newFakeClock()
	a, _ := newTestAdapterAt(t, &fakeRunner{}, clock.now)
	run := func(line string) error {
		a.runner = &fakeRunner{script: scriptedSession(t, []string{line}, false)}
		_, err := runSubscribe(t, a, testAccount)
		return err
	}
	_ = run(rejectedLine)
	clock.advance(revokeMinGap)
	_ = run(unavailableLine) // neither counts nor clears
	_ = run(rejectedLine)
	if _, counted := a.refusals.refused(testAccount.ID); counted != 2 {
		t.Errorf("counted %d, want 2 (the unavailable error must not reset nor add)", counted)
	}
	a.runner = &fakeRunner{script: scriptedSession(t, []string{accountLine, connectedLine, `{"ev":"listener","state":"closed","code":1000}`}, false)}
	_, _ = runSubscribe(t, a, testAccount)
	clock.advance(revokeMinGap)
	if _, counted := a.refusals.refused(testAccount.ID); counted != 1 {
		t.Errorf("counted %d after a connect, want 1", counted)
	}
}

func TestSubscribeRefusesASessionOfAnotherAccount(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, []string{`{"ev":"account","uid":"1234"}`, connectedLine}, false)}
	a, h := newTestAdapter(t, r)
	if _, err := runSubscribe(t, a, testAccount); !errors.Is(err, errAccountMismatch) || errors.Is(err, bridge.ErrSessionRevoked) {
		t.Fatalf("err = %v, want errAccountMismatch", err)
	}
	if _, err := runSubscribe(t, a, testAccount); !errors.Is(err, errAccountMismatch) {
		t.Fatalf("second try: err = %v", err)
	}
	if r.starts() != 1 {
		t.Errorf("sidecars started = %d: the mismatched session must not be tried again", r.starts())
	}
	if strings.Contains(strings.Join(h.all(), "\n"), "1234") {
		t.Error("the other account's id reached the log")
	}
}

func TestSubscribeIncompleteSessionIsRevokedWithoutStarting(t *testing.T) {
	for _, s := range []string{`{"imei":"x"}`, `{"cookie":[],"imei":"i","userAgent":"u"}`, `{"cookie":[],"imei":"i","userAgent":"u","uid":"undefined"}`} {
		r := &fakeRunner{}
		a, _ := newTestAdapter(t, r)
		_, err := runSubscribe(t, a, bridge.Account{ID: "7", Session: []byte(s)})
		if !errors.Is(err, bridge.ErrSessionRevoked) || r.starts() != 0 {
			t.Fatalf("%s: err = %v, starts = %d", s, err, r.starts())
		}
	}
}

func TestSubscribeGivesUpWhenTheListenerNeverConnects(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, nil, false)}
	a, _ := newTestAdapter(t, r)
	a.timing.connect = 100 * time.Millisecond
	_, err := runSubscribe(t, a, testAccount)
	if err == nil || errors.Is(err, bridge.ErrSessionRevoked) || !strings.Contains(err.Error(), "did not connect") {
		t.Fatalf("err = %v, want a retryable timeout", err)
	}
	r.process(t, 0).waitStdinClosed(t)
}

func TestLogoutClosesTheSidecarStdin(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, []string{accountLine, connectedLine}, false)}
	a, _ := newTestAdapter(t, r)
	errs := make(chan error, 1)
	go func() { errs <- a.Subscribe(context.Background(), testAccount, make(chan bridge.Event, 8)) }()
	eventually(t, "subscription", func() bool { return a.subscribed(testAccount.ID) != nil })
	if err := a.Logout(context.Background(), testAccount); err != nil {
		t.Fatal(err)
	}
	r.process(t, 0).waitStdinClosed(t)
	select {
	case err := <-errs:
		if !errors.Is(err, bridge.ErrSessionRevoked) {
			t.Errorf("Subscribe after logout: err = %v, want ErrSessionRevoked (no reconnect)", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Subscribe did not return after Logout")
	}
	if r.process(t, 0).wasKilled() {
		t.Error("the sidecar was killed although it exited when its stdin closed")
	}
}

func TestSubscribeStopsTheSidecarWhenCancelled(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, nil, false)}
	a, _ := newTestAdapter(t, r)
	ctx, cancel := context.WithCancel(context.Background())
	errs := make(chan error, 1)
	go func() { errs <- a.Subscribe(ctx, testAccount, make(chan bridge.Event)) }()
	eventually(t, "subscription", func() bool { return a.subscribed(testAccount.ID) != nil })
	cancel()
	select {
	case err := <-errs:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Subscribe did not return after cancel")
	}
	r.process(t, 0).waitStdinClosed(t)
}

// subscribed is the running subscription of an account (tests only).
func (a *Adapter) subscribed(account string) *subscription {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.subs[account]
}

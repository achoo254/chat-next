package zalo

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

const storedSession = `{"cookie":[{"key":"zpw_sek","value":"secret-cookie"}],"imei":"imei-1","userAgent":"UA"}`

var testAccount = bridge.Account{ID: "7", Session: []byte(storedSession)}

// scriptedSession plays a sidecar that takes login_session, then writes
// lines, then (when exitAfter) exits as a crashed sidecar would.
func scriptedSession(t *testing.T, lines []string, exitAfter bool) func(p *fakeProcess) {
	return func(p *fakeProcess) {
		p.emit(readyLine)
		if c := p.command(t); !strings.HasPrefix(c, `{"cmd":"login_session","session":{"cookie":`) {
			t.Errorf("command = %q, want login_session with the stored session", c)
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
		`{"ev":"listener","state":"connected"}`,
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
	page, _ := a.Backfill(context.Background(), testAccount, "500", bridge.Cursor{}, 50)
	if len(page.Messages) != 2 || page.Messages[0].ID != "1003" || !page.Done {
		t.Errorf("backfill = %+v, want the two heard messages newest first", page)
	}
	r.started[0].waitStdinClosed(t)
}

func TestSubscribeSidecarCrashIsRetryable(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, []string{`{"ev":"listener","state":"connected"}`}, true)}
	a, _ := newTestAdapter(t, r)
	_, err := runSubscribe(t, a, testAccount)
	if err == nil || errors.Is(err, bridge.ErrSessionRevoked) {
		t.Fatalf("err = %v, want a retryable error", err)
	}
}

func TestSubscribeRefusedSessionBecomesRevokedAfterRepeats(t *testing.T) {
	refused := []string{`{"ev":"error","code":"command_failed","message":"ZaloApiError"}`}
	r := &fakeRunner{script: scriptedSession(t, refused, false)}
	a, _ := newTestAdapter(t, r)
	for i := 1; i < revokeAfter; i++ {
		if _, err := runSubscribe(t, a, testAccount); err == nil || errors.Is(err, bridge.ErrSessionRevoked) {
			t.Fatalf("attempt %d: err = %v, want retryable", i, err)
		}
	}
	if _, err := runSubscribe(t, a, testAccount); !errors.Is(err, bridge.ErrSessionRevoked) {
		t.Fatalf("attempt %d: err = %v, want ErrSessionRevoked", revokeAfter, err)
	}
	if r.starts() != revokeAfter {
		t.Errorf("sidecars started = %d, want one per Subscribe call (%d)", r.starts(), revokeAfter)
	}
}

func TestSubscribeNetworkFailureIsNotARefusal(t *testing.T) {
	failed := []string{`{"ev":"error","code":"command_failed","message":"TypeError"}`}
	r := &fakeRunner{script: scriptedSession(t, failed, false)}
	a, _ := newTestAdapter(t, r)
	for i := 0; i < revokeAfter+1; i++ {
		if _, err := runSubscribe(t, a, testAccount); err == nil || errors.Is(err, bridge.ErrSessionRevoked) {
			t.Fatalf("attempt %d: err = %v, want retryable", i, err)
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
	r.started[0].waitStdinClosed(t)
}

func TestSubscribeIncompleteSessionIsRevokedWithoutStarting(t *testing.T) {
	r := &fakeRunner{}
	a, _ := newTestAdapter(t, r)
	_, err := runSubscribe(t, a, bridge.Account{ID: "7", Session: []byte(`{"imei":"x"}`)})
	if !errors.Is(err, bridge.ErrSessionRevoked) || r.starts() != 0 {
		t.Fatalf("err = %v, starts = %d", err, r.starts())
	}
}

func TestLogoutClosesTheSidecarStdin(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, []string{`{"ev":"listener","state":"connected"}`}, false)}
	a, _ := newTestAdapter(t, r)
	errs := make(chan error, 1)
	out := make(chan bridge.Event, 8)
	go func() { errs <- a.Subscribe(context.Background(), testAccount, out) }()
	deadline := time.Now().Add(5 * time.Second)
	for r.starts() == 0 || a.subscribed(testAccount.ID) == nil {
		if time.Now().After(deadline) {
			t.Fatal("subscription did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := a.Logout(context.Background(), testAccount); err != nil {
		t.Fatal(err)
	}
	r.started[0].waitStdinClosed(t)
	select {
	case err := <-errs:
		if !errors.Is(err, bridge.ErrSessionRevoked) {
			t.Errorf("Subscribe after logout: err = %v, want ErrSessionRevoked (no reconnect)", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Subscribe did not return after Logout")
	}
	if r.started[0].wasKilled() {
		t.Error("the sidecar was killed although it exited when its stdin closed")
	}
}

func TestSubscribeStopsTheSidecarWhenCancelled(t *testing.T) {
	r := &fakeRunner{script: scriptedSession(t, nil, false)}
	a, _ := newTestAdapter(t, r)
	ctx, cancel := context.WithCancel(context.Background())
	errs := make(chan error, 1)
	go func() { errs <- a.Subscribe(ctx, testAccount, make(chan bridge.Event)) }()
	for r.starts() == 0 || a.subscribed(testAccount.ID) == nil {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-errs; !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
	r.started[0].waitStdinClosed(t)
}

// subscribed is the running subscription of an account (tests only).
func (a *Adapter) subscribed(account string) *subscription {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.subs[account]
}

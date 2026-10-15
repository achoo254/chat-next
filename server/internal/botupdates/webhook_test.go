package botupdates_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bottest"
	"app.local/server/internal/botupdates"
)

const hookSecret = "test_secret-123"

// delivery is one request the receiver got.
type delivery struct {
	ID     int64
	Kind   string
	ChatID int64
	Text   string
	Header http.Header
	Body   []byte
	At     time.Time
}

// receiver is a bot's webhook on loopback. handle decides the answer
// (nil: 200 with an empty body).
type receiver struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	got    []delivery
	arrive chan delivery
	handle func(w http.ResponseWriter, d delivery)
}

func newReceiver(t *testing.T, handle func(w http.ResponseWriter, d delivery)) *receiver {
	t.Helper()
	r := &receiver{t: t, arrive: make(chan delivery, 1000), handle: handle}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body []byte
		buf := make([]byte, 1<<16)
		for {
			n, err := req.Body.Read(buf)
			body = append(body, buf[:n]...)
			if err != nil {
				break
			}
		}
		d := parseDelivery(t, body)
		d.Header, d.Body, d.At = req.Header.Clone(), body, time.Now()
		r.mu.Lock()
		r.got = append(r.got, d)
		r.mu.Unlock()
		r.arrive <- d
		if r.handle != nil {
			r.handle(w, d)
		}
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func parseDelivery(t *testing.T, body []byte) delivery {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Errorf("webhook body is not JSON: %s", body)
		return delivery{}
	}
	var d delivery
	for k, v := range raw {
		if k == "update_id" {
			_ = json.Unmarshal(v, &d.ID)
			continue
		}
		d.Kind = k
		var m struct {
			Chat struct {
				ID int64 `json:"id"`
			} `json:"chat"`
			Text    string `json:"text"`
			Message struct {
				Chat struct {
					ID int64 `json:"id"`
				} `json:"chat"`
			} `json:"message"`
		}
		_ = json.Unmarshal(v, &m)
		d.ChatID, d.Text = m.Chat.ID, m.Text
		if d.ChatID == 0 {
			d.ChatID = m.Message.Chat.ID
		}
	}
	return d
}

func (r *receiver) list() []delivery {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.got)
}

// wait returns the next delivery or fails after timeout.
func (r *receiver) wait(timeout time.Duration) delivery {
	r.t.Helper()
	select {
	case d := <-r.arrive:
		return d
	case <-time.After(timeout):
		r.t.Fatalf("no webhook request within %v", timeout)
		return delivery{}
	}
}

func setHook(t *testing.T, env *bottest.Env, botID int64, url string, w botupdates.WebhookSettings) {
	t.Helper()
	w.URL = url
	if w.Secret == "" {
		w.Secret = hookSecret
	}
	if err := env.Updates.SetWebhook(context.Background(), botID, w); err != nil {
		t.Fatal(err)
	}
}

// eventually polls cond until it holds or 10 seconds passed.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func info(t *testing.T, env *bottest.Env, botID int64) *botupdates.WebhookInfo {
	t.Helper()
	i, err := env.Updates.WebhookInfo(context.Background(), botID)
	if err != nil {
		t.Fatal(err)
	}
	return i
}

func TestWebhookDeliversSignedUpdatesInChatOrder(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "hookbot")
	env.CatchUp()
	// Drop the group-creation update so the test sees only its messages.
	setHook(t, env, botID, "http://127.0.0.1:1/unused", botupdates.WebhookSettings{DropPending: true})

	// One chat: requests never overlap, even though the receiver is slow.
	var inFlight, maxInFlight int
	var mu sync.Mutex
	rcv := newReceiver(t, func(w http.ResponseWriter, _ delivery) {
		mu.Lock()
		inFlight++
		maxInFlight = max(maxInFlight, inFlight)
		mu.Unlock()
		time.Sleep(30 * time.Millisecond)
		mu.Lock()
		inFlight--
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	setHook(t, env, botID, rcv.srv.URL+"/hook?x=1", botupdates.WebhookSettings{})
	for i := range 5 {
		send(t, env, user, group, fmt.Sprintf("m%d", i))
	}
	eventually(t, "five deliveries", func() bool { return len(rcv.list()) == 5 })
	eventually(t, "no pending update", func() bool { return info(t, env, botID).Pending == 0 })
	got := rcv.list()
	for i, d := range got {
		if d.Text != fmt.Sprintf("m%d", i) || d.Kind != "message" || d.ChatID != group {
			t.Fatalf("delivery %d = %+v", i, d)
		}
		if i > 0 && d.ID <= got[i-1].ID {
			t.Fatalf("update ids out of order: %d after %d", d.ID, got[i-1].ID)
		}
		// Secret header, timestamp and HMAC over timestamp + "." + body.
		if d.Header.Get(botupdates.HeaderSecret) != hookSecret || d.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("headers = %v", d.Header)
		}
		ts := d.Header.Get(botupdates.HeaderTimestamp)
		if n, err := strconv.ParseInt(ts, 10, 64); err != nil || time.Since(time.Unix(n, 0)) > time.Minute {
			t.Fatalf("timestamp %q", ts)
		}
		mac := hmac.New(sha256.New, []byte(hookSecret))
		mac.Write([]byte(ts + "."))
		mac.Write(d.Body)
		if want := "v1=" + hex.EncodeToString(mac.Sum(nil)); d.Header.Get(botupdates.HeaderSignature) != want {
			t.Fatalf("signature %q, want %q", d.Header.Get(botupdates.HeaderSignature), want)
		}
	}
	mu.Lock()
	if maxInFlight != 1 {
		t.Fatalf("requests of one chat overlapped: %d at once", maxInFlight)
	}
	mu.Unlock()
	st, err := env.Updates.Stats(ctx, botID)
	if err != nil || st.Delivered != 5 || st.Received != 6 || st.Failed != 0 {
		t.Fatalf("stats = %+v, %v", st, err)
	}
	i := info(t, env, botID)
	if i.URL != rcv.srv.URL+"/hook?x=1" || i.MaxConnections != botupdates.MaxConnectionsDefault || i.LastDeliveredAt.IsZero() || i.LastError != "" {
		t.Fatalf("info = %+v", i)
	}
	// Delivered updates are acknowledged: a long poll would not see them,
	// and a replay of the outbox does not deliver them again.
	if err := env.Updates.DeleteWebhook(ctx, botID, false); err != nil {
		t.Fatal(err)
	}
	if list, err := env.Updates.Poll(ctx, botID, 0, 100, 0); err != nil || len(list) != 0 {
		t.Fatalf("poll after webhook delivery = %v, %v", list, err)
	}
}

func TestWebhookQueuesRunInParallelAcrossChats(t *testing.T) {
	env := bottest.New(t)
	botID, user, groupA := talkativeBot(t, env, "parbot")
	groupB := env.Group(user, botID)
	env.CatchUp()
	setHook(t, env, botID, "http://127.0.0.1:1/unused", botupdates.WebhookSettings{DropPending: true})
	release := make(chan struct{})
	rcv := newReceiver(t, func(w http.ResponseWriter, d delivery) {
		if d.ChatID == groupA {
			<-release // chat A hangs until chat B got through
		}
	})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{})
	send(t, env, user, groupA, "a1")
	send(t, env, user, groupA, "a2")
	if d := rcv.wait(5 * time.Second); d.ChatID != groupA {
		t.Fatalf("first = %+v", d)
	}
	send(t, env, user, groupB, "b1")
	if d := rcv.wait(5 * time.Second); d.ChatID != groupB || d.Text != "b1" {
		t.Fatalf("chat B waited behind chat A: %+v", d)
	}
	// a2 waits for a1 (same chat).
	select {
	case d := <-rcv.arrive:
		t.Fatalf("a2 overtook a1: %+v", d)
	case <-time.After(300 * time.Millisecond):
	}
	if n := info(t, env, botID).OpenConnections; n != 1 {
		t.Fatalf("open connections = %d, want 1", n)
	}
	close(release)
	if d := rcv.wait(5 * time.Second); d.Text != "a2" {
		t.Fatalf("after release = %+v", d)
	}
}

func TestFailingUpdateIsDeadLetteredAndTheChatGoesOn(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "deadbot")
	env.CatchUp()
	// Retry-After 0 still waits the minimum backoff, shortened here.
	botupdates.SetRetryFloor(env.Updates, 20*time.Millisecond)
	setHook(t, env, botID, "http://127.0.0.1:1/unused", botupdates.WebhookSettings{DropPending: true})
	var mu sync.Mutex
	failText := "poison"
	rcv := newReceiver(t, func(w http.ResponseWriter, d delivery) {
		mu.Lock()
		fail := d.Text == failText
		mu.Unlock()
		if fail {
			// Retry-After 0: the next attempt comes after the minimum wait.
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	})
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{})
	send(t, env, user, group, "poison")
	send(t, env, user, group, "after")
	eventually(t, "the next update of the chat", func() bool {
		return slices.ContainsFunc(rcv.list(), func(d delivery) bool { return d.Text == "after" })
	})
	attempts := 0
	for _, d := range rcv.list() {
		if d.Text == "poison" {
			attempts++
		}
	}
	if attempts != botupdates.MaxAttempts {
		t.Fatalf("poison tried %d times, want %d", attempts, botupdates.MaxAttempts)
	}
	dead, total, err := env.Updates.DeadLetters(ctx, botID)
	if err != nil || total != 1 || len(dead) != 1 || dead[0].LastError != "http_503" || dead[0].Attempts != botupdates.MaxAttempts ||
		dead[0].ChatID != group || dead[0].ChatTitle != "group" || dead[0].Kind != "message" {
		t.Fatalf("dead letters = %+v (total %d), %v", dead, total, err)
	}
	st, _ := env.Updates.Stats(ctx, botID)
	if st.Failed != int64(botupdates.MaxAttempts) || st.DeadLettered != 1 || st.Delivered != 1 {
		t.Fatalf("stats = %+v", st)
	}
	i := info(t, env, botID)
	if i.DeadLetters != 1 || i.Pending != 0 || i.LastError != "http_503" || i.LastErrorAt.IsZero() {
		t.Fatalf("info = %+v", i)
	}
	// Retry gives one more attempt: it fails and is dead again.
	before := len(rcv.list())
	if n, err := env.Updates.RetryDeadLetters(ctx, botID, []int64{dead[0].UpdateID}); err != nil || n != 1 {
		t.Fatalf("retry = %d, %v", n, err)
	}
	eventually(t, "dead again", func() bool {
		_, total, _ := env.Updates.DeadLetters(ctx, botID)
		return len(rcv.list()) == before+1 && total == 1
	})
	// Fixed endpoint: a retry delivers it.
	mu.Lock()
	failText = ""
	mu.Unlock()
	if n, err := env.Updates.RetryDeadLetters(ctx, botID, []int64{dead[0].UpdateID}); err != nil || n != 1 {
		t.Fatalf("retry = %d, %v", n, err)
	}
	eventually(t, "the retried update delivered", func() bool {
		_, total, _ := env.Updates.DeadLetters(ctx, botID)
		return total == 0 && info(t, env, botID).Pending == 0 && len(rcv.list()) == before+2
	})
	// Discard: another poisoned update, dropped by the owner.
	mu.Lock()
	failText = "poison 2"
	mu.Unlock()
	send(t, env, user, group, "poison 2")
	eventually(t, "the second dead letter", func() bool {
		_, total, _ := env.Updates.DeadLetters(ctx, botID)
		return total == 1
	})
	dead, _, _ = env.Updates.DeadLetters(ctx, botID)
	if n, err := env.Updates.DiscardDeadLetters(ctx, botID, []int64{dead[0].UpdateID, 999999}); err != nil || n != 1 {
		t.Fatalf("discard = %d, %v", n, err)
	}
	if _, total, _ := env.Updates.DeadLetters(ctx, botID); total != 0 {
		t.Fatalf("dead letters after discard = %d", total)
	}
	// A discarded update is not retried either.
	if n, _ := env.Updates.RetryDeadLetters(ctx, botID, []int64{dead[0].UpdateID}); n != 0 {
		t.Fatalf("retried a discarded update: %d", n)
	}
}

func TestRetryBackoffAndRetryAfter(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "backoffbot")
	env.CatchUp()
	setHook(t, env, botID, "http://127.0.0.1:1/unused", botupdates.WebhookSettings{DropPending: true})
	retryAfter := ""
	var mu sync.Mutex
	rcv := newReceiver(t, func(w http.ResponseWriter, _ delivery) {
		mu.Lock()
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
	})
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{})
	send(t, env, user, group, "x")
	first := rcv.wait(5 * time.Second)
	second := rcv.wait(5 * time.Second)
	if gap := second.At.Sub(first.At); gap < 900*time.Millisecond || gap > 3*time.Second {
		t.Fatalf("first retry after %v, want about 1 s", gap)
	}
	third := rcv.wait(6 * time.Second)
	if gap := third.At.Sub(second.At); gap < 1900*time.Millisecond || gap > 4*time.Second {
		t.Fatalf("second retry after %v, want about 2 s", gap)
	}
	// Retry-After decides the next attempt.
	mu.Lock()
	retryAfter = "120"
	mu.Unlock()
	rcv.wait(10 * time.Second)
	eventually(t, "the long wait recorded", func() bool {
		var wait time.Duration
		err := env.Store.Pool().QueryRow(ctx, `
			SELECT extract(epoch FROM next_attempt_at - last_error_at)::bigint * interval '1 second' FROM bot_updates
			WHERE bot_id = $1 AND NOT acked`, botID).Scan(&wait)
		return err == nil && wait >= 119*time.Second && wait <= 121*time.Second
	})
}

func TestSlowWebhookDoesNotDelayOtherBots(t *testing.T) {
	env := bottest.New(t)
	slowBot, _, _ := talkativeBot(t, env, "slowbot")
	fastBot, fastOwner, fastGroup := talkativeBot(t, env, "fastbot")
	env.CatchUp()
	// The slow bot's webhook takes 10 s per request (the request timeout),
	// across many chats at once.
	release := make(chan struct{})
	slow := newReceiver(t, func(http.ResponseWriter, delivery) {
		select {
		case <-release:
		case <-time.After(10 * time.Second):
		}
	})
	t.Cleanup(func() { close(release) })
	fast := newReceiver(t, nil)
	setHook(t, env, slowBot, "http://127.0.0.1:1/unused", botupdates.WebhookSettings{DropPending: true})
	setHook(t, env, fastBot, "http://127.0.0.1:1/unused", botupdates.WebhookSettings{DropPending: true})
	setHook(t, env, slowBot, slow.srv.URL, botupdates.WebhookSettings{})
	setHook(t, env, fastBot, fast.srv.URL, botupdates.WebhookSettings{})
	for i := range 12 {
		u := env.User(fmt.Sprintf("slow_member%d", i))
		g := env.Group(u, slowBot)
		send(t, env, u, g, fmt.Sprintf("slow %d", i))
	}
	eventually(t, "the slow bot's requests in flight", func() bool { return info(t, env, slowBot).OpenConnections >= 10 })
	var worst time.Duration
	for i := range 10 {
		start := time.Now()
		send(t, env, fastOwner, fastGroup, fmt.Sprintf("fast %d", i))
		for {
			d := fast.wait(5 * time.Second)
			if d.Text == fmt.Sprintf("fast %d", i) {
				break
			}
		}
		worst = max(worst, time.Since(start))
	}
	if worst > time.Second {
		t.Fatalf("the fast bot's slowest delivery took %v while the slow bot hung", worst)
	}
}

func TestWebhookAndLongPollExcludeEachOther(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, _, _ := talkativeBot(t, env, "modebot")
	env.CatchUp()
	pending, err := env.Updates.Poll(ctx, botID, 0, 100, 0)
	if err != nil || len(pending) != 1 {
		t.Fatalf("first poll = %v, %v", pending, err)
	}
	waiting := make(chan error, 1)
	go func() {
		_, err := env.Updates.Poll(ctx, botID, pending[0].ID+1, 100, 30*time.Second)
		waiting <- err
	}()
	time.Sleep(100 * time.Millisecond)
	rcv := newReceiver(t, nil)
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{})
	select {
	case err := <-waiting:
		if !errors.Is(err, botupdates.ErrConflict) {
			t.Fatalf("waiting poll ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("setting a webhook did not end the waiting poll")
	}
	if _, err := env.Updates.Poll(ctx, botID, 0, 100, 0); !errors.Is(err, botupdates.ErrWebhookSet) {
		t.Fatalf("poll with a webhook = %v", err)
	}
	if err := env.Updates.DeleteWebhook(ctx, botID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Updates.Poll(ctx, botID, 0, 100, 0); err != nil {
		t.Fatalf("poll after delete = %v", err)
	}
}

func TestWebhookSettingsAreChecked(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, _, _ := talkativeBot(t, env, "checkbot")
	// A production dispatcher: https only, public addresses, web ports.
	prod := bottest.NewUpdates(t, env.Store, env.Chat)
	if err := prod.EnableWebhooks(botupdates.WebhookOptions{TenantID: bottest.TenantID, SessionKey: bottest.WebhookKey}); err != nil {
		t.Fatal(err)
	}
	code := func(err error) string {
		var we *botupdates.WebhookError
		if errors.As(err, &we) {
			return we.Code
		}
		return fmt.Sprint(err)
	}
	for _, c := range []struct {
		w    botupdates.WebhookSettings
		want string
	}{
		{botupdates.WebhookSettings{URL: "https://10.0.0.1/hook", Secret: "s"}, "url_blocked"},
		{botupdates.WebhookSettings{URL: "https://127.0.0.1/hook", Secret: "s"}, "url_blocked"},
		{botupdates.WebhookSettings{URL: "https://169.254.169.254/latest", Secret: "s"}, "url_blocked"},
		{botupdates.WebhookSettings{URL: "https://[::ffff:10.1.1.1]/", Secret: "s"}, "url_blocked"},
		{botupdates.WebhookSettings{URL: "http://93.184.216.34/hook", Secret: "s"}, "url_invalid"},
		{botupdates.WebhookSettings{URL: "https://93.184.216.34:8080/hook", Secret: "s"}, "url_invalid"},
		{botupdates.WebhookSettings{URL: "https://no-such-host.invalid/hook", Secret: "s"}, "url_unresolved"},
		{botupdates.WebhookSettings{URL: "https://93.184.216.34/hook", Secret: "has space"}, "secret_invalid"},
		{botupdates.WebhookSettings{URL: "https://93.184.216.34/hook", Secret: string(make([]byte, 257))}, "secret_invalid"},
		{botupdates.WebhookSettings{URL: "https://93.184.216.34/hook"}, "secret_required"},
		{botupdates.WebhookSettings{URL: "https://93.184.216.34/hook", Secret: "s", MaxConnections: 101}, "max_connections_invalid"},
		{botupdates.WebhookSettings{URL: "https://93.184.216.34/hook", Secret: "s", AllowedUpdates: []string{"inline_query"}}, "allowed_updates_invalid"},
	} {
		if got := code(prod.SetWebhook(ctx, botID, c.w)); got != c.want {
			t.Errorf("SetWebhook(%+v) = %s, want %s", c.w, got, c.want)
		}
	}
	// Valid: public address on 8443, max 100, a subset of kinds (duplicates
	// collapse); an empty secret then keeps the stored one for the same URL
	// only: a new URL must not get the secret the old one trusts.
	if err := prod.SetWebhook(ctx, botID, botupdates.WebhookSettings{
		URL: "https://93.184.216.34:8443/hook", Secret: "s", MaxConnections: 100, AllowedUpdates: []string{"callback", "callback"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := prod.SetWebhook(ctx, botID, botupdates.WebhookSettings{URL: " https://93.184.216.34:8443/hook "}); err != nil {
		t.Fatalf("keeping the secret: %v", err)
	}
	if got := code(prod.SetWebhook(ctx, botID, botupdates.WebhookSettings{URL: "https://93.184.216.34/other"})); got != "secret_required" {
		t.Fatalf("new URL without a new secret = %s", got)
	}
	if err := prod.SetWebhook(ctx, botID, botupdates.WebhookSettings{URL: "https://93.184.216.34/other", Secret: "s2"}); err != nil {
		t.Fatalf("new URL with a new secret: %v", err)
	}
	i, err := prod.WebhookInfo(ctx, botID)
	if err != nil || i.URL != "https://93.184.216.34/other" || i.MaxConnections != botupdates.MaxConnectionsDefault || len(i.AllowedUpdates) != 0 {
		t.Fatalf("info = %+v, %v", i, err)
	}
	// The server's own addresses (WebhookOptions.Deny) are refused like private ones.
	self := bottest.NewUpdates(t, env.Store, env.Chat)
	if err := self.EnableWebhooks(botupdates.WebhookOptions{
		TenantID: bottest.TenantID, SessionKey: bottest.WebhookKey, Deny: []netip.Prefix{netip.MustParsePrefix("93.184.216.34/32")},
	}); err != nil {
		t.Fatal(err)
	}
	if got := code(self.SetWebhook(ctx, botID, botupdates.WebhookSettings{URL: "https://93.184.216.34/hook", Secret: "s"})); got != "url_blocked" {
		t.Fatalf("the server's own address = %s", got)
	}
	// The secret is sealed, never stored as is.
	var stored []byte
	if err := env.Store.Pool().QueryRow(ctx, `SELECT webhook_secret FROM bots WHERE user_id = $1`, botID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) == 0 || string(stored) == "s" {
		t.Fatalf("secret stored as %q", stored)
	}
	if err := prod.DeleteWebhook(ctx, 424242, false); !errors.Is(err, botupdates.ErrNoBot) {
		t.Fatalf("delete for an unknown bot = %v", err)
	}
}

func TestAllowedUpdatesFilterNewUpdates(t *testing.T) {
	env := bottest.New(t)
	botID, user, group := talkativeBot(t, env, "filterbot")
	env.CatchUp()
	rcv := newReceiver(t, nil)
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{AllowedUpdates: []string{"callback"}, DropPending: true})
	send(t, env, user, group, "not wanted")
	env.CatchUp()
	if ids, _ := stored(t, env, botID); len(ids) != 1 { // only the dropped group creation
		t.Fatalf("stored = %v", ids)
	}
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{AllowedUpdates: []string{"message"}})
	send(t, env, user, group, "wanted")
	if d := rcv.wait(5 * time.Second); d.Text != "wanted" {
		t.Fatalf("delivered %+v", d)
	}
}

func TestRemovedBotLosesPendingUpdatesOfTheChat(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "kickedbot")
	other := env.Group(user, botID)
	for i := range 3 {
		send(t, env, user, group, fmt.Sprintf("m%d", i))
	}
	send(t, env, user, other, "kept")
	env.CatchUp()
	if _, err := env.Chat.RemoveMember(ctx, user, group, botID, false); err != nil {
		t.Fatal(err)
	}
	env.CatchUp()
	list, err := env.Updates.Poll(ctx, botID, 0, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range list {
		if d := parseDelivery(t, mustJSON(t, u)); d.ChatID == group {
			t.Fatalf("update of the chat the bot left: %s", u.Payload)
		}
	}
	if len(list) != 2 { // the other group's creation and "kept"
		t.Fatalf("updates = %d", len(list))
	}
	// Added back: new messages reach it again.
	if _, err := env.Chat.AddMembers(ctx, user, group, []int64{botID}); err != nil {
		t.Fatal(err)
	}
	send(t, env, user, group, "back")
	env.CatchUp()
	list, err = env.Updates.Poll(ctx, botID, list[len(list)-1].ID+1, 100, 0)
	if err != nil || len(list) == 0 || parseDelivery(t, mustJSON(t, list[len(list)-1])).Text != "back" {
		t.Fatalf("after re-adding = %v, %v", list, err)
	}
}

func mustJSON(t *testing.T, u botupdates.Update) []byte {
	t.Helper()
	b, err := json.Marshal(u)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAdminBotGetsChannelPosts(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("channel_owner")
	botID, _ := env.Bot(owner, "channelbot")
	resp, err := env.Chat.CreateChannel(ctx, owner, "news", "")
	if err != nil {
		t.Fatal(err)
	}
	channel := resp.GetChat().GetId()
	if _, err := env.Chat.AddMembers(ctx, owner, channel, []int64{botID}); err != nil {
		t.Fatal(err)
	}
	send(t, env, owner, channel, "before admin")
	env.CatchUp()
	if _, err := env.Chat.SetAdmin(ctx, owner, channel, botID, true); err != nil {
		t.Fatal(err)
	}
	send(t, env, owner, channel, "post")
	env.CatchUp()
	list, err := env.Updates.Poll(ctx, botID, 0, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, u := range list {
		d := parseDelivery(t, mustJSON(t, u))
		kinds = append(kinds, d.Kind+":"+d.Text)
	}
	if !slices.Contains(kinds, "channel_post:post") || slices.Contains(kinds, "channel_post:before admin") {
		t.Fatalf("channel updates = %v", kinds)
	}
	if _, err := env.Chat.EditMessage(ctx, owner, &appv1.EditMessageRequest{ChatId: channel, Seq: lastSeq(t, env, owner, channel), Text: "post!"}); err != nil {
		t.Fatal(err)
	}
	env.CatchUp()
	list, err = env.Updates.Poll(ctx, botID, list[len(list)-1].ID+1, 100, 0)
	if err != nil || len(list) != 1 || list[0].Kind != "message_edited" {
		t.Fatalf("edit = %v, %v", list, err)
	}
}

func lastSeq(t *testing.T, env *bottest.Env, user, chatID int64) int64 {
	t.Helper()
	var seq int64
	if err := env.Store.Pool().QueryRow(context.Background(), `SELECT max(seq) FROM messages WHERE chat_id = $1 AND from_id = $2`,
		chatID, user).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

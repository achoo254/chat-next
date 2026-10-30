package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bottest"
	"app.local/server/internal/chat"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"app.local/server/internal/webpush"
	"app.local/server/internal/webpush/webpushtest"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

const appName = "ChatTest"

// presence is a settable chat.Presence stand-in.
type presence struct {
	mu     sync.Mutex
	online map[int64]bool
}

func (p *presence) Online(userID int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.online[userID]
}

func (p *presence) set(userID int64, on bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.online[userID] = on
}

// pushService records the pushes it receives, per subscription path, and
// answers with a status set per path (201 by default).
type pushService struct {
	mu       sync.Mutex
	received map[string][]*http.Request
	bodies   map[string][][]byte
	status   map[string]int
}

func (p *pushService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	p.mu.Lock()
	p.received[r.URL.Path] = append(p.received[r.URL.Path], r)
	p.bodies[r.URL.Path] = append(p.bodies[r.URL.Path], body)
	status, ok := p.status[r.URL.Path]
	p.mu.Unlock()
	if !ok {
		status = http.StatusCreated
	}
	w.WriteHeader(status)
}

func (p *pushService) count(path string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.received[path])
}

type env struct {
	*bottest.Env
	t        *testing.T
	svc      *Service
	presence *presence
	service  *pushService
	server   *httptest.Server
	sender   *webpush.Sender
}

// device is a registered browser of a user.
type device struct {
	user, session int64
	path          string
	browser       webpushtest.Browser
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{Env: bottest.New(t), t: t, presence: &presence{online: map[int64]bool{}},
		service: &pushService{received: map[string][]*http.Request{}, bodies: map[string][][]byte{}, status: map[string]int{}}}
	e.server = httptest.NewServer(e.service)
	t.Cleanup(e.server.Close)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	vapid, err := webpush.NewVAPID(key, "mailto:ops@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if e.sender, err = webpush.NewSender(vapid, webpush.SenderOptions{AllowLocal: true, PadTo: PadTo}); err != nil {
		t.Fatal(err)
	}
	if e.svc, err = New(e.Store.Pool(), e.Chat, e.presence, Config{
		TenantID: bottest.TenantID, AppName: appName, Sender: e.sender,
		SessionIdleTimeout: store.SessionIdleTimeout, SessionMaxAge: store.SessionMaxAge,
	}, bottest.Quiet); err != nil {
		t.Fatal(err)
	}
	// Everything written while setting up the test is history.
	e.catchUp()
	e.planned()
	return e
}

func (e *env) session(user int64) int64 {
	e.t.Helper()
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	hash := sha256.Sum256(token)
	id, err := e.Store.CreateSession(context.Background(), store.NewSession{
		TokenHash: hash[:], TenantID: bottest.TenantID, UserID: user, IdPClientID: "chat-web",
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

// device registers a new browser of user on a new session.
func (e *env) device(user int64, locale string) device {
	e.t.Helper()
	b, err := webpushtest.NewBrowser()
	if err != nil {
		e.t.Fatal(err)
	}
	d := device{user: user, session: e.session(user), browser: b}
	d.path = fmt.Sprintf("/push/%d", d.session)
	if err := e.svc.Register(context.Background(), user, d.session, Subscription{
		Endpoint: e.server.URL + d.path, Keys: webpush.Keys{P256DH: b.P256DH, Auth: b.Auth}, Locale: locale,
	}); err != nil {
		e.t.Fatal(err)
	}
	return d
}

func (e *env) catchUp() {
	e.t.Helper()
	if err := e.svc.CatchUp(context.Background()); err != nil {
		e.t.Fatal(err)
	}
}

// planned takes the sends the consumer queued (no worker runs in these
// tests unless deliver starts them).
func (e *env) planned() []job {
	var out []job
	for {
		select {
		case j := <-e.svc.queue.queue:
			out = append(out, j)
		default:
			return out
		}
	}
}

func (e *env) send(user, chatID int64, text string) {
	e.t.Helper()
	if _, err := e.Chat.SendMessage(context.Background(), user, &appv1.SendMessageRequest{ChatId: chatID, Text: text}); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) private(a, b int64) int64 {
	e.t.Helper()
	c, _, err := e.Chat.CreatePrivate(context.Background(), a, b)
	if err != nil {
		e.t.Fatal(err)
	}
	return c.GetId()
}

func payloadOf(t *testing.T, j job, d device) Payload {
	t.Helper()
	enc, err := webpush.Encrypt(j.notification.Payload, webpush.Keys{P256DH: d.browser.P256DH, Auth: d.browser.Auth}, 0)
	if err != nil {
		t.Fatal(err)
	}
	plain, _, err := d.browser.Decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	var p Payload
	if err := json.Unmarshal(plain, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

// jobsFor returns the planned sends to the device's subscription.
func jobsFor(jobs []job, d device) []job {
	var out []job
	for _, j := range jobs {
		if j.target.UserID == d.user && strings.HasSuffix(j.target.Endpoint, d.path) {
			out = append(out, j)
		}
	}
	return out
}

func TestRegister(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	an := e.User("an_user")
	b, err := webpushtest.NewBrowser()
	if err != nil {
		t.Fatal(err)
	}
	keys := webpush.Keys{P256DH: b.P256DH, Auth: b.Auth}
	sess := e.session(an)

	key, endpoint, err := e.svc.WebPushConfig(ctx, sess)
	if err != nil || len(key) != webpush.PublicKeyLen || endpoint != "" {
		t.Fatalf("config before registering: %x %q %v", key, endpoint, err)
	}
	for name, sub := range map[string]Subscription{
		"unknown host":  {Endpoint: "https://push.evil.test/x", Keys: keys},
		"private range": {Endpoint: "http://10.1.2.3/x", Keys: keys},
		"short auth":    {Endpoint: e.server.URL + "/a", Keys: webpush.Keys{P256DH: b.P256DH, Auth: b.Auth[:8]}},
		"bad locale":    {Endpoint: e.server.URL + "/a", Keys: keys, Locale: "fr"},
	} {
		if err := e.svc.Register(ctx, an, sess, sub); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := e.svc.Register(ctx, an, sess, Subscription{Endpoint: e.server.URL + "/a", Keys: keys, Locale: LocaleEN}); err != nil {
		t.Fatal(err)
	}
	// The same session registering again replaces its subscription and,
	// without a locale, keeps the one it had.
	if err := e.svc.Register(ctx, an, sess, Subscription{Endpoint: e.server.URL + "/b", Keys: keys}); err != nil {
		t.Fatal(err)
	}
	if _, endpoint, _ = e.svc.WebPushConfig(ctx, sess); endpoint != e.server.URL+"/b" {
		t.Fatalf("endpoint %q", endpoint)
	}
	var n int
	var locale string
	if err := e.Store.Pool().QueryRow(ctx, `SELECT count(*), max(locale) FROM push_subscriptions WHERE user_id = $1`, an).Scan(&n, &locale); err != nil {
		t.Fatal(err)
	}
	if n != 1 || locale != LocaleEN {
		t.Fatalf("%d subscriptions, locale %q", n, locale)
	}
	// Simplified Chinese is stored as sent.
	if err := e.svc.Register(ctx, an, sess, Subscription{Endpoint: e.server.URL + "/b", Keys: keys, Locale: LocaleZhCN}); err != nil {
		t.Fatal(err)
	}
	if err := e.Store.Pool().QueryRow(ctx, `SELECT locale FROM push_subscriptions WHERE user_id = $1`, an).Scan(&locale); err != nil {
		t.Fatal(err)
	}
	if locale != LocaleZhCN {
		t.Fatalf("locale %q", locale)
	}
	// The browser signed in again: the endpoint moves to the new session.
	newer := e.session(an)
	if err := e.svc.Register(ctx, an, newer, Subscription{Endpoint: e.server.URL + "/b", Keys: keys}); err != nil {
		t.Fatal(err)
	}
	if _, endpoint, _ = e.svc.WebPushConfig(ctx, sess); endpoint != "" {
		t.Fatalf("old session still has %q", endpoint)
	}
	// Someone else's session cannot be registered.
	binh := e.User("binh_user")
	if err := e.svc.Register(ctx, binh, newer, Subscription{Endpoint: e.server.URL + "/c", Keys: keys}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("another user's session: %v", err)
	}
	// Revoking the session deletes its subscription.
	if _, err := e.Store.RevokeSession(ctx, bottest.TenantID, an, newer, nil, false); err != nil {
		t.Fatal(err)
	}
	if err := e.Store.Pool().QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, an).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d subscriptions after the session was revoked", n)
	}
	if err := e.svc.Register(ctx, an, newer, Subscription{Endpoint: e.server.URL + "/b", Keys: keys}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("revoked session registered: %v", err)
	}
	if err := e.svc.Register(ctx, an, sess, Subscription{Endpoint: e.server.URL + "/d", Keys: keys}); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Unregister(ctx, sess); err != nil {
		t.Fatal(err)
	}
	if _, endpoint, _ = e.svc.WebPushConfig(ctx, sess); endpoint != "" {
		t.Fatalf("unregistered session has %q", endpoint)
	}

	off, err := New(e.Store.Pool(), e.Chat, e.presence, Config{TenantID: bottest.TenantID, AppName: appName,
		SessionIdleTimeout: time.Hour, SessionMaxAge: time.Hour}, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	if key, _, _ := off.WebPushConfig(ctx, sess); key != nil {
		t.Fatal("disabled service reports a key")
	}
	if err := off.Register(ctx, an, sess, Subscription{Endpoint: e.server.URL + "/a", Keys: keys}); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled service: %v", err)
	}
}

func TestPrivateMessage(t *testing.T) {
	e := newEnv(t)
	an, binh := e.User("an_user"), e.User("binh_user")
	chatID := e.private(an, binh)
	phone := e.device(binh, LocaleVI)
	own := e.device(an, LocaleVI)
	e.send(an, chatID, "Chào Bình")
	e.catchUp()
	jobs := e.planned()
	if len(jobsFor(jobs, own)) != 0 {
		t.Fatal("the sender got a push")
	}
	got := jobsFor(jobs, phone)
	if len(got) != 1 {
		t.Fatalf("%d pushes to the recipient", len(got))
	}
	p := payloadOf(t, got[0], phone)
	want := Payload{ChatID: chatID, Title: "an_user", Body: "Chào Bình", Tag: fmt.Sprintf("chat:%d", chatID),
		URL: fmt.Sprintf("/c/%d", chatID), Timestamp: p.Timestamp}
	if p != want || p.Timestamp == 0 {
		t.Fatalf("payload %+v", p)
	}
	n := got[0].notification
	if n.Urgency != webpush.UrgencyHigh || n.Topic != fmt.Sprintf("chat%d", chatID) || n.TTL != messageTTL {
		t.Fatalf("message options %+v", n)
	}

	// Several messages of one chat in one batch: one push, the newest.
	e.send(an, chatID, "một")
	e.send(an, chatID, "hai")
	e.catchUp()
	got = jobsFor(e.planned(), phone)
	if len(got) != 1 || payloadOf(t, got[0], phone).Body != "hai" {
		t.Fatalf("batched pushes: %d", len(got))
	}

	// Using the app in the foreground somewhere: no push.
	e.presence.set(binh, true)
	e.send(an, chatID, "đang mở app")
	e.catchUp()
	if got := jobsFor(e.planned(), phone); len(got) != 0 {
		t.Fatal("pushed to a user in the foreground")
	}
	e.presence.set(binh, false)

	// Muted chat: no push.
	ctx := context.Background()
	if _, err := e.Chat.SetDialogMute(ctx, binh, chatID, 0, true); err != nil {
		t.Fatal(err)
	}
	e.send(an, chatID, "tắt tiếng")
	e.catchUp()
	if got := jobsFor(e.planned(), phone); len(got) != 0 {
		t.Fatal("pushed a muted chat")
	}
	if _, err := e.Chat.SetDialogMute(ctx, binh, chatID, 0, false); err != nil {
		t.Fatal(err)
	}

	// Content hidden: the app name and the generic text only.
	off, on := false, true
	if _, err := e.Chat.SetNotificationSettings(ctx, binh, &appv1.SetNotificationSettingsRequest{PrivatePreview: &off}); err != nil {
		t.Fatal(err)
	}
	e.send(an, chatID, "bí mật")
	e.catchUp()
	got = jobsFor(e.planned(), phone)
	if len(got) != 1 {
		t.Fatalf("%d pushes with the preview off", len(got))
	}
	if p := payloadOf(t, got[0], phone); p.Title != appName || p.Body != "Bạn có tin nhắn mới" ||
		strings.Contains(string(got[0].notification.Payload), "bí mật") || strings.Contains(string(got[0].notification.Payload), "an_user") {
		t.Fatalf("preview off: %+v", p)
	}

	// Private chats off: no push; sound off: silent.
	if _, err := e.Chat.SetNotificationSettings(ctx, binh, &appv1.SetNotificationSettingsRequest{
		PrivatePreview: &on, PrivateEnabled: &off}); err != nil {
		t.Fatal(err)
	}
	e.send(an, chatID, "không báo")
	e.catchUp()
	if got := jobsFor(e.planned(), phone); len(got) != 0 {
		t.Fatal("pushed with private chats off")
	}
	quiet := appv1.NotificationSound_NOTIFICATION_SOUND_OFF
	if _, err := e.Chat.SetNotificationSettings(ctx, binh, &appv1.SetNotificationSettingsRequest{
		PrivateEnabled: &on, Sound: &quiet}); err != nil {
		t.Fatal(err)
	}
	e.send(an, chatID, "im lặng")
	e.catchUp()
	got = jobsFor(e.planned(), phone)
	if len(got) != 1 || !payloadOf(t, got[0], phone).Silent {
		t.Fatal("sound off is not a silent push")
	}

	// Old messages (a restart after an outage) are not pushed.
	e.send(an, chatID, "cũ")
	e.svc.now = func() time.Time { return time.Now().Add(staleAfter + time.Minute) }
	e.catchUp()
	e.svc.now = time.Now
	if got := jobsFor(e.planned(), phone); len(got) != 0 {
		t.Fatal("pushed a stale message")
	}
}

func TestGroupAndChannel(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	an, binh, chi := e.User("an_user"), e.User("binh_user"), e.User("chi_user")
	group := e.Group(an, binh, chi)
	binhPhone, chiPhone := e.device(binh, LocaleVI), e.device(chi, LocaleEN)
	// Bình blocked An: no pushes of An's messages for Bình.
	if err := e.Chat.Block(ctx, binh, an); err != nil {
		t.Fatal(err)
	}
	e.send(an, group, "Họp lúc 3 giờ")
	e.catchUp()
	jobs := e.planned()
	if len(jobsFor(jobs, binhPhone)) != 0 {
		t.Fatal("pushed a blocked sender's message")
	}
	got := jobsFor(jobs, chiPhone)
	if len(got) != 1 {
		t.Fatalf("%d pushes to Chi", len(got))
	}
	if p := payloadOf(t, got[0], chiPhone); p.Title != "group" || p.Body != "an_user: Họp lúc 3 giờ" {
		t.Fatalf("group payload %+v", p)
	}
	if got[0].notification.Urgency != webpush.UrgencyNormal {
		t.Fatal("group push is not normal urgency")
	}
	off := false
	if _, err := e.Chat.SetNotificationSettings(ctx, chi, &appv1.SetNotificationSettingsRequest{GroupsPreview: &off}); err != nil {
		t.Fatal(err)
	}
	e.send(binh, group, "ok")
	e.catchUp()
	got = jobsFor(e.planned(), chiPhone)
	if len(got) != 1 {
		t.Fatalf("%d pushes", len(got))
	}
	if p := payloadOf(t, got[0], chiPhone); p.Title != appName || p.Body != "You have a new message" {
		t.Fatalf("hidden group payload in English %+v", p)
	}

	// A channel: subscribers get the post; leaving the chat ends them.
	ch, err := e.Chat.CreateChannel(ctx, an, "Tin tức", "")
	if err != nil {
		t.Fatal(err)
	}
	channel := ch.GetChat().GetId()
	if _, err := e.Chat.AddMembers(ctx, an, channel, []int64{chi}); err != nil {
		t.Fatal(err)
	}
	e.send(an, channel, "Bản tin")
	e.catchUp()
	got = jobsFor(e.planned(), chiPhone)
	if len(got) != 1 || payloadOf(t, got[0], chiPhone).Title != "Tin tức" {
		t.Fatalf("channel pushes %d", len(got))
	}
	if _, err := e.Chat.LeaveChat(ctx, chi, channel, 0); err != nil {
		t.Fatal(err)
	}
	e.send(an, channel, "Sau khi rời")
	e.catchUp()
	if got := jobsFor(e.planned(), chiPhone); len(got) != 0 {
		t.Fatal("pushed to a member who left")
	}
}

func TestChineseNotification(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	an, dung := e.User("an_user"), e.User("dung_user")
	chatID := e.private(an, dung)
	phone := e.device(dung, LocaleZhCN)
	off := false
	if _, err := e.Chat.SetNotificationSettings(ctx, dung, &appv1.SetNotificationSettingsRequest{PrivatePreview: &off}); err != nil {
		t.Fatal(err)
	}
	e.send(an, chatID, "bí mật")
	e.catchUp()
	got := jobsFor(e.planned(), phone)
	if len(got) != 1 {
		t.Fatalf("%d pushes", len(got))
	}
	if p := payloadOf(t, got[0], phone); p.Title != appName || p.Body != "你有一条新消息" {
		t.Fatalf("hidden payload in Chinese %+v", p)
	}
}

// deliver runs the workers until the test ends.
func (e *env) deliver() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.svc.queue.run(ctx)
	}()
	e.t.Cleanup(func() {
		cancel()
		<-done
	})
}

func (e *env) subscriptions(user int64) int {
	e.t.Helper()
	var n int
	if err := e.Store.Pool().QueryRow(context.Background(), `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, user).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDelivery(t *testing.T) {
	e := newEnv(t)
	e.deliver()
	an, binh := e.User("an_user"), e.User("binh_user")
	chatID := e.private(an, binh)
	phone := e.device(binh, LocaleVI)
	e.send(an, chatID, "Xin chào")
	e.catchUp()
	waitFor(t, "the push", func() bool { return e.service.count(phone.path) == 1 })
	e.service.mu.Lock()
	req, body := e.service.received[phone.path][0], e.service.bodies[phone.path][0]
	e.service.mu.Unlock()
	if req.Header.Get("Content-Encoding") != "aes128gcm" || !strings.HasPrefix(req.Header.Get("Authorization"), "vapid t=") ||
		req.Header.Get("Urgency") != "high" || req.Header.Get("TTL") != "86400" {
		t.Fatalf("headers %v", req.Header)
	}
	if strings.Contains(string(body), "Xin chào") {
		t.Fatal("message text in clear on the wire")
	}
	plain, _, err := phone.browser.Decrypt(body)
	if err != nil {
		t.Fatal(err)
	}
	var p Payload
	if err := json.Unmarshal(plain, &p); err != nil || p.Body != "Xin chào" {
		t.Fatalf("payload %s: %v", plain, err)
	}

	// 410 Gone: the subscription is deleted.
	e.service.mu.Lock()
	e.service.status[phone.path] = http.StatusGone
	e.service.mu.Unlock()
	e.send(an, chatID, "lần hai")
	e.catchUp()
	waitFor(t, "the subscription to go", func() bool { return e.subscriptions(binh) == 0 })

	// Rejected maxFailures times in a row: deleted; a success in between
	// resets the count.
	tablet := e.device(binh, LocaleVI)
	e.service.mu.Lock()
	e.service.status[tablet.path] = http.StatusForbidden
	e.service.mu.Unlock()
	for i := range maxFailures - 1 {
		e.send(an, chatID, fmt.Sprintf("từ chối %d", i))
		e.catchUp()
		waitFor(t, "a rejected push", func() bool { return e.service.count(tablet.path) == i+1 })
	}
	waitFor(t, "the failure count", func() bool {
		var failures int
		_ = e.Store.Pool().QueryRow(context.Background(), `SELECT failures FROM push_subscriptions WHERE user_id = $1`, binh).Scan(&failures)
		return failures == maxFailures-1
	})
	if e.subscriptions(binh) != 1 {
		t.Fatal("subscription dropped before maxFailures")
	}
	e.send(an, chatID, "lần cuối")
	e.catchUp()
	waitFor(t, "the rejected subscription to go", func() bool { return e.subscriptions(binh) == 0 })
}

func TestRunKickedByCommits(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.svc.Run(ctx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	e.Chat.SetCommitObserver(func() {
		e.Updates.Kick()
		e.svc.Kick()
	})
	an, binh := e.User("an_user"), e.User("binh_user")
	chatID := e.private(an, binh)
	phone := e.device(binh, LocaleVI)
	start := time.Now()
	e.send(an, chatID, "nhanh")
	waitFor(t, "the push", func() bool { return e.service.count(phone.path) == 1 })
	// The tick is a second; a kick after the commit is much faster.
	if elapsed := time.Since(start); elapsed > 900*time.Millisecond {
		t.Fatalf("push took %v", elapsed)
	}
}

func TestShownText(t *testing.T) {
	vi, en, zh := copies[LocaleVI], copies[LocaleEN], copies[LocaleZhCN]
	for _, c := range []struct {
		m           chat.PushMessage
		text        copyText
		title, body string
	}{
		{chat.PushMessage{ChatType: "private", SenderName: "Lan", Text: "Chào"}, vi, "Lan", "Chào"},
		{chat.PushMessage{ChatType: "group", ChatTitle: "Nhóm", SenderName: "Lan", MediaKind: appv1.MediaKind_MEDIA_KIND_PHOTO}, vi, "Nhóm", "Lan: Ảnh"},
		{chat.PushMessage{ChatType: "private", SenderName: "Lan", MediaKind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, FileName: "bao-cao.pdf"}, vi, "Lan", "bao-cao.pdf"},
		{chat.PushMessage{ChatType: "private", SenderName: "Lan", MediaKind: appv1.MediaKind_MEDIA_KIND_VOICE}, en, "Lan", "Voice message"},
		{chat.PushMessage{ChatType: "channel", ChatTitle: "Tin", SenderName: "GitLab", Text: "Pipeline failed"}, vi, "Tin", "GitLab: Pipeline failed"},
		{chat.PushMessage{ChatType: "group", ChatTitle: "Nhóm"}, vi, "Nhóm", "Bạn có tin nhắn mới"},
		{chat.PushMessage{ChatType: "group", ChatTitle: "Nhóm", SenderName: "Lan", MediaKind: appv1.MediaKind_MEDIA_KIND_PHOTO}, zh, "Nhóm", "Lan: 照片"},
		{chat.PushMessage{ChatType: "private", SenderName: "Lan", MediaKind: appv1.MediaKind_MEDIA_KIND_VOICE}, zh, "Lan", "语音消息"},
	} {
		title, body := shownText(c.m, c.text)
		if title != c.title || body != c.body {
			t.Errorf("%+v: %q / %q, want %q / %q", c.m, title, body, c.title, c.body)
		}
	}
}

package botapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bottest"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/store/testdb"
)

func TestMain(m *testing.M) {
	os.Exit(contractCoverage(testdb.Main(m)))
}

type harness struct {
	*bottest.Env
	api   *Service
	typer *fakeTyper
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWith(t, bottest.Options{})
}

func newHarnessWith(t *testing.T, o bottest.Options) *harness {
	t.Helper()
	env := bottest.NewWith(t, o)
	api, err := New(Config{TenantID: bottest.TenantID, PublicOrigin: bottest.PublicOrigin, AppScheme: bottest.AppScheme},
		env.Chat, env.Admin, env.Updates, env.Limiter, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	if env.Media != nil {
		api.UseMedia(env.Media)
	}
	typer := &fakeTyper{}
	api.UseTyper(typer)
	return &harness{Env: env, api: api, typer: typer}
}

// fakeTyper records the chat actions relayed to the realtime gateway.
type fakeTyper struct {
	mu  sync.Mutex
	got []string
}

func (f *fakeTyper) BotTyping(botID, chatID, topicID int64, action appv1.TypingAction) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, fmt.Sprintf("%d:%d:%d:%s", botID, chatID, topicID, action))
}

func (f *fakeTyper) list() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.got...)
}

// answer is a decoded envelope.
type answer struct {
	status int
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  struct {
		Code        string `json:"code"`
		Description string `json:"description"`
		RetryAfter  int    `json:"retry_after"`
	} `json:"error"`
}

func (h *harness) call(method, path, token, body string) answer {
	return h.callFrom("192.0.2.1:4000", method, path, token, body)
}

func (h *harness) callFrom(addr, method, path, token, body string) answer {
	h.T.Helper()
	req := httptest.NewRequest(method, "https://"+bottest.Host+path, strings.NewReader(body))
	req.RemoteAddr = addr
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.api.ServeHTTP(rec, req)
	var a answer
	if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil {
		h.T.Fatalf("%s %s: not an envelope: %q", method, path, rec.Body.String())
	}
	a.status = rec.Code
	h.checkContract(method, path, rec.Code, rec.Body.Bytes())
	if a.OK != (rec.Code == http.StatusOK) {
		h.T.Fatalf("%s %s: status %d with ok=%v", method, path, rec.Code, a.OK)
	}
	return a
}

// checkContract validates a response against the OpenAPI spec.
func (h *harness) checkContract(method, path string, status int, body []byte) {
	h.T.Helper()
	spec, err := loadContract()
	if err != nil {
		h.T.Errorf("contract: %v", err)
		return
	}
	spec.check(h.T, method, path, status, body)
}

func (a answer) into(t testing.TB, v any) {
	t.Helper()
	if !a.OK {
		t.Fatalf("call failed: %d %s %s", a.status, a.Error.Code, a.Error.Description)
	}
	if err := json.Unmarshal(a.Result, v); err != nil {
		t.Fatal(err)
	}
}

func (a answer) fails(t testing.TB, status int, code string) {
	t.Helper()
	if a.status != status || a.Error.Code != code {
		t.Fatalf("got %d %s (%s), want %d %s", a.status, a.Error.Code, a.Error.Description, status, code)
	}
}

type sentMessage struct {
	Seq  int64  `json:"seq"`
	Text string `json:"text"`
	Chat struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"chat"`
	From struct {
		ID    int64 `json:"id"`
		IsBot bool  `json:"is_bot"`
	} `json:"from"`
	Entities []struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	} `json:"entities"`
	ReplyMarkup json.RawMessage `json:"reply_markup"`
}

type update struct {
	UpdateID      int64        `json:"update_id"`
	Message       *sentMessage `json:"message"`
	MessageEdited *sentMessage `json:"message_edited"`
	MemberChanged *struct {
		Chat struct {
			ID int64 `json:"id"`
		} `json:"chat"`
		From *struct {
			ID int64 `json:"id"`
		} `json:"from"`
		Member struct {
			User struct {
				ID int64 `json:"id"`
			} `json:"user"`
			Status      string `json:"status"`
			Permissions uint32 `json:"permissions"`
		} `json:"member"`
	} `json:"member_changed"`
	Reaction *struct {
		Chat struct {
			ID int64 `json:"id"`
		} `json:"chat"`
		Seq  int64 `json:"seq"`
		User struct {
			ID int64 `json:"id"`
		} `json:"user"`
		Emoji string `json:"emoji"`
	} `json:"reaction"`
	Callback *struct {
		ID   string `json:"id"`
		Data string `json:"data"`
		From struct {
			ID int64 `json:"id"`
		} `json:"from"`
		Message sentMessage `json:"message"`
	} `json:"callback"`
}

func (h *harness) send(token string, chatID int64, body string) answer {
	return h.call(http.MethodPost, "/bot/v1/messages", token, fmt.Sprintf(`{"chat_id": %d, %s}`, chatID, body))
}

func (h *harness) updates(token string, query string) []update {
	h.T.Helper()
	var list []update
	h.call(http.MethodGet, "/bot/v1/updates?"+query, token, "").into(h.T, &list)
	return list
}

func (h *harness) userSends(user, chatID int64, text string) *appv1.Message {
	h.T.Helper()
	resp, err := h.Chat.SendMessage(context.Background(), user, &appv1.SendMessageRequest{ChatId: chatID, Text: text})
	if err != nil {
		h.T.Fatal(err)
	}
	return resp.GetMessage()
}

func (h *harness) privateWith(user, bot int64) int64 {
	h.T.Helper()
	c, _, err := h.Chat.CreatePrivate(context.Background(), user, bot)
	if err != nil {
		h.T.Fatal(err)
	}
	return c.GetId()
}

func TestAuthAndRouting(t *testing.T) {
	h := newHarness(t)
	owner := h.User("owner")
	botID, token := h.Bot(owner, "helperbot")

	h.call(http.MethodGet, "/bot/v1/me", "", "").fails(t, http.StatusUnauthorized, "unauthorized")
	h.call(http.MethodGet, "/bot/v1/me", fmt.Sprintf("%d:%s", botID, strings.Repeat("x", 40)), "").fails(t, http.StatusUnauthorized, "unauthorized")
	h.call(http.MethodGet, "/bot/v1/me", "not-a-token", "").fails(t, http.StatusUnauthorized, "unauthorized")
	h.call(http.MethodPost, "/bot/v1/me", token, "").fails(t, http.StatusMethodNotAllowed, "method_not_allowed")
	h.call(http.MethodGet, "/bot/v1/nothing", token, "").fails(t, http.StatusNotFound, "not_found")

	var me struct {
		ID       int64  `json:"id"`
		IsBot    bool   `json:"is_bot"`
		Username string `json:"username"`
		Privacy  bool   `json:"privacy"`
		Tier     string `json:"tier"`
	}
	h.call(http.MethodGet, "/bot/v1/me", token, "").into(t, &me)
	if me.ID != botID || !me.IsBot || me.Username != "helperbot" || !me.Privacy || me.Tier != "default" {
		t.Fatalf("me = %+v", me)
	}

	// Other hosts never answer.
	req := httptest.NewRequest(http.MethodGet, "https://hoandat.example/bot/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.api.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other host -> %d", rec.Code)
	}

	// A reset token replaces the old one at once; a deleted bot has none.
	ctx := context.Background()
	_, fresh, err := h.Admin.ResetBotToken(ctx, owner, time.Now(), botID)
	if err != nil {
		t.Fatal(err)
	}
	h.call(http.MethodGet, "/bot/v1/me", token, "").fails(t, http.StatusUnauthorized, "unauthorized")
	h.call(http.MethodGet, "/bot/v1/me", fresh, "").into(t, &me)
	if err := h.Admin.DeleteBot(ctx, owner, time.Now(), botID); err != nil {
		t.Fatal(err)
	}
	h.call(http.MethodGet, "/bot/v1/me", fresh, "").fails(t, http.StatusUnauthorized, "unauthorized")
}

func TestFailedAuthBlocksAddress(t *testing.T) {
	h := newHarness(t)
	_, token := h.Bot(h.User("owner"), "blockbot")
	const addr = "198.51.100.7:5000"
	for range 20 {
		h.callFrom(addr, http.MethodGet, "/bot/v1/me", "1:"+strings.Repeat("a", 40), "").fails(t, http.StatusUnauthorized, "unauthorized")
	}
	// The budget is used up: failures from the address are refused, with
	// or without a token.
	a := h.callFrom(addr, http.MethodGet, "/bot/v1/me", "1:"+strings.Repeat("a", 40), "")
	a.fails(t, http.StatusTooManyRequests, "rate_limited")
	if a.Error.RetryAfter <= 0 {
		t.Fatalf("retry_after = %d", a.Error.RetryAfter)
	}
	h.callFrom(addr, http.MethodGet, "/bot/v1/me", "", "").fails(t, http.StatusTooManyRequests, "rate_limited")
	// A valid token from the same address (another bot behind the same NAT)
	// still passes, and other addresses are not affected.
	h.callFrom(addr, http.MethodGet, "/bot/v1/me", token, "").into(t, &struct{}{})
	h.call(http.MethodGet, "/bot/v1/me", "1:"+strings.Repeat("a", 40), "").fails(t, http.StatusUnauthorized, "unauthorized")
}

func TestConsentInvariant(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "consentbot")
	stranger := h.User("stranger")

	// The user opened the chat but never wrote, started or pressed: 403.
	private := h.privateWith(stranger, botID)
	h.send(token, private, `"text": "spam"`).fails(t, http.StatusForbidden, "no_consent")

	// Writing to the bot is consent.
	h.userSends(stranger, private, "hello bot")
	var sent sentMessage
	h.send(token, private, `"text": "hi!"`).into(t, &sent)
	if sent.Chat.ID != private || sent.Chat.Type != "private" || sent.From.ID != botID || !sent.From.IsBot {
		t.Fatalf("sent = %+v", sent)
	}

	// StartBot with a deep link parameter: consent and "/start <param>".
	fan := h.User("fan")
	start, err := h.Chat.StartBot(ctx, fan, &appv1.StartBotRequest{BotId: botID, StartParam: "ref_42", RandomId: 9})
	if err != nil {
		t.Fatal(err)
	}
	if start.GetMessage().GetText() != "/start ref_42" || start.GetChat().GetPeerUserId() != botID {
		t.Fatalf("start = %v", start)
	}
	isBot := false
	for _, u := range start.GetUsers() {
		if u.GetId() == botID {
			isBot = u.GetIsBot()
		}
	}
	if !isBot {
		t.Fatalf("StartBot users lack is_bot: %v", start.GetUsers())
	}
	var source string
	if err := h.Store.Pool().QueryRow(ctx, `SELECT source FROM bot_user_consent WHERE bot_id = $1 AND user_id = $2`, botID, fan).Scan(&source); err != nil || source != "deep_link" {
		t.Fatalf("consent source %q, %v", source, err)
	}
	// A repeated StartBot (same random_id) does not send twice.
	again, err := h.Chat.StartBot(ctx, fan, &appv1.StartBotRequest{BotId: botID, StartParam: "ref_42", RandomId: 9})
	if err != nil || again.GetMessage().GetSeq() != start.GetMessage().GetSeq() {
		t.Fatalf("repeated start = %v, %v", again, err)
	}
	h.send(token, start.GetChat().GetId(), `"text": "welcome"`).into(t, &sent)

	// Groups need membership, never consent.
	group := h.Group(owner, stranger)
	h.send(token, group, `"text": "x"`).fails(t, http.StatusNotFound, "not_found")
	h.call(http.MethodGet, fmt.Sprintf("/bot/v1/chats/%d", group), token, "").fails(t, http.StatusNotFound, "not_found")
	if _, err := h.Chat.AddMembers(ctx, owner, group, []int64{botID}); err != nil {
		t.Fatal(err)
	}
	h.send(token, group, `"text": "joined"`).into(t, &sent)
	var info struct {
		ID    int64  `json:"id"`
		Type  string `json:"type"`
		Title string `json:"title"`
	}
	h.call(http.MethodGet, fmt.Sprintf("/bot/v1/chats/%d", group), token, "").into(t, &info)
	if info.ID != group || info.Type != "group" || info.Title != "group" {
		t.Fatalf("chat = %+v", info)
	}
}

func TestSendMessageOptions(t *testing.T) {
	h := newHarness(t)
	owner := h.User("owner")
	botID, token := h.Bot(owner, "formatbot")
	private := h.privateWith(owner, botID)
	h.userSends(owner, private, "/start")

	var sent sentMessage
	h.send(token, private, `"text": "*đậm* [trang](https://hoandat.com)", "parse_mode": "markdown"`).into(t, &sent)
	if sent.Text != "đậm trang" || len(sent.Entities) != 2 || sent.Entities[1].URL != "https://hoandat.com" {
		t.Fatalf("markdown = %+v", sent)
	}
	h.send(token, private, `"text": "<b>x</b>", "parse_mode": "html"`).into(t, &sent)
	h.send(token, private, `"text": "[x](javascript:alert(1))", "parse_mode": "markdown"`).fails(t, http.StatusBadRequest, "bad_request")
	h.send(token, private, `"text": "x", "entities": [{"type": "bold", "offset": 0, "length": 1}], "parse_mode": "html"`).
		fails(t, http.StatusBadRequest, "bad_request")
	h.send(token, private, `"text": "x", "bogus": 1`).fails(t, http.StatusBadRequest, "bad_request")
	h.send(token, private, `"text": "x", "reply_markup": {"inline_keyboard": [[{"text": "go", "url": "file:///etc"}]]}`).
		fails(t, http.StatusBadRequest, "bad_request")
	h.send(token, private, `"text": "x", "reply_markup": {"inline_keyboard": [[{"text": "go", "callback_data": "`+strings.Repeat("d", 65)+`"}]]}`).
		fails(t, http.StatusBadRequest, "bad_request")

	h.send(token, private, `"text": "pick", "reply_markup": {"keyboard": [[{"text": "A"}, {"text": "B"}]], "resize": true}`).into(t, &sent)
	if !strings.Contains(string(sent.ReplyMarkup), `"keyboard"`) {
		t.Fatalf("reply markup = %s", sent.ReplyMarkup)
	}
	// The keyboard reaches clients in Message.reply_markup.
	history, err := h.Chat.GetHistory(context.Background(), owner, &appv1.GetHistoryRequest{ChatId: private, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if kb := history.GetMessages()[0].GetReplyMarkup().GetKeyboard(); len(kb.GetRows()) != 1 || !kb.GetResize() {
		t.Fatalf("client sees markup %v", history.GetMessages()[0].GetReplyMarkup())
	}

	// random_id makes a retry return the first message.
	var first, second sentMessage
	h.send(token, private, `"text": "once", "random_id": 77`).into(t, &first)
	h.send(token, private, `"text": "once", "random_id": 77`).into(t, &second)
	if first.Seq == 0 || first.Seq != second.Seq {
		t.Fatalf("random_id retry: %d then %d", first.Seq, second.Seq)
	}
	h.send(token, private, `"text": "x", "random_id": 9007199254740992`).fails(t, http.StatusBadRequest, "bad_request")
}

func TestSendRateLimitPerChat(t *testing.T) {
	h := newHarness(t)
	owner := h.User("owner")
	botID, token := h.Bot(owner, "busybot")
	private := h.privateWith(owner, botID)
	h.userSends(owner, private, "hi")
	for i := range 20 {
		h.send(token, private, fmt.Sprintf(`"text": "n%d"`, i)).into(t, &sentMessage{})
	}
	a := h.send(token, private, `"text": "one too many"`)
	a.fails(t, http.StatusTooManyRequests, "rate_limited")
	if a.Error.RetryAfter != 1 {
		t.Fatalf("retry_after = %d", a.Error.RetryAfter)
	}
}

func TestLongPollAndAck(t *testing.T) {
	h := newHarness(t)
	owner := h.User("owner")
	botID, token := h.Bot(owner, "pollbot")
	private := h.privateWith(owner, botID)

	got := make(chan []update, 1)
	go func() {
		var list []update
		a := h.call(http.MethodGet, "/bot/v1/updates?timeout=10", token, "")
		if a.OK {
			_ = json.Unmarshal(a.Result, &list)
		}
		got <- list
	}()
	time.Sleep(200 * time.Millisecond)
	start := time.Now()
	h.userSends(owner, private, "hello")
	var list []update
	select {
	case list = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("long poll did not return")
	}
	if wait := time.Since(start); wait > 2*time.Second {
		t.Fatalf("long poll woke after %v", wait)
	}
	if len(list) != 1 || list[0].Message == nil || list[0].Message.Text != "hello" || list[0].Message.Chat.ID != private {
		t.Fatalf("updates = %+v", list)
	}
	first := list[0].UpdateID

	h.userSends(owner, private, "second")
	h.CatchUp()
	list = h.updates(token, "timeout=0")
	if len(list) != 2 || list[0].UpdateID != first || list[1].UpdateID <= first {
		t.Fatalf("unacknowledged = %+v", list)
	}
	// offset acknowledges everything below it.
	list = h.updates(token, fmt.Sprintf("offset=%d", list[1].UpdateID))
	if len(list) != 1 || list[0].Message.Text != "second" {
		t.Fatalf("after ack = %+v", list)
	}
	list = h.updates(token, fmt.Sprintf("offset=%d", list[0].UpdateID+1))
	if len(list) != 0 {
		t.Fatalf("after full ack = %+v", list)
	}
	// The bot's own messages are not updates.
	h.send(token, private, `"text": "mine"`).into(t, &sentMessage{})
	h.CatchUp()
	if list = h.updates(token, "timeout=0"); len(list) != 0 {
		t.Fatalf("own message delivered: %+v", list)
	}
	h.call(http.MethodGet, "/bot/v1/updates?limit=0", token, "").fails(t, http.StatusBadRequest, "bad_request")
	h.call(http.MethodGet, "/bot/v1/updates?timeout=51", token, "").fails(t, http.StatusBadRequest, "bad_request")
}

func TestConcurrentPollConflict(t *testing.T) {
	h := newHarness(t)
	_, token := h.Bot(h.User("owner"), "twinbot")
	old := make(chan answer, 1)
	go func() { old <- h.call(http.MethodGet, "/bot/v1/updates?timeout=20", token, "") }()
	time.Sleep(300 * time.Millisecond)
	newer := make(chan answer, 1)
	go func() { newer <- h.call(http.MethodGet, "/bot/v1/updates?timeout=1", token, "") }()
	select {
	case a := <-old:
		a.fails(t, http.StatusConflict, "conflict")
	case <-time.After(5 * time.Second):
		t.Fatal("the older poll was not ended")
	}
	if a := <-newer; !a.OK || string(a.Result) != "[]" {
		t.Fatalf("newer poll = %d %s", a.status, a.Result)
	}
}

func TestPrivacyModeInGroups(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	member := h.User("member")
	botID, token := h.Bot(owner, "quietbot")
	group := h.Group(owner, member, botID)
	// The group's creation reaches the bot (its membership, then the
	// service message); skip it.
	h.CatchUp()
	created := h.updates(token, "timeout=0")
	if len(created) != 2 || created[0].MemberChanged == nil || created[1].Message == nil {
		t.Fatalf("creation updates = %+v", created)
	}
	h.updates(token, fmt.Sprintf("offset=%d", created[1].UpdateID+1))

	var botMsg sentMessage
	h.send(token, group, `"text": "I am here"`).into(t, &botMsg)
	h.userSends(member, group, "just chatting")
	h.userSends(member, group, "/help")
	h.userSends(member, group, "/help@quietbot please")
	h.userSends(member, group, "/help@otherbot")
	if _, err := h.Chat.SendMessage(ctx, member, &appv1.SendMessageRequest{ChatId: group, Text: "a reply", ReplyToSeq: botMsg.Seq}); err != nil {
		t.Fatal(err)
	}
	h.CatchUp()
	var texts []string
	last := int64(0)
	for _, u := range h.updates(token, "timeout=0") {
		if u.Message != nil {
			texts = append(texts, u.Message.Text)
		}
		last = u.UpdateID
	}
	want := []string{"/help", "/help@quietbot please", "a reply"}
	if strings.Join(texts, "|") != strings.Join(want, "|") {
		t.Fatalf("privacy mode delivered %q, want %q", texts, want)
	}

	// Without privacy mode every message arrives.
	off := false
	if _, err := h.Admin.UpdateBot(ctx, owner, &appv1.UpdateBotRequest{BotId: botID, Privacy: &off}); err != nil {
		t.Fatal(err)
	}
	h.userSends(member, group, "just chatting again")
	h.CatchUp()
	list := h.updates(token, fmt.Sprintf("offset=%d", last+1))
	if len(list) != 1 || list[0].Message.Text != "just chatting again" {
		t.Fatalf("privacy off = %+v", list)
	}
}

func TestCallbackRoundTrip(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "buttonbot")
	user := h.User("user")
	start, err := h.Chat.StartBot(ctx, user, &appv1.StartBotRequest{BotId: botID})
	if err != nil {
		t.Fatal(err)
	}
	private := start.GetChat().GetId()
	var menu sentMessage
	h.send(token, private, `"text": "Choose", "reply_markup": {"inline_keyboard": [[{"text": "Yes", "callback_data": "yes"}, {"text": "Site", "url": "https://hoandat.com"}]]}`).into(t, &menu)
	h.CatchUp()
	list := h.updates(token, "timeout=0")
	offset := list[len(list)-1].UpdateID + 1 // the /start message

	if _, err := h.Chat.PressInlineButton(ctx, user, &appv1.PressInlineButtonRequest{ChatId: private, Seq: menu.Seq, CallbackData: []byte("no")}); err == nil {
		t.Fatal("pressing a button the message does not have succeeded")
	}
	press, err := h.Chat.PressInlineButton(ctx, user, &appv1.PressInlineButtonRequest{ChatId: private, Seq: menu.Seq, CallbackData: []byte("yes")})
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		a        botupdates.Answer
		answered bool
		err      error
	}
	waited := make(chan result, 1)
	go func() {
		a, ok, err := h.Updates.AwaitAnswer(ctx, press.CallbackID, botupdates.AnswerTimeout)
		waited <- result{a, ok, err}
	}()

	list = h.updates(token, fmt.Sprintf("offset=%d&timeout=5", offset))
	if len(list) != 1 || list[0].Callback == nil {
		t.Fatalf("updates = %+v", list)
	}
	cb := list[0].Callback
	if cb.Data != "yes" || cb.From.ID != user || cb.Message.Seq != menu.Seq || cb.ID != press.CallbackID {
		t.Fatalf("callback = %+v", cb)
	}
	h.call(http.MethodPost, "/bot/v1/callbacks/"+cb.ID+":answer", token, `{"text": "Đã chọn", "show_alert": true}`).into(t, new(bool))
	select {
	case r := <-waited:
		if r.err != nil || !r.answered || r.a.Text != "Đã chọn" || !r.a.ShowAlert {
			t.Fatalf("presser got %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the presser was not woken")
	}
	h.call(http.MethodPost, "/bot/v1/callbacks/"+cb.ID+":answer", token, `{}`).fails(t, http.StatusBadRequest, "bad_request")
	h.call(http.MethodPost, "/bot/v1/callbacks/unknown:answer", token, "").fails(t, http.StatusNotFound, "not_found")
	h.call(http.MethodPost, "/bot/v1/callbacks/"+cb.ID, token, "").fails(t, http.StatusNotFound, "not_found")

	// Another bot cannot answer it, and without an answer the press times
	// out.
	_, otherToken := h.Bot(owner, "otherbot")
	late, err := h.Chat.PressInlineButton(ctx, user, &appv1.PressInlineButtonRequest{ChatId: private, Seq: menu.Seq, CallbackData: []byte("yes")})
	if err != nil {
		t.Fatal(err)
	}
	h.call(http.MethodPost, "/bot/v1/callbacks/"+late.CallbackID+":answer", otherToken, "").fails(t, http.StatusNotFound, "not_found")
	if _, ok, err := h.Updates.AwaitAnswer(ctx, late.CallbackID, 300*time.Millisecond); ok || err != nil {
		t.Fatalf("unanswered press: answered=%v err=%v", ok, err)
	}
}

func TestSetCommands(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "menubot")
	h.call(http.MethodPut, "/bot/v1/commands", token, `{"commands": [{"command": "start", "description": "Bắt đầu"}]}`).into(t, new(bool))
	h.call(http.MethodPut, "/bot/v1/commands", token, `{"scope": "group", "commands": [{"command": "/Help", "description": "Trợ giúp"}]}`).into(t, new(bool))
	h.call(http.MethodPut, "/bot/v1/commands", token, `{"scope": "nowhere", "commands": []}`).fails(t, http.StatusBadRequest, "bad_request")
	h.call(http.MethodPut, "/bot/v1/commands", token, `{"commands": [{"command": "bad name", "description": "x"}]}`).fails(t, http.StatusBadRequest, "bad_request")

	private, err := h.Admin.Info(ctx, owner, botID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(private.GetCommands()) != 1 || private.GetCommands()[0].GetCommand() != "start" {
		t.Fatalf("private menu = %v", private.GetCommands())
	}
	bots, err := h.Admin.ListMyBots(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(bots) != 1 || len(bots[0].GetCommands()) != 2 {
		t.Fatalf("bots = %v", bots)
	}
}

func TestUpdateIDsUnderConcurrentSends(t *testing.T) {
	h := newHarness(t)
	owner := h.User("owner")
	botID, token := h.Bot(owner, "loadbot")
	off := false
	if _, err := h.Admin.UpdateBot(context.Background(), owner, &appv1.UpdateBotRequest{BotId: botID, Privacy: &off}); err != nil {
		t.Fatal(err)
	}
	const senders, each = 4, 10
	var wg sync.WaitGroup
	for i := range senders {
		u := h.User(fmt.Sprintf("u%d", i))
		chatID := h.Group(u, botID)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range each {
				if _, err := h.Chat.SendMessage(context.Background(), u, &appv1.SendMessageRequest{ChatId: chatID, Text: fmt.Sprintf("m%d", j)}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	h.CatchUp()
	var ids []int64
	texts := 0
	for offset := int64(0); ; {
		list := h.updates(token, fmt.Sprintf("offset=%d", offset))
		if len(list) == 0 {
			break
		}
		for _, u := range list {
			ids = append(ids, u.UpdateID)
			if u.Message != nil && strings.HasPrefix(u.Message.Text, "m") {
				texts++
			}
		}
		offset = list[len(list)-1].UpdateID + 1
	}
	if texts != senders*each {
		t.Fatalf("got %d message updates, want %d", texts, senders*each)
	}
	for i := 1; i < len(ids); i++ {
		if ids[i] <= ids[i-1] {
			t.Fatalf("update ids not increasing: %v", ids)
		}
	}
}

func TestUpdatesDuringShutdown(t *testing.T) {
	h := newHarness(t)
	_, token := h.Bot(h.User("owner"), "drainbot")
	h.Updates.ReleasePolls()
	a := h.call(http.MethodGet, "/bot/v1/updates?timeout=30", token, "")
	a.fails(t, http.StatusServiceUnavailable, "unavailable")
	if a.Error.RetryAfter != int(botupdates.RetryAfterShutdown.Seconds()) {
		t.Fatalf("retry_after = %d", a.Error.RetryAfter)
	}
}

func TestGetUpdatesRecordsTheFetchForTheOwner(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	stranger := h.User("stranger")
	botID, token := h.Bot(owner, "pollbot")

	before, err := h.Admin.Info(ctx, owner, botID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !before.GetIsOwner() || before.GetLastUpdateAt() != 0 || !before.GetNotRunning() {
		t.Fatalf("before any poll: owner=%v last=%d not running=%v", before.GetIsOwner(), before.GetLastUpdateAt(), before.GetNotRunning())
	}

	h.updates(token, "timeout=0")
	var first int64
	if err := h.Store.Pool().QueryRow(ctx, `SELECT floor(extract(epoch FROM last_update_fetch_at))::bigint FROM bots WHERE user_id = $1`, botID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	owned, err := h.Admin.Info(ctx, owner, botID, 0)
	if err != nil || owned.GetLastUpdateAt() != first || first == 0 || owned.GetNotRunning() {
		t.Fatalf("owner info after a poll = %v, %v (stored %d)", owned, err, first)
	}
	other, err := h.Admin.Info(ctx, stranger, botID, 0)
	// Someone else learns nothing about the bot's polling.
	if err != nil || other.GetIsOwner() || other.GetLastUpdateAt() != 0 || other.GetNotRunning() {
		t.Fatalf("stranger info = %v, %v", other, err)
	}
	bots, err := h.Admin.ListMyBots(ctx, owner)
	if err != nil || len(bots) != 1 || bots[0].GetLastUpdateAt() != first {
		t.Fatalf("ListMyBots = %v, %v", bots, err)
	}
}

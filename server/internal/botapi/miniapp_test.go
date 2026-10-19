package botapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func TestGetMiniAppKey(t *testing.T) {
	h := newHarness(t)
	_, token := h.Bot(h.User("owner"), "keybot")
	var got struct {
		PublicKey string `json:"public_key"`
	}
	h.call(http.MethodGet, "/bot/v1/miniAppKey", token, "").into(t, &got)
	key, err := base64.RawURLEncoding.DecodeString(got.PublicKey)
	if err != nil || len(key) != 32 || got.PublicKey != h.MiniApp.PublicKey() {
		t.Fatalf("key = %q (%v)", got.PublicKey, err)
	}
	h.call(http.MethodGet, "/bot/v1/miniAppKey", "", "").fails(t, http.StatusUnauthorized, "unauthorized")
	h.call(http.MethodPost, "/bot/v1/miniAppKey", token, "").fails(t, http.StatusMethodNotAllowed, "method_not_allowed")
}

// web_app buttons carry a Mini App URL on the developer's own domain; the
// harness serves chat.example.test for tenant example.test.
func TestWebAppButtons(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	botID, token := h.Bot(h.User("owner"), "appbot")
	user := h.User("user")
	start, err := h.Chat.StartBot(ctx, user, &appv1.StartBotRequest{BotId: botID})
	if err != nil {
		t.Fatal(err)
	}
	private := start.GetChat().GetId()
	keyboard := func(button string) string {
		return `"text": "Mở", "reply_markup": {"inline_keyboard": [[` + button + `]]}`
	}
	var sent struct {
		Seq         int64 `json:"seq"`
		ReplyMarkup struct {
			InlineKeyboard [][]struct {
				Text   string `json:"text"`
				WebApp struct {
					URL string `json:"url"`
				} `json:"web_app"`
			} `json:"inline_keyboard"`
		} `json:"reply_markup"`
	}
	h.send(token, private, keyboard(`{"text": "Cửa hàng", "web_app": {"url": "https://shop.example.org/app?x=1"}}`)).into(t, &sent)
	if b := sent.ReplyMarkup.InlineKeyboard[0][0]; b.Text != "Cửa hàng" || b.WebApp.URL != "https://shop.example.org/app?x=1" {
		t.Fatalf("button = %+v", b)
	}
	// The user's app sees the button as a Mini App button.
	page, err := h.Chat.GetHistory(ctx, user, &appv1.GetHistoryRequest{ChatId: private, Limit: 1})
	if err != nil || page.GetMessages()[0].GetReplyMarkup().GetInlineKeyboard().GetRows()[0].GetButtons()[0].GetMiniAppUrl() !=
		"https://shop.example.org/app?x=1" {
		t.Fatalf("history = %v, %v", page, err)
	}
	for _, raw := range []string{
		"http://shop.example.org/", "https://example.test/", "https://chat.example.test/app", "https://x.example.test/",
		"https://203.0.113.5/", "https://u:p@shop.example.org/", "https://shop.example.org/#a", "https://localhost/",
		"https://shop.example.org/" + strings.Repeat("a", 512),
	} {
		h.send(token, private, keyboard(fmt.Sprintf(`{"text": "x", "web_app": {"url": %q}}`, raw))).
			fails(t, http.StatusBadRequest, "bad_request")
	}
	h.send(token, private, keyboard(`{"text": "x", "web_app": {"url": "https://shop.example.org/"}, "url": "https://shop.example.org/"}`)).
		fails(t, http.StatusBadRequest, "bad_request")
	// The same rules apply when the markup changes.
	h.call(http.MethodPost, "/bot/v1/messages:editMarkup", token, fmt.Sprintf(
		`{"chat_id": %d, "seq": %d, "reply_markup": {"inline_keyboard": [[{"text": "x", "web_app": {"url": "https://chat.example.test/"}}]]}}`,
		private, sent.Seq)).fails(t, http.StatusBadRequest, "bad_request")
}

// A Mini App's data reaches the bot as message.web_app_data, posted by the
// user into their private chat with the bot (opened when needed); writing
// it is the user's consent, as any message to a bot.
func TestWebAppData(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	botID, token := h.Bot(h.User("owner"), "databot")
	user := h.User("user")
	h.CatchUp()
	h.updates(token, "timeout=0")

	for _, bad := range []struct{ data, button string }{{"", ""}, {strings.Repeat("d", 4097), ""}, {"x", strings.Repeat("b", 65)}} {
		if _, err := h.Chat.SendMiniAppData(ctx, user, botID, bad.data, bad.button); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("data %d bytes, button %d: %v", len(bad.data), len(bad.button), err)
		}
	}
	if _, err := h.Chat.SendMiniAppData(ctx, user, botID+1000, "x", ""); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown bot: %v", err)
	}
	sent, err := h.Chat.SendMiniAppData(ctx, user, botID, `{"order": 42}`, "Cửa hàng")
	if err != nil {
		t.Fatal(err)
	}
	action := sent.GetMessage().GetAction().GetMiniAppData()
	if sent.GetMessage().GetFromId() != user || action.GetData() != `{"order": 42}` || action.GetButtonText() != "Cửa hàng" {
		t.Fatalf("sent = %v", sent.GetMessage())
	}
	h.CatchUp()
	var list []struct {
		Message *struct {
			From struct {
				ID int64 `json:"id"`
			} `json:"from"`
			Chat struct {
				ID int64 `json:"id"`
			} `json:"chat"`
			Text       string          `json:"text"`
			Action     json.RawMessage `json:"action"`
			WebAppData *struct {
				Data       string `json:"data"`
				ButtonText string `json:"button_text"`
			} `json:"web_app_data"`
		} `json:"message"`
	}
	h.call(http.MethodGet, "/bot/v1/updates?timeout=0", token, "").into(t, &list)
	if len(list) != 1 || list[0].Message == nil || list[0].Message.WebAppData == nil {
		t.Fatalf("updates = %+v", list)
	}
	m := list[0].Message
	if m.From.ID != user || m.Chat.ID != sent.GetMessage().GetChatId() || m.Text != "" || m.Action != nil ||
		m.WebAppData.Data != `{"order": 42}` || m.WebAppData.ButtonText != "Cửa hàng" {
		t.Fatalf("message = %+v", m)
	}
	// The user wrote to the bot: it may answer.
	h.send(token, m.Chat.ID, `"text": "Đã nhận đơn"`).into(t, new(sentMessage))
}

// AllowMiniAppWrite: the consent of a button press and the private chat,
// with no message; the bot may then write first.
func TestAllowBotWrite(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	botID, token := h.Bot(h.User("owner"), "writebot")
	user := h.User("user")
	if err := h.Chat.AllowBotWrite(ctx, user, user); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("self: %v", err)
	}
	if err := h.Chat.AllowBotWrite(ctx, user, botID+1000); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown bot: %v", err)
	}
	if err := h.Chat.AllowBotWrite(ctx, user, botID); err != nil {
		t.Fatal(err)
	}
	var source string
	if err := h.Store.Pool().QueryRow(ctx, `SELECT source FROM bot_user_consent WHERE bot_id = $1 AND user_id = $2`,
		botID, user).Scan(&source); err != nil || source != "button" {
		t.Fatalf("consent = %q, %v", source, err)
	}
	chatID, err := h.Chat.BotPrivateChat(ctx, botID, user)
	if err != nil || chatID == 0 {
		t.Fatalf("private chat = %d, %v", chatID, err)
	}
	page, err := h.Chat.GetHistory(ctx, user, &appv1.GetHistoryRequest{ChatId: chatID, Limit: 10})
	if err != nil || len(page.GetMessages()) != 0 {
		t.Fatalf("history = %v, %v", page, err)
	}
	h.send(token, chatID, `"text": "Chào bạn"`).into(t, new(sentMessage))
}

// MiniAppChatType: where a Mini App may open and the chat_type it gets.
func TestMiniAppChatType(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "placebot")
	otherBot, otherToken := h.Bot(owner, "otherbot")
	user := h.User("user")
	stranger := h.User("stranger")
	start, err := h.Chat.StartBot(ctx, user, &appv1.StartBotRequest{BotId: botID})
	if err != nil {
		t.Fatal(err)
	}
	private := start.GetChat().GetId()
	const appURL = "https://shop.example.org/app"
	var menu sentMessage
	h.send(token, private, `"text": "Mở", "reply_markup": {"inline_keyboard": [[{"text": "Mở", "web_app": {"url": "`+appURL+`"}}]]}`).into(t, &menu)
	group := h.Group(owner, user, botID, otherBot)
	var groupMenu sentMessage
	h.send(otherToken, group, `"text": "Mở", "reply_markup": {"inline_keyboard": [[{"text": "Mở", "web_app": {"url": "`+appURL+`"}}]]}`).into(t, &groupMenu)

	for name, c := range map[string]struct {
		me, chat, seq int64
		url           string
		want          string
		code          connect.Code
	}{
		"profile":                   {me: user, want: "sender"},
		"main in the private chat":  {me: user, chat: private, want: "private"},
		"main in a group":           {me: user, chat: group, want: "group"},
		"button":                    {me: user, chat: private, seq: menu.Seq, url: appURL, want: "private"},
		"button from profile":       {me: user, url: appURL, code: connect.CodeInvalidArgument},
		"main with a seq":           {me: user, chat: private, seq: menu.Seq, code: connect.CodeInvalidArgument},
		"foreign url":               {me: user, chat: private, seq: menu.Seq, url: "https://evil.example.org/", code: connect.CodeInvalidArgument},
		"another bot's button":      {me: user, chat: group, seq: groupMenu.Seq, url: appURL, code: connect.CodeInvalidArgument},
		"no seq":                    {me: user, chat: private, url: appURL, code: connect.CodeInvalidArgument},
		"someone else's message":    {me: stranger, chat: private, seq: menu.Seq, url: appURL, code: connect.CodeNotFound},
		"main where the bot is not": {me: user, chat: h.Group(user, stranger), code: connect.CodeInvalidArgument},
	} {
		got, err := h.Chat.MiniAppChatType(ctx, c.me, botID, c.chat, c.seq, c.url)
		if c.code != 0 {
			if connect.CodeOf(err) != c.code {
				t.Errorf("%s: %q, %v; want %v", name, got, err, c.code)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s: %q, %v; want %q", name, got, err, c.want)
		}
	}
}

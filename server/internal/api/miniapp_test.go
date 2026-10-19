package api_test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/miniapp"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// checkInitData verifies init data as a bot does with the key of
// getMiniAppKey and returns its fields.
func checkInitData(t *testing.T, initData string, botID int64, publicKey string) url.Values {
	t.Helper()
	key, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		t.Fatalf("public key %q: %v", publicKey, err)
	}
	q, err := url.ParseQuery(initData)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(q.Get("signature"))
	if err != nil {
		t.Fatal(err)
	}
	fields := map[string]string{}
	for k, v := range q {
		if k != "signature" {
			fields[k] = v[0]
		}
	}
	if !ed25519.Verify(key, []byte(miniapp.DataCheckString(botID, fields)), signature) {
		t.Fatalf("init data does not verify: %s", initData)
	}
	at, err := strconv.ParseInt(q.Get("auth_date"), 10, 64)
	if err != nil || time.Since(time.Unix(at, 0)).Abs() > time.Minute || q.Get("bot_id") != strconv.FormatInt(botID, 10) {
		t.Fatalf("init data fields: %v", q)
	}
	return q
}

// Mini Apps over RPC: the owner sets the main Mini App in the Console, a
// user opens it (and a button's) with signed init data, lets it write and
// sends its data, which the bot reads as web_app_data.
func TestMiniAppsOverRPC(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	owner := e.member(t, "owner")
	e.reauth(t, owner, "owner")
	opt := withOrigin(e.srv.URL)
	admin := appv1connect.NewBotAdminServiceClient(owner.http, e.srv.URL+"/rpc", opt)
	created, err := admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: "shop_bot", Name: "Shop"}))
	if err != nil {
		t.Fatal(err)
	}
	botID := created.Msg.GetBot().GetUser().GetId()
	reset, err := admin.ResetBotToken(ctx, connect.NewRequest(&appv1.ResetBotTokenRequest{BotId: botID}))
	if err != nil {
		t.Fatal(err)
	}
	token := reset.Msg.GetToken()

	// The Console refuses URLs on the app's or a tenant's domain (the env's
	// tenant is hoandat.com) and the other broken ones.
	for _, raw := range []string{"http://shop.example.org/", "https://hoandat.com/", "https://chat.hoandat.com/app",
		"https://127.0.0.1/", "https://u:p@shop.example.org/"} {
		_, err := admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, MiniAppUrl: proto.String(raw)}))
		if codeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), "mini_app_url_not_allowed") {
			t.Fatalf("UpdateBot(%q) = %v", raw, err)
		}
	}
	const mainURL = "https://shop.example.org/app"
	updated, err := admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, MiniAppUrl: proto.String(mainURL)}))
	if err != nil || updated.Msg.GetBot().GetMiniAppUrl() != mainURL {
		t.Fatalf("set mini app: %v, %v", updated, err)
	}
	// Changing another field keeps it.
	updated, err = admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, About: proto.String("Cửa hàng")}))
	if err != nil || updated.Msg.GetBot().GetMiniAppUrl() != mainURL {
		t.Fatalf("other field: %v, %v", updated, err)
	}

	user := e.member(t, "lan")
	bots := appv1connect.NewBotsServiceClient(user.http, e.srv.URL+"/rpc", opt)
	info, err := bots.GetBotInfo(ctx, connect.NewRequest(&appv1.GetBotInfoRequest{BotId: botID}))
	if err != nil || info.Msg.GetMiniAppUrl() != mainURL {
		t.Fatalf("bot info: %v, %v", info, err)
	}
	_, keyOut := e.botCall(t, http.MethodGet, "/bot/v1/miniAppKey", token, "")
	var key struct {
		PublicKey string `json:"public_key"`
	}
	if err := json.Unmarshal(keyOut["result"], &key); err != nil {
		t.Fatal(err)
	}

	// The main Mini App from the bot's profile.
	opened, err := bots.OpenMiniApp(ctx, connect.NewRequest(&appv1.OpenMiniAppRequest{BotId: botID, StartParam: "promo_1"}))
	if err != nil || opened.Msg.GetUrl() != mainURL {
		t.Fatalf("open main: %v, %v", opened, err)
	}
	q := checkInitData(t, opened.Msg.GetInitData(), botID, key.PublicKey)
	var who struct {
		ID        int64  `json:"id"`
		FirstName string `json:"first_name"`
		Username  string `json:"username"`
	}
	if err := json.Unmarshal([]byte(q.Get("user")), &who); err != nil {
		t.Fatal(err)
	}
	if who.ID != user.userID || who.Username != "lan" || who.FirstName != "LAN" || q.Get("chat_type") != "sender" ||
		q.Get("start_param") != "promo_1" || q.Get("tenant_id") != tenantID || q.Get("chat_instance") == "" {
		t.Fatalf("init data = %v (user %+v)", q, who)
	}
	if _, err := bots.OpenMiniApp(ctx, connect.NewRequest(&appv1.OpenMiniAppRequest{BotId: botID, StartParam: "a b"})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad start_param: %v", err)
	}

	// Sending data opens the private chat; the bot reads web_app_data.
	if _, err := bots.SendMiniAppData(ctx, connect.NewRequest(&appv1.SendMiniAppDataRequest{BotId: botID, Data: `{"cart": [1, 2]}`})); err != nil {
		t.Fatal(err)
	}
	status, out := e.botCall(t, http.MethodGet, "/bot/v1/updates?timeout=5", token, "")
	var list []struct {
		Message struct {
			Chat struct {
				ID int64 `json:"id"`
			} `json:"chat"`
			WebAppData *struct {
				Data       string `json:"data"`
				ButtonText string `json:"button_text"`
			} `json:"web_app_data"`
		} `json:"message"`
	}
	if err := json.Unmarshal(out["result"], &list); err != nil || status != http.StatusOK || len(list) != 1 ||
		list[0].Message.WebAppData == nil || list[0].Message.WebAppData.Data != `{"cart": [1, 2]}` {
		t.Fatalf("updates: %d %s", status, out["result"])
	}
	private := list[0].Message.Chat.ID

	// A button's Mini App opens from the bot's message in that chat.
	const buttonURL = "https://shop.example.org/checkout"
	status, out = e.botCall(t, http.MethodPost, "/bot/v1/messages", token, fmt.Sprintf(
		`{"chat_id": %d, "text": "Thanh toán", "reply_markup": {"inline_keyboard": [[{"text": "Thanh toán", "web_app": {"url": %q}}]]}}`,
		private, buttonURL))
	var sent struct {
		Seq int64 `json:"seq"`
	}
	if err := json.Unmarshal(out["result"], &sent); err != nil || status != http.StatusOK {
		t.Fatalf("send button: %d %s", status, out["error"])
	}
	opened, err = bots.OpenMiniApp(ctx, connect.NewRequest(&appv1.OpenMiniAppRequest{BotId: botID, ChatId: private, Seq: sent.Seq, Url: buttonURL}))
	if err != nil || opened.Msg.GetUrl() != buttonURL {
		t.Fatalf("open button: %v, %v", opened, err)
	}
	q = checkInitData(t, opened.Msg.GetInitData(), botID, key.PublicKey)
	if q.Get("chat_type") != "private" || q.Has("start_param") {
		t.Fatalf("button init data = %v", q)
	}
	// A URL the message has no button for, or someone else's message, is refused.
	if _, err := bots.OpenMiniApp(ctx, connect.NewRequest(&appv1.OpenMiniAppRequest{BotId: botID, ChatId: private, Seq: sent.Seq,
		Url: "https://evil.example.org/"})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("foreign url: %v", err)
	}
	stranger := e.member(t, "stranger")
	strangerBots := appv1connect.NewBotsServiceClient(stranger.http, e.srv.URL+"/rpc", opt)
	if _, err := strangerBots.OpenMiniApp(ctx, connect.NewRequest(&appv1.OpenMiniAppRequest{BotId: botID, ChatId: private, Seq: sent.Seq,
		Url: buttonURL})); err == nil {
		t.Fatal("a stranger opened the Mini App of another user's message")
	}

	// AllowMiniAppWrite gives the stranger's consent without a message.
	if _, err := strangerBots.AllowMiniAppWrite(ctx, connect.NewRequest(&appv1.AllowMiniAppWriteRequest{BotId: botID})); err != nil {
		t.Fatal(err)
	}
	var source string
	if err := e.store.Pool().QueryRow(ctx, `SELECT source FROM bot_user_consent WHERE bot_id = $1 AND user_id = $2`,
		botID, stranger.userID).Scan(&source); err != nil || source != "button" {
		t.Fatalf("consent = %q, %v", source, err)
	}

	// Removing the main Mini App: opening it is refused.
	updated, err = admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, MiniAppUrl: proto.String("")}))
	if err != nil || updated.Msg.GetBot().GetMiniAppUrl() != "" {
		t.Fatalf("remove: %v, %v", updated, err)
	}
	if _, err := bots.OpenMiniApp(ctx, connect.NewRequest(&appv1.OpenMiniAppRequest{BotId: botID})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("open without a main Mini App: %v", err)
	}
	if _, err := bots.OpenMiniApp(ctx, connect.NewRequest(&appv1.OpenMiniAppRequest{BotId: botID + 1000})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown bot: %v", err)
	}
}

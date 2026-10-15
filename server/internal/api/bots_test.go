package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth/idptest"
	"connectrpc.com/connect"
)

// botCall calls the Bot API on the test server and decodes the envelope.
func (e *env) botCall(t *testing.T, method, path, token, body string) (int, map[string]json.RawMessage) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), method, e.srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var out map[string]json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s %s: %d %q", method, path, resp.StatusCode, raw)
	}
	return resp.StatusCode, out
}

// The Developer Console flow over RPC: a bot is created with the session,
// its token needs a fresh IdP sign-in (prompt=login, max_age), then the
// bot talks to a user through the Bot API while the user starts it and
// presses its button over RPC.
func TestBotPlatformEndToEnd(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, browser := e.signedIn(t)
	opt := withOrigin(e.srv.URL)
	admin := appv1connect.NewBotAdminServiceClient(browser, e.srv.URL+"/rpc", opt)
	created, err := admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: "echo_bot", Name: "Echo"}))
	if err != nil {
		t.Fatal(err)
	}
	botID := created.Msg.GetBot().GetUser().GetId()

	// A plain sign-in carries no recent auth_time.
	_, err = admin.ResetBotToken(ctx, connect.NewRequest(&appv1.ResetBotTokenRequest{BotId: botID}))
	if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "reauth_required") {
		t.Fatalf("token without a recent sign-in: %v", err)
	}
	resp, body := e.signIn(t, browser, "?reauth=1")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("reauth sign-in: %d %q", resp.StatusCode, body)
	}
	authorizes := e.idp.Authorizes()
	last := authorizes[len(authorizes)-1].Query
	if last.Get("prompt") != "login" || last.Get("max_age") != "600" {
		t.Fatalf("reauth request: %v", last)
	}
	reset, err := admin.ResetBotToken(ctx, connect.NewRequest(&appv1.ResetBotTokenRequest{BotId: botID}))
	if err != nil {
		t.Fatal(err)
	}
	token := reset.Msg.GetToken()

	status, out := e.botCall(t, http.MethodGet, "/bot/v1/me", "", "")
	if status != http.StatusUnauthorized || string(out["ok"]) != "false" {
		t.Fatalf("no token: %d %v", status, out)
	}
	status, out = e.botCall(t, http.MethodGet, "/bot/v1/me", token, "")
	if status != http.StatusOK || !strings.Contains(string(out["result"]), `"username":"echo_bot"`) {
		t.Fatalf("me: %d %v", status, out)
	}

	// A user resolves the deep link, reads the bot's profile and starts it.
	userBrowser := e.browser(t)
	e.idp.SetAccount(idptest.Account{Sub: "acc_user2", SID: "sid-user2", PreferredUsername: "user2", Name: "User 2"})
	e.mustSignIn(t, userBrowser)
	users := appv1connect.NewUsersServiceClient(userBrowser, e.srv.URL+"/rpc", opt)
	resolved, err := users.ResolveUsername(ctx, connect.NewRequest(&appv1.ResolveUsernameRequest{Username: "echo_bot"}))
	if err != nil || !resolved.Msg.GetUser().GetIsBot() {
		t.Fatalf("resolve: %v, %v", resolved, err)
	}
	bots := appv1connect.NewBotsServiceClient(userBrowser, e.srv.URL+"/rpc", opt)
	if _, err := bots.GetBotInfo(ctx, connect.NewRequest(&appv1.GetBotInfoRequest{BotId: botID})); err != nil {
		t.Fatal(err)
	}
	if _, err := bots.InlineQuery(ctx, connect.NewRequest(&appv1.InlineQueryRequest{BotId: botID})); codeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("inline query: %v", err)
	}
	started, err := bots.StartBot(ctx, connect.NewRequest(&appv1.StartBotRequest{BotId: botID, StartParam: "hello", RandomId: 1}))
	if err != nil {
		t.Fatal(err)
	}
	chatID := started.Msg.GetChat().GetId()

	status, out = e.botCall(t, http.MethodGet, "/bot/v1/updates?timeout=5", token, "")
	if status != http.StatusOK || !strings.Contains(string(out["result"]), `"text":"/start hello"`) {
		t.Fatalf("updates: %d %s", status, out["result"])
	}
	var list []struct {
		UpdateID int64 `json:"update_id"`
	}
	_ = json.Unmarshal(out["result"], &list)
	offset := list[len(list)-1].UpdateID + 1

	status, out = e.botCall(t, http.MethodPost, "/bot/v1/messages", token,
		`{"chat_id": `+jsonInt(chatID)+`, "text": "Pick", "reply_markup": {"inline_keyboard": [[{"text": "OK", "callback_data": "ok"}]]}}`)
	if status != http.StatusOK {
		t.Fatalf("send: %d %v", status, out)
	}
	var sent struct {
		Seq int64 `json:"seq"`
	}
	_ = json.Unmarshal(out["result"], &sent)

	messages := appv1connect.NewMessagesServiceClient(userBrowser, e.srv.URL+"/rpc", opt)
	pressed := make(chan *appv1.PressInlineButtonResponse, 1)
	go func() {
		r, err := messages.PressInlineButton(ctx, connect.NewRequest(&appv1.PressInlineButtonRequest{ChatId: chatID, Seq: sent.Seq, CallbackData: []byte("ok")}))
		if err != nil {
			t.Error(err)
			pressed <- nil
			return
		}
		pressed <- r.Msg
	}()
	status, out = e.botCall(t, http.MethodGet, "/bot/v1/updates?timeout=5&offset="+jsonInt(offset), token, "")
	var cbs []struct {
		Callback struct {
			ID string `json:"id"`
		} `json:"callback"`
	}
	if err := json.Unmarshal(out["result"], &cbs); status != http.StatusOK || err != nil || len(cbs) != 1 || cbs[0].Callback.ID == "" {
		t.Fatalf("callback update: %d %s", status, out["result"])
	}
	status, _ = e.botCall(t, http.MethodPost, "/bot/v1/callbacks/"+cbs[0].Callback.ID+":answer", token, `{"text": "Done"}`)
	if status != http.StatusOK {
		t.Fatalf("answer: %d", status)
	}
	select {
	case r := <-pressed:
		if r == nil || r.GetText() != "Done" || r.GetTimedOut() {
			t.Fatalf("press = %v", r)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the press did not return")
	}
}

func jsonInt(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

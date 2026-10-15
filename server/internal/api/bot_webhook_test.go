package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
)

// The Developer Console sets a webhook over RPC; the api process POSTs
// the user's /start to it and runs the sendMessage the webhook answers
// with; the Console reads the delivery state, and only the owner may.
func TestBotWebhookThroughTheConsole(t *testing.T) {
	e := newEnv(t, func(c *config.Config, _ *api.Options) { c.BotWebhookLocal = true })
	ctx := context.Background()
	_, browser := e.signedIn(t)
	opt := withOrigin(e.srv.URL)
	admin := appv1connect.NewBotAdminServiceClient(browser, e.srv.URL+"/rpc", opt)
	created, err := admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: "hook_bot", Name: "Hook"}))
	if err != nil {
		t.Fatal(err)
	}
	botID := created.Msg.GetBot().GetUser().GetId()

	got := make(chan map[string]json.RawMessage, 10)
	rcv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var u map[string]json.RawMessage
		_ = json.Unmarshal(raw, &u)
		got <- u
		var m struct {
			Chat struct {
				ID int64 `json:"id"`
			} `json:"chat"`
		}
		_ = json.Unmarshal(u["message"], &m)
		_, _ = fmt.Fprintf(w, `{"method": "sendMessage", "chat_id": %d, "text": "Xin chào"}`, m.Chat.ID)
	}))
	defer rcv.Close()

	_, err = admin.SetBotWebhook(ctx, connect.NewRequest(&appv1.SetBotWebhookRequest{BotId: botID, Url: "https://10.0.0.1/hook", Secret: "s"}))
	if codeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), "url_blocked") {
		t.Fatalf("private URL: %v", err)
	}
	_, err = admin.SetBotWebhook(ctx, connect.NewRequest(&appv1.SetBotWebhookRequest{BotId: botID, Url: rcv.URL}))
	if codeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), "secret_required") {
		t.Fatalf("no secret: %v", err)
	}
	set, err := admin.SetBotWebhook(ctx, connect.NewRequest(&appv1.SetBotWebhookRequest{
		BotId: botID, Url: rcv.URL, Secret: "console_secret", AllowedUpdates: []string{"message"}, MaxConnections: 3,
	}))
	if err != nil || set.Msg.GetWebhook().GetUrl() != rcv.URL || set.Msg.GetWebhook().GetMaxConnections() != 3 {
		t.Fatalf("set: %v, %v", set, err)
	}
	mine, err := admin.ListMyBots(ctx, connect.NewRequest(&appv1.ListMyBotsRequest{}))
	if err != nil || !mine.Msg.GetBots()[0].GetWebhook() {
		t.Fatalf("list: %v, %v", mine, err)
	}

	userBrowser := e.browser(t)
	e.idp.SetAccount(idptest.Account{Sub: "acc_user3", SID: "sid-user3", PreferredUsername: "user3", Name: "User 3"})
	e.mustSignIn(t, userBrowser)
	bots := appv1connect.NewBotsServiceClient(userBrowser, e.srv.URL+"/rpc", opt)
	started, err := bots.StartBot(ctx, connect.NewRequest(&appv1.StartBotRequest{BotId: botID, RandomId: 5}))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case u := <-got:
		if !strings.Contains(string(u["message"]), `"text":"/start"`) {
			t.Fatalf("webhook got %v", u)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the webhook got nothing")
	}
	messages := appv1connect.NewMessagesServiceClient(userBrowser, e.srv.URL+"/rpc", opt)
	deadline := time.Now().Add(10 * time.Second)
	for {
		h, err := messages.GetHistory(ctx, connect.NewRequest(&appv1.GetHistoryRequest{ChatId: started.Msg.GetChat().GetId(), Limit: 10}))
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, m := range h.Msg.GetMessages() {
			found = found || (m.GetFromId() == botID && m.GetText() == "Xin chào")
		}
		if found {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the webhook's reply never reached the chat")
		}
		time.Sleep(50 * time.Millisecond)
	}

	var delivery *appv1.GetBotDeliveryResponse
	deadline = time.Now().Add(10 * time.Second)
	for {
		d, err := admin.GetBotDelivery(ctx, connect.NewRequest(&appv1.GetBotDeliveryRequest{BotId: botID}))
		if err != nil {
			t.Fatal(err)
		}
		delivery = d.Msg
		if delivery.GetStats().GetDelivered() >= 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if delivery.GetWebhook().GetUrl() != rcv.URL || delivery.GetStats().GetReceived() < 1 || delivery.GetStats().GetDelivered() < 1 ||
		delivery.GetStatus().GetLastSuccessDate() == 0 || delivery.GetStatus().GetPendingCount() != 0 ||
		strings.Join(delivery.GetWebhook().GetAllowedUpdates(), ",") != "message" {
		t.Fatalf("delivery = %v", delivery)
	}
	dead, err := admin.ListBotDeadLetters(ctx, connect.NewRequest(&appv1.ListBotDeadLettersRequest{BotId: botID}))
	if err != nil || dead.Msg.GetTotal() != 0 {
		t.Fatalf("dead letters: %v, %v", dead, err)
	}
	if _, err := admin.RetryBotDeadLetters(ctx, connect.NewRequest(&appv1.RetryBotDeadLettersRequest{BotId: botID})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("retry without ids: %v", err)
	}

	// Somebody else's bot does not exist for them.
	otherAdmin := appv1connect.NewBotAdminServiceClient(userBrowser, e.srv.URL+"/rpc", opt)
	if _, err := otherAdmin.GetBotDelivery(ctx, connect.NewRequest(&appv1.GetBotDeliveryRequest{BotId: botID})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("other user's delivery: %v", err)
	}
	if _, err := otherAdmin.DeleteBotWebhook(ctx, connect.NewRequest(&appv1.DeleteBotWebhookRequest{BotId: botID})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("other user's delete: %v", err)
	}
	if _, err := otherAdmin.DiscardBotDeadLetters(ctx, connect.NewRequest(&appv1.DiscardBotDeadLettersRequest{BotId: botID, UpdateIds: []int64{1}})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("other user's discard: %v", err)
	}
	if _, err := admin.DeleteBotWebhook(ctx, connect.NewRequest(&appv1.DeleteBotWebhookRequest{BotId: botID})); err != nil {
		t.Fatal(err)
	}
	d, err := admin.GetBotDelivery(ctx, connect.NewRequest(&appv1.GetBotDeliveryRequest{BotId: botID}))
	if err != nil || d.Msg.GetWebhook().GetUrl() != "" {
		t.Fatalf("after delete: %v, %v", d, err)
	}
}

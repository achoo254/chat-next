package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// Inline mode over RPC: the client's InlineQuery waits while the bot reads
// the inline_query update and answers through the Bot API; the pick is
// posted with SendInlineResult.
func TestInlineQueryOverRPC(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, browser := e.signedIn(t)
	opt := withOrigin(e.srv.URL)
	admin := appv1connect.NewBotAdminServiceClient(browser, e.srv.URL+"/rpc", opt)
	created, err := admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: "find_bot", Name: "Find"}))
	if err != nil {
		t.Fatal(err)
	}
	botID := created.Msg.GetBot().GetUser().GetId()
	if resp, body := e.signIn(t, browser, "?reauth=1"); resp.StatusCode != http.StatusOK {
		t.Fatalf("reauth: %d %q", resp.StatusCode, body)
	}
	reset, err := admin.ResetBotToken(ctx, connect.NewRequest(&appv1.ResetBotTokenRequest{BotId: botID}))
	if err != nil {
		t.Fatal(err)
	}
	token := reset.Msg.GetToken()
	updated, err := admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, InlinePlaceholder: proto.String("Tìm…")}))
	if err != nil || updated.Msg.GetBot().GetInlinePlaceholder() != "Tìm…" {
		t.Fatalf("placeholder: %v, %v", updated, err)
	}
	bots := appv1connect.NewBotsServiceClient(browser, e.srv.URL+"/rpc", opt)
	started, err := bots.StartBot(ctx, connect.NewRequest(&appv1.StartBotRequest{BotId: botID}))
	if err != nil {
		t.Fatal(err)
	}
	chatID := started.Msg.GetChat().GetId()

	// The bot polls for the query and answers it.
	go func() {
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			_, out := e.botCall(t, http.MethodGet, "/bot/v1/updates?timeout=1&allowed_updates=inline_query", token, "")
			var list []struct {
				InlineQuery *struct {
					ID string `json:"id"`
				} `json:"inline_query"`
			}
			_ = json.Unmarshal(out["result"], &list)
			for _, u := range list {
				if u.InlineQuery != nil {
					body := `{"results": [{"type": "article", "id": "r1", "title": "Kết quả", "text": "Đã tìm"}]}`
					e.botCall(t, http.MethodPost, "/bot/v1/inline/"+u.InlineQuery.ID+":answer", token, body)
					return
				}
			}
		}
	}()
	res, err := bots.InlineQuery(ctx, connect.NewRequest(&appv1.InlineQueryRequest{BotId: botID, ChatId: chatID, Query: "abc"}))
	if err != nil || len(res.Msg.GetResults()) != 1 || res.Msg.GetResults()[0].GetTitle() != "Kết quả" {
		t.Fatalf("inline query: %v, %v", res, err)
	}
	messages := appv1connect.NewMessagesServiceClient(browser, e.srv.URL+"/rpc", opt)
	sent, err := messages.SendInlineResult(ctx, connect.NewRequest(&appv1.SendInlineResultRequest{
		ChatId: chatID, QueryId: res.Msg.GetQueryId(), ResultId: "r1", RandomId: 1,
	}))
	if err != nil || sent.Msg.GetMessage().GetViaBotId() != botID || sent.Msg.GetMessage().GetText() != "Đã tìm" {
		t.Fatalf("send: %v, %v", sent, err)
	}
	// The bot's profile tells clients that inline mode is on.
	users := appv1connect.NewUsersServiceClient(browser, e.srv.URL+"/rpc", opt)
	resolved, err := users.ResolveUsername(ctx, connect.NewRequest(&appv1.ResolveUsernameRequest{Username: "find_bot"}))
	if err != nil || resolved.Msg.GetUser().GetBotInlinePlaceholder() != "Tìm…" {
		t.Fatalf("resolve: %v, %v", resolved, err)
	}
}

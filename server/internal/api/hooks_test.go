package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
)

// An admin creates a webhook over RPC (session and Origin checked); the
// tool posts without cookies or Origin and the message lands in the group.
func TestIncomingHookEndToEnd(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	cl, browser := e.signedIn(t)
	me, err := getSelf(t, cl)
	if err != nil {
		t.Fatal(err)
	}
	group, err := e.app.Chat.CreateGroup(ctx, me.GetId(), "Vận hành", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	chatID := group.GetChat().GetId()

	integrations := appv1connect.NewIntegrationsServiceClient(browser, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	created, err := integrations.CreateIncomingHook(ctx, connect.NewRequest(&appv1.CreateIncomingHookRequest{
		ChatId: chatID, Name: "Alertmanager prod", Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER,
	}))
	if err != nil {
		t.Fatal(err)
	}
	hookURL := created.Msg.GetUrl()
	if !strings.HasPrefix(hookURL, e.srv.URL+"/hook/hk_") || !strings.HasSuffix(hookURL, "/alertmanager") {
		t.Fatalf("url %q", hookURL)
	}
	// Without an Origin the management RPC is refused like every RPC.
	bare := appv1connect.NewIntegrationsServiceClient(browser, e.srv.URL+"/rpc")
	if _, err := bare.GetIncomingHooks(ctx, connect.NewRequest(&appv1.GetIncomingHooksRequest{ChatId: chatID})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("RPC without Origin: %v", err)
	}

	body := `{"status": "firing", "groupKey": "g1", "alerts": [{"status": "firing", "labels": {"alertname": "DiskFull", "instance": "db-02"},
		"startsAt": "2026-10-14T02:42:00Z"}]}`
	resp, err := e.srv.Client().Post(hookURL, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST: %d %s", resp.StatusCode, raw)
	}
	var answer struct {
		ChatID int64 `json:"chat_id"`
		Seq    int64 `json:"seq"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || answer.ChatID != chatID || answer.Seq == 0 {
		t.Fatalf("answer %s", raw)
	}
	history, err := e.app.Chat.GetHistory(ctx, me.GetId(), &appv1.GetHistoryRequest{ChatId: chatID, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	last := history.GetMessages()[len(history.GetMessages())-1]
	if last.GetSeq() != answer.Seq || last.GetIntegrationLabel() != "Alertmanager prod" || !strings.HasPrefix(last.GetText(), "Firing DiskFull trên db-02") {
		t.Fatalf("message %v", last)
	}

	list, err := integrations.GetIncomingHooks(ctx, connect.NewRequest(&appv1.GetIncomingHooksRequest{ChatId: chatID}))
	if err != nil || len(list.Msg.GetHooks()) != 1 || list.Msg.GetHooks()[0].GetId() != created.Msg.GetHook().GetId() {
		t.Fatalf("list %v %v", list, err)
	}
	if strings.Contains(e.logs.String(), strings.TrimPrefix(hookURL, e.srv.URL)) {
		t.Fatal("the hook path reached the logs")
	}
}

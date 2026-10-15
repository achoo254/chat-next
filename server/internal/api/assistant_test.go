package api_test

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
)

// Every start lists the assistant's chat under "Cloud của tôi", with its
// profile and menu; its feedback queue is for operators only.
func TestAssistantChatOnStart(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	cl, browser := e.signedIn(t)
	if _, err := getSelf(t, cl); err != nil {
		t.Fatal(err)
	}
	opt := withOrigin(e.srv.URL)
	chats := appv1connect.NewChatsServiceClient(browser, e.srv.URL+"/rpc", opt)
	dialogs, err := chats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	botID := e.app.Assistant.BotID()
	got := dialogs.Msg.GetDialogs()
	if len(got) != 2 || !got[0].GetPinned() || got[1].GetPinned() || got[1].GetTopSeq() != 0 {
		t.Fatalf("dialogs = %v", got)
	}
	var peer int64
	for _, c := range dialogs.Msg.GetChats() {
		if c.GetId() == got[1].GetChatId() {
			peer = c.GetPeerUserId()
		}
	}
	if peer != botID {
		t.Fatalf("second dialog's peer = %d, assistant %d", peer, botID)
	}
	bots := appv1connect.NewBotsServiceClient(browser, e.srv.URL+"/rpc", opt)
	info, err := bots.GetBotInfo(ctx, connect.NewRequest(&appv1.GetBotInfoRequest{BotId: botID}))
	if err != nil || info.Msg.GetIsOwner() || len(info.Msg.GetCommands()) != 3 || info.Msg.GetDescription() == "" {
		t.Fatalf("assistant info = %v, %v", info, err)
	}
	admin := appv1connect.NewBotAdminServiceClient(browser, e.srv.URL+"/rpc", opt)
	mine, err := admin.ListMyBots(ctx, connect.NewRequest(&appv1.ListMyBotsRequest{}))
	if err != nil || len(mine.Msg.GetBots()) != 0 {
		t.Fatalf("console lists = %v, %v", mine, err)
	}
	moderation := appv1connect.NewModerationServiceClient(browser, e.srv.URL+"/rpc", opt)
	if _, err := moderation.GetFeedback(ctx, connect.NewRequest(&appv1.GetFeedbackRequest{})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("feedback for a user: %v", err)
	}
	if _, err := moderation.ReplyFeedback(ctx, connect.NewRequest(&appv1.ReplyFeedbackRequest{FeedbackId: 1, Text: "x"})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("reply by a user: %v", err)
	}
}

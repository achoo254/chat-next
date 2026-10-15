package api_test

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
)

func TestSearchRPCs(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	anon := appv1connect.NewSearchServiceClient(e.browser(t), e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := anon.SearchMessages(ctx, connect.NewRequest(&appv1.SearchMessagesRequest{Query: "lich"})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("anonymous SearchMessages: %v", err)
	}

	cl, c := e.signedIn(t)
	if _, err := getSelf(t, cl); err != nil {
		t.Fatal(err)
	}
	chats := appv1connect.NewChatsServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	messages := appv1connect.NewMessagesServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	search := appv1connect.NewSearchServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))

	// GetSelf created the user's own chat ("Cloud của tôi"); note something there.
	dialogs, err := chats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{}))
	if err != nil || len(dialogs.Msg.GetDialogs()) == 0 {
		t.Fatalf("GetDialogs = %v, %v", dialogs, err)
	}
	saved := dialogs.Msg.GetDialogs()[0].GetChatId()
	if _, err := messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: saved, Text: "Lịch trực tuần này", RandomId: 7})); err != nil {
		t.Fatal(err)
	}

	found, err := search.SearchMessages(ctx, connect.NewRequest(&appv1.SearchMessagesRequest{Query: "lich truc"}))
	if err != nil || len(found.Msg.GetMessages()) != 1 || found.Msg.GetMessages()[0].GetText() != "Lịch trực tuần này" || len(found.Msg.GetChats()) != 1 {
		t.Fatalf("SearchMessages = %v, %v", found, err)
	}
	inChat, err := search.SearchChatMessages(ctx, connect.NewRequest(&appv1.SearchChatMessagesRequest{ChatId: saved, Query: "tuan nay"}))
	if err != nil || len(inChat.Msg.GetMessages()) != 1 {
		t.Fatalf("SearchChatMessages = %v, %v", inChat, err)
	}
	if _, err := search.SearchChatMessages(ctx, connect.NewRequest(&appv1.SearchChatMessagesRequest{ChatId: saved + 1<<20, Query: "lich"})); err == nil {
		t.Fatal("searched a chat the user is not in")
	}
	if _, err := search.SearchMessages(ctx, connect.NewRequest(&appv1.SearchMessagesRequest{Query: "lich", Cursor: "garbage"})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad cursor: %v", err)
	}
}

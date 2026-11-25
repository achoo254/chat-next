package api_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// dialogChatIDs lists the chat ids of a list_chats result.
func dialogChatIDs(t *testing.T, dialogs map[string]any) []string {
	t.Helper()
	list, _ := dialogs["dialogs"].([]any)
	var ids []string
	for _, d := range list {
		ids = append(ids, fmt.Sprint(at(t, d, "chat_id")))
	}
	return ids
}

// hasUser reports whether a result's users list holds the user.
func hasUser(t *testing.T, result map[string]any, user any) bool {
	t.Helper()
	list, _ := result["users"].([]any)
	for _, u := range list {
		if at(t, u, "id") == user {
			return true
		}
	}
	return false
}

// createHook creates an incoming webhook in chat through its two calls and
// returns its id.
func createHook(t *testing.T, cs *mcp.ClientSession, chat any) string {
	t.Helper()
	args := map[string]any{"chat_id": chat, "name": "Uptime", "format": "slack"}
	token, _ := mustCall(t, cs, "create_incoming_hook", args)["confirm_token"].(string)
	args["confirm_token"] = token
	id, _ := at(t, mustCall(t, cs, "create_incoming_hook", args), "hook", "id").(string)
	if id == "" {
		t.Fatal("no hook id")
	}
	return id
}

// messageSentViaAI reports sent_via_ai of the message with text in a
// get_messages result; found is false when no message has the text.
func messageSentViaAI(t *testing.T, history map[string]any, text string) (via, found bool) {
	t.Helper()
	list, _ := history["messages"].([]any)
	for _, m := range list {
		if at(t, m, "text") == text {
			v, _ := at(t, m, "sent_via_ai").(bool)
			return v, true
		}
	}
	return false, false
}

// A chat the user hid from AI is left out of the tools that span chats and
// refused by the tools that name it; the other members' AI still sees it.
// Messages sent with the tools carry sent_via_ai for their sender only.
func TestMCPHiddenFromAI(t *testing.T) {
	e := newEnv(t)
	_, browser := e.signedIn(t)
	chats := appv1connect.NewChatsServiceClient(browser, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	mustCall(t, cs, "get_me", nil)
	cs2, user2 := e.secondUser(t)

	open := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Nhóm mở", "user_ids": []any{user2}}), "chat", "id")
	hidden := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Nhóm kín", "user_ids": []any{user2}}), "chat", "id")
	openSeq := at(t, mustCall(t, cs, "send_message", map[string]any{"chat_id": open, "text": "zebra openword"}), "message", "seq")
	hiddenSeq := at(t, mustCall(t, cs, "send_message", map[string]any{"chat_id": hidden, "text": "zebra secretword"}), "message", "seq")
	hookID := createHook(t, cs, hidden)
	openHookID := createHook(t, cs, open)
	dm := at(t, mustCall(t, cs, "start_private_chat", map[string]any{"user_id": user2}), "chat", "id")
	mustCall(t, cs, "send_message", map[string]any{"chat_id": dm, "text": "zebra dmword"})

	// sent_via_ai: the sender sees it, the other member does not.
	if via, found := messageSentViaAI(t, mustCall(t, cs, "get_messages", map[string]any{"chat_id": open}), "zebra openword"); !found || !via {
		t.Fatalf("sender: sent_via_ai = %v (found %v)", via, found)
	}
	if via, found := messageSentViaAI(t, mustCall(t, cs2, "get_messages", map[string]any{"chat_id": open}), "zebra openword"); !found || via {
		t.Fatalf("other member: sent_via_ai = %v (found %v)", via, found)
	}

	hide := func(chat any) {
		t.Helper()
		id, ok := chat.(float64)
		if !ok {
			t.Fatalf("chat id %v", chat)
		}
		resp, err := chats.SetDialogHiddenFromAI(context.Background(), connect.NewRequest(&appv1.SetDialogHiddenFromAIRequest{ChatId: int64(id), Hidden: true}))
		if err != nil || !resp.Msg.GetHidden() {
			t.Fatalf("SetDialogHiddenFromAI = %v, %v", resp, err)
		}
	}
	hide(hidden)
	hide(dm)
	hiddenKey, openKey := fmt.Sprint(hidden), fmt.Sprint(open)

	// Tools that span chats leave it out.
	ids := dialogChatIDs(t, mustCall(t, cs, "list_chats", nil))
	if slices.Contains(ids, hiddenKey) || !slices.Contains(ids, openKey) {
		t.Fatalf("list_chats ids %v (hidden %s, open %s)", ids, hiddenKey, openKey)
	}
	if found := mustCall(t, cs, "search_messages", map[string]any{"query": "zebra"}); contains(t, found, "secretword") || !contains(t, found, "openword") {
		t.Fatalf("search_messages: %s", mustJSON(t, found))
	}
	if common := mustCall(t, cs, "get_common_chats", map[string]any{"user_id": user2}); contains(t, common, "Nhóm kín") || !contains(t, common, "Nhóm mở") {
		t.Fatalf("get_common_chats: %s", mustJSON(t, common))
	}

	// The peer of the hidden one-to-one chat is left out of the users too, as
	// nothing kept references them yet.
	if list := mustCall(t, cs, "list_chats", nil); hasUser(t, list, user2) || contains(t, list, "dmword") {
		t.Fatalf("list_chats kept the hidden peer: %s", mustJSON(t, list))
	}
	if found := mustCall(t, cs, "search_messages", map[string]any{"query": "zebra"}); hasUser(t, found, user2) || contains(t, found, "dmword") {
		t.Fatalf("search_messages kept the hidden peer: %s", mustJSON(t, found))
	}

	// Tools that name it are refused, through its webhooks too.
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"get_chat", map[string]any{"chat_id": hidden}},
		{"get_messages", map[string]any{"chat_id": hidden}},
		{"search_messages", map[string]any{"query": "zebra", "chat_id": hidden}},
		{"send_message", map[string]any{"chat_id": hidden, "text": "không được gửi"}},
		{"forward_messages", map[string]any{"from_chat_id": open, "seqs": []any{openSeq}, "to_chat_id": hidden}},
		{"forward_messages", map[string]any{"from_chat_id": hidden, "seqs": []any{hiddenSeq}, "to_chat_id": open}},
		{"copy_message", map[string]any{"from_chat_id": hidden, "seq": hiddenSeq, "to_chat_id": open}},
		{"get_messages", map[string]any{"chat_id": dm}},
		{"get_incoming_hook", map[string]any{"hook_id": hookID}},
		{"get_incoming_hook_stats", map[string]any{"hook_id": hookID}},
		{"list_incoming_hook_dead_letters", map[string]any{"hook_id": hookID}},
		{"get_incoming_hook_audit", map[string]any{"chat_id": open, "hook_id": hookID}},
		{"set_incoming_hook_enabled", map[string]any{"hook_id": hookID, "enabled": false}},
	} {
		if _, errText := callTool(t, cs, c.tool, c.args); !strings.Contains(errText, "permission_denied") || !strings.Contains(errText, "chat_hidden_from_ai:") {
			t.Fatalf("%s %v: %q", c.tool, c.args, errText)
		}
	}

	// A hook of a chat that is not hidden still works.
	mustCall(t, cs, "get_incoming_hook", map[string]any{"hook_id": openHookID})
	mustCall(t, cs, "list_incoming_hook_dead_letters", map[string]any{"hook_id": openHookID})

	// Once a kept message references the peer, the peer is listed again.
	mustCall(t, cs2, "send_message", map[string]any{"chat_id": open, "text": "zebra fromuser2"})
	if list := mustCall(t, cs, "list_chats", nil); !hasUser(t, list, user2) {
		t.Fatalf("list_chats dropped a referenced user: %s", mustJSON(t, list))
	}
	if found := mustCall(t, cs, "search_messages", map[string]any{"query": "zebra"}); !hasUser(t, found, user2) || contains(t, found, "dmword") {
		t.Fatalf("search_messages: %s", mustJSON(t, found))
	}

	// The setting is the user's own: the other member's AI still sees the chat.
	if ids := dialogChatIDs(t, mustCall(t, cs2, "list_chats", nil)); !slices.Contains(ids, hiddenKey) {
		t.Fatalf("other member's list_chats ids %v", ids)
	}
	if history := mustCall(t, cs2, "get_messages", map[string]any{"chat_id": hidden}); !contains(t, history, "secretword") {
		t.Fatalf("other member's get_messages: %s", mustJSON(t, history))
	}
}

// Bot updates from a hidden chat cannot be listed, retried or discarded;
// start_private_chat does not answer a hidden one-to-one chat; a chat the
// user left stays hidden.
func TestMCPHiddenFromAIThroughBotsPrivateChatsAndLeftChats(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	_, browser := e.signedIn(t)
	chats := appv1connect.NewChatsServiceClient(browser, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write bots:read bots:write"))
	mustCall(t, cs, "get_me", nil)
	_, user2 := e.secondUser(t)
	idOf := func(v any) int64 {
		t.Helper()
		f, ok := v.(float64)
		if !ok {
			t.Fatalf("id %v", v)
		}
		return int64(f)
	}
	hide := func(chat any) {
		t.Helper()
		if _, err := chats.SetDialogHiddenFromAI(ctx, connect.NewRequest(&appv1.SetDialogHiddenFromAIRequest{ChatId: idOf(chat), Hidden: true})); err != nil {
			t.Fatal(err)
		}
	}
	refused := func(tool string, args map[string]any) {
		t.Helper()
		if _, errText := callTool(t, cs, tool, args); !strings.Contains(errText, "permission_denied") || !strings.Contains(errText, "chat_hidden_from_ai:") {
			t.Fatalf("%s %v: %q", tool, args, errText)
		}
	}

	open := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Nhóm mở", "user_ids": []any{user2}}), "chat", "id")
	hidden := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Nhóm kín", "user_ids": []any{user2}}), "chat", "id")

	// One dead letter of the bot comes from each chat.
	bot := at(t, mustCall(t, cs, "create_bot", map[string]any{"username": "hidden_test_bot", "name": "Hidden"}), "bot", "user", "id")
	for i, chat := range []any{hidden, open} {
		if _, err := e.store.Pool().Exec(ctx, `
			INSERT INTO bot_updates (bot_id, update_id, outbox_id, kind, seq, chat_id, payload, expires_at, dead_at)
			VALUES ($1, $2, $2, 'message', $2, $3, '{}', now() + interval '1 hour', now())`, idOf(bot), i+1, idOf(chat)); err != nil {
			t.Fatal(err)
		}
	}
	hide(hidden)
	letters := mustCall(t, cs, "list_bot_dead_letters", map[string]any{"bot_id": bot})
	if list, _ := letters["dead_letters"].([]any); len(list) != 1 || at(t, list[0], "update_id") != float64(2) || letters["total"] != float64(1) {
		t.Fatalf("list_bot_dead_letters: %s", mustJSON(t, letters))
	}
	refused("retry_bot_dead_letters", map[string]any{"bot_id": bot, "update_ids": []any{1}})
	refused("discard_bot_dead_letters", map[string]any{"bot_id": bot, "update_ids": []any{2, 1}})
	mustCall(t, cs, "retry_bot_dead_letters", map[string]any{"bot_id": bot, "update_ids": []any{2}})

	// The existing one-to-one chat, once hidden, is not answered.
	dm := at(t, mustCall(t, cs, "start_private_chat", map[string]any{"user_id": user2}), "chat", "id")
	hide(dm)
	refused("start_private_chat", map[string]any{"user_id": user2})

	// Leaving does not show the chat again.
	left := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Nhóm rời", "user_ids": []any{user2}}), "chat", "id")
	mustCall(t, cs, "set_admin", map[string]any{"chat_id": left, "user_id": user2, "admin": true})
	hide(left)
	if _, err := chats.LeaveChat(ctx, connect.NewRequest(&appv1.LeaveChatRequest{ChatId: idOf(left)})); err != nil {
		t.Fatal(err)
	}
	refused("get_chat", map[string]any{"chat_id": left})
}

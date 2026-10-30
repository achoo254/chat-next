package api_test

import (
	"net/http"
	"strings"
	"testing"

	"app.local/server/internal/auth/idptest"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// requireStepUp checks that calling tool with a token of scope is refused
// before it runs, asking for want.
func (e *env) requireStepUp(t *testing.T, scope, tool, want string) {
	t.Helper()
	resp := e.postMCP(t, e.mcpToken(t, scope), "", strings.Replace(toolsCall, "%s", tool, 1))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("%s with %q: status %d", tool, scope, resp.StatusCode)
	}
	if got := resp.Header.Get("WWW-Authenticate"); !strings.Contains(got, `error="insufficient_scope"`) || !strings.Contains(got, want) {
		t.Fatalf("%s with %q: WWW-Authenticate %q", tool, scope, got)
	}
}

// mustCall calls a tool that must succeed.
func mustCall(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) map[string]any {
	t.Helper()
	out, errText := callTool(t, cs, name, args)
	if errText != "" {
		t.Fatalf("%s: %s", name, errText)
	}
	return out
}

// at walks a decoded tool result along object keys.
func at(t *testing.T, v any, keys ...string) any {
	t.Helper()
	for _, k := range keys {
		obj, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("no %q in %v", k, v)
		}
		v = obj[k]
	}
	return v
}

func contains(t *testing.T, v any, s string) bool {
	t.Helper()
	return strings.Contains(string(mustJSON(t, v)), s)
}

// secondUser signs in acc_user2 once (creating its chat account) and returns
// an MCP session acting for it and its user id. user2 adds tester to its
// contacts, which its add_to_groups privacy needs before tester may add it
// to a group. The IdP's current account stays acc_user2 afterwards.
func (e *env) secondUser(t *testing.T) (*mcp.ClientSession, any) {
	t.Helper()
	e.idp.SetAccount(idptest.Account{Sub: "acc_user2", SID: "sid-user2", PreferredUsername: "user2", Name: "User 2"})
	e.mustSignIn(t, e.browser(t))
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write", func(c map[string]any) string { c["sub"] = "acc_user2"; return "" }))
	mustCall(t, cs, "add_contact", map[string]any{"username": "tester"})
	return cs, at(t, mustCall(t, cs, "get_me", nil), "user", "id")
}

// Forwarding, copying, pins, reactions and read receipts go through the
// same handlers as the app.
func TestMCPMessageTools(t *testing.T) {
	e := newEnv(t)
	e.signedIn(t)
	e.requireStepUp(t, "chat:read", "forward_messages", `scope="chat:read chat:write"`)
	e.requireStepUp(t, "bots:read", "get_pinned_messages", `scope="chat:read bots:read"`)
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))

	mustCall(t, cs, "get_me", nil) // creates the user's saved chat
	saved := firstChatID(t, mustCall(t, cs, "list_chats", nil))
	group := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Tin nhắn MCP"}), "chat", "id")
	seq := at(t, mustCall(t, cs, "send_message", map[string]any{"chat_id": group, "text": "ghim tôi"}), "message", "seq")

	mustCall(t, cs, "pin_message", map[string]any{"chat_id": group, "seq": seq, "silent": true})
	if pinned := mustCall(t, cs, "get_pinned_messages", map[string]any{"chat_id": group}); !contains(t, pinned, "ghim tôi") {
		t.Fatalf("pinned: %s", mustJSON(t, pinned))
	}
	mustCall(t, cs, "unpin_message", map[string]any{"chat_id": group, "seq": seq})
	if pinned := mustCall(t, cs, "get_pinned_messages", map[string]any{"chat_id": group}); contains(t, pinned, "ghim tôi") {
		t.Fatalf("still pinned: %s", mustJSON(t, pinned))
	}
	mustCall(t, cs, "pin_message", map[string]any{"chat_id": group, "seq": seq})
	mustCall(t, cs, "unpin_all_messages", map[string]any{"chat_id": group})
	if pinned := mustCall(t, cs, "get_pinned_messages", map[string]any{"chat_id": group}); contains(t, pinned, "ghim tôi") {
		t.Fatalf("unpin all: %s", mustJSON(t, pinned))
	}

	mustCall(t, cs, "set_reaction", map[string]any{"chat_id": group, "seq": seq, "emoji": "👍"})
	if reactions := mustCall(t, cs, "get_message_reactions", map[string]any{"chat_id": group, "seq": seq}); !contains(t, reactions, "👍") {
		t.Fatalf("reactions: %s", mustJSON(t, reactions))
	}
	mustCall(t, cs, "get_message_readers", map[string]any{"chat_id": group, "seq": seq})

	forwarded := mustCall(t, cs, "forward_messages", map[string]any{"from_chat_id": group, "seqs": []any{seq}, "to_chat_id": saved})
	if list, _ := forwarded["messages"].([]any); len(list) != 1 {
		t.Fatalf("forwarded: %s", mustJSON(t, forwarded))
	}
	mustCall(t, cs, "copy_message", map[string]any{"from_chat_id": group, "seq": seq, "to_chat_id": saved, "text": "bản sao"})
	history := mustCall(t, cs, "get_messages", map[string]any{"chat_id": saved, "limit": 5})
	if !contains(t, history, "ghim tôi") || !contains(t, history, "bản sao") {
		t.Fatalf("saved chat: %s", mustJSON(t, history))
	}
}

// Groups, channels, members, invite links, forum topics and the user's own
// dialog settings.
func TestMCPGroupTools(t *testing.T) {
	e := newEnv(t)
	e.signedIn(t)
	e.requireStepUp(t, "chat:read", "create_group", `scope="chat:read chat:write"`)
	e.requireStepUp(t, "chat:read", "set_dialog_mute", `scope="chat:read chat:write"`)
	e.requireStepUp(t, "chat:write", "get_forum_topics", `scope="chat:read chat:write"`)
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	mustCall(t, cs, "get_me", nil)
	other, user2 := e.secondUser(t)

	group := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Nhóm MCP", "forum": true}), "chat", "id")
	mustCall(t, cs, "add_members", map[string]any{"chat_id": group, "user_ids": []any{user2}})
	mustCall(t, cs, "set_admin", map[string]any{"chat_id": group, "user_id": user2, "admin": true})
	mustCall(t, cs, "set_admin", map[string]any{"chat_id": group, "user_id": user2, "admin": false})
	mustCall(t, cs, "set_member_permissions", map[string]any{"chat_id": group, "user_id": user2, "permissions": 1})
	mustCall(t, cs, "update_chat_info", map[string]any{"chat_id": group, "title": "Nhóm MCP mới"})
	if chat := mustCall(t, cs, "get_chat", map[string]any{"chat_id": group}); !contains(t, chat, "Nhóm MCP mới") {
		t.Fatalf("title: %s", mustJSON(t, chat))
	}

	link := at(t, mustCall(t, cs, "export_invite_link", map[string]any{"chat_id": group, "usage_limit": 5}), "invite", "link").(string)
	if links := mustCall(t, cs, "get_invite_links", map[string]any{"chat_id": group}); !contains(t, links, link) {
		t.Fatalf("links: %s", mustJSON(t, links))
	}
	mustCall(t, cs, "revoke_invite_link", map[string]any{"chat_id": group, "link": link})

	topic := at(t, mustCall(t, cs, "create_forum_topic", map[string]any{"chat_id": group, "title": "Chủ đề A"}), "topic", "id")
	mustCall(t, cs, "edit_forum_topic", map[string]any{"chat_id": group, "topic_id": topic, "title": "Chủ đề B"})
	if topics := mustCall(t, cs, "get_forum_topics", map[string]any{"chat_id": group}); !contains(t, topics, "Chủ đề B") {
		t.Fatalf("topics: %s", mustJSON(t, topics))
	}

	mustCall(t, other, "leave_chat", map[string]any{"chat_id": group})
	mustCall(t, cs, "add_members", map[string]any{"chat_id": group, "user_ids": []any{user2}})
	mustCall(t, cs, "remove_member", map[string]any{"chat_id": group, "user_id": user2, "ban": false})
	if members := mustCall(t, cs, "get_chat_members", map[string]any{"chat_id": group}); contains(t, members, "user2") {
		t.Fatalf("still a member: %s", mustJSON(t, members))
	}
	// Not an admin: the service refuses, as in the app.
	if _, errText := callTool(t, other, "export_invite_link", map[string]any{"chat_id": group}); errText == "" {
		t.Fatal("a non-member exported an invite link")
	}

	channel := at(t, mustCall(t, cs, "create_channel", map[string]any{"title": "Kênh MCP", "about": "tin"}), "chat", "id")
	mustCall(t, cs, "set_dialog_pinned", map[string]any{"chat_id": channel, "pinned": true})
	mustCall(t, cs, "set_dialog_mute", map[string]any{"chat_id": channel, "forever": true})
	mustCall(t, cs, "set_dialog_unread_mark", map[string]any{"chat_id": channel, "unread": true})
	var dialog map[string]any
	for _, d := range at(t, mustCall(t, cs, "list_chats", nil), "dialogs").([]any) {
		if m := d.(map[string]any); m["chat_id"] == channel {
			dialog = m
		}
	}
	if dialog["pinned"] != true || dialog["unread_mark"] != true || dialog["mute_until"] == nil {
		t.Fatalf("dialog: %v", dialog)
	}
}

// The contact list, blocking and the chats shared with another user.
func TestMCPContactTools(t *testing.T) {
	e := newEnv(t)
	e.signedIn(t)
	e.requireStepUp(t, "bots:read", "get_contacts", `scope="chat:read bots:read"`)
	e.requireStepUp(t, "chat:read", "block_user", `scope="chat:read chat:write"`)
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	mustCall(t, cs, "get_me", nil)
	_, user2 := e.secondUser(t)

	if _, errText := callTool(t, cs, "add_contact", map[string]any{"user_id": user2, "username": "user2"}); !strings.Contains(errText, "invalid_argument") {
		t.Fatalf("two targets: %q", errText)
	}
	mustCall(t, cs, "add_contact", map[string]any{"username": "@user2"})
	if contacts := mustCall(t, cs, "get_contacts", nil); !contains(t, contacts, `"username":"user2"`) {
		t.Fatalf("contacts: %s", mustJSON(t, contacts))
	}
	mustCall(t, cs, "delete_contact", map[string]any{"user_id": user2})
	if contacts := mustCall(t, cs, "get_contacts", nil); contains(t, contacts, `"username":"user2"`) {
		t.Fatalf("contact kept: %s", mustJSON(t, contacts))
	}

	mustCall(t, cs, "create_group", map[string]any{"title": "Chung", "user_ids": []any{user2}})
	if common := mustCall(t, cs, "get_common_chats", map[string]any{"user_id": user2}); !contains(t, common, "Chung") {
		t.Fatalf("common chats: %s", mustJSON(t, common))
	}

	mustCall(t, cs, "block_user", map[string]any{"user_id": user2})
	if blocked := mustCall(t, cs, "get_blocked_users", nil); !contains(t, blocked, `"username":"user2"`) {
		t.Fatalf("blocked: %s", mustJSON(t, blocked))
	}
	mustCall(t, cs, "unblock_user", map[string]any{"user_id": user2})
	if blocked := mustCall(t, cs, "get_blocked_users", nil); contains(t, blocked, `"username":"user2"`) {
		t.Fatalf("still blocked: %s", mustJSON(t, blocked))
	}
}

// Incoming webhooks: reads are plain; creating one, rotating its secret,
// taking it over and deleting it preview first and need the confirm token
// of that preview.
func TestMCPIncomingHookTools(t *testing.T) {
	e := newEnv(t)
	e.signedIn(t)
	e.requireStepUp(t, "bots:read", "list_incoming_hooks", `scope="chat:read bots:read"`)
	e.requireStepUp(t, "chat:read", "create_incoming_hook", `scope="chat:read chat:write"`)
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	mustCall(t, cs, "get_me", nil)
	group := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Giám sát"}), "chat", "id")

	args := map[string]any{"chat_id": group, "name": "Uptime", "format": "slack"}
	if _, errText := callTool(t, cs, "create_incoming_hook", map[string]any{"chat_id": group, "name": "x", "format": "xml"}); !strings.Contains(errText, "invalid_argument") {
		t.Fatalf("bad format: %q", errText)
	}
	preview := mustCall(t, cs, "create_incoming_hook", args)
	token, _ := preview["confirm_token"].(string)
	if token == "" || contains(t, preview, "/hook/") || at(t, preview, "preview", "chat_title") != "Giám sát" {
		t.Fatalf("preview: %s", mustJSON(t, preview))
	}
	if hooks := mustCall(t, cs, "list_incoming_hooks", map[string]any{"chat_id": group}); contains(t, hooks, "Uptime") {
		t.Fatal("the preview created the hook")
	}
	if _, errText := callTool(t, cs, "create_incoming_hook", map[string]any{"chat_id": group, "name": "Other", "format": "slack", "confirm_token": token}); !strings.Contains(errText, "confirm_token_invalid") {
		t.Fatalf("other arguments: %q", errText)
	}
	args["confirm_token"] = token
	created := mustCall(t, cs, "create_incoming_hook", args)
	url, _ := created["url"].(string)
	if !strings.HasPrefix(url, e.srv.URL+"/hook/hk_") || !strings.HasSuffix(url, "/slack") {
		t.Fatalf("created: %s", mustJSON(t, created))
	}
	if _, errText := callTool(t, cs, "create_incoming_hook", args); !strings.Contains(errText, "confirm_token_used") {
		t.Fatalf("reused token: %q", errText)
	}
	hookID := at(t, created, "hook", "id").(string)
	hook := map[string]any{"hook_id": hookID}

	if got := mustCall(t, cs, "get_incoming_hook", hook); contains(t, got, url) {
		t.Fatal("get_incoming_hook revealed the secret URL")
	}
	updated := mustCall(t, cs, "update_incoming_hook", map[string]any{"hook_id": hookID, "silent": true})
	if at(t, updated, "hook", "name") != "Uptime" || at(t, updated, "hook", "silent") != true {
		t.Fatalf("update: %s", mustJSON(t, updated))
	}
	mustCall(t, cs, "set_incoming_hook_enabled", map[string]any{"hook_id": hookID, "enabled": false})
	mustCall(t, cs, "set_incoming_hook_enabled", map[string]any{"hook_id": hookID, "enabled": true})
	mustCall(t, cs, "get_incoming_hook_stats", map[string]any{"hook_id": hookID, "hours": 1})
	mustCall(t, cs, "list_incoming_hook_dead_letters", hook)
	if audit := mustCall(t, cs, "get_incoming_hook_audit", map[string]any{"chat_id": group}); !contains(t, audit, "INCOMING_HOOK_AUDIT_ACTION_DISABLED") {
		t.Fatalf("audit: %s", mustJSON(t, audit))
	}

	// confirm runs a two-call tool: preview, then the confirmed call.
	confirm := func(tool string, args map[string]any) map[string]any {
		t.Helper()
		p := mustCall(t, cs, tool, args)
		if p["confirm_token"] == nil || at(t, p, "preview", "hook", "id") != hookID {
			t.Fatalf("%s preview: %s", tool, mustJSON(t, p))
		}
		args["confirm_token"] = p["confirm_token"]
		return mustCall(t, cs, tool, args)
	}
	rotated := confirm("rotate_incoming_hook_secret", map[string]any{"hook_id": hookID})
	if newURL, _ := rotated["url"].(string); newURL == "" || newURL == url {
		t.Fatalf("rotate: %s", mustJSON(t, rotated))
	}
	confirm("revoke_previous_hook_secret", map[string]any{"hook_id": hookID})
	confirm("take_over_incoming_hook", map[string]any{"hook_id": hookID})
	confirm("delete_incoming_hook", map[string]any{"hook_id": hookID})
	if hooks := mustCall(t, cs, "list_incoming_hooks", map[string]any{"chat_id": group}); contains(t, hooks, hookID) {
		t.Fatalf("hook kept: %s", mustJSON(t, hooks))
	}
}

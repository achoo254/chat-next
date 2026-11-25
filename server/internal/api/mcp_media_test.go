package api_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpUpload uploads data with start_media_upload, a PUT per part (no auth
// header) and complete_media_upload, and returns the media id.
func (e *mediaEnv) mcpUpload(t *testing.T, cs *mcp.ClientSession, kind, name string, data []byte) string {
	t.Helper()
	started := mustCall(t, cs, "start_media_upload", map[string]any{
		"kind": kind, "file_name": name, "size": len(data), "file_hash": hashOf(data),
	})
	if existing, ok := started["existing"].(map[string]any); ok {
		return existing["file_id"].(string)
	}
	partSize := int(at(t, started, "upload", "part_size").(float64))
	parts, _ := at(t, started, "upload", "parts").([]any)
	if len(parts) == 0 {
		t.Fatalf("no parts: %s", mustJSON(t, started))
	}
	var etags []any
	for _, p := range parts {
		n := int(at(t, p, "part_number").(float64))
		start := (n - 1) * partSize
		etag := e.putPart(t, at(t, p, "url").(string), data[start:min(start+partSize, len(data))])
		etags = append(etags, map[string]any{"part_number": n, "etag": etag})
	}
	done := mustCall(t, cs, "complete_media_upload", map[string]any{"upload_id": at(t, started, "upload", "upload_id"), "parts": etags})
	id, _ := at(t, done, "media", "file_id").(string)
	if id == "" {
		t.Fatalf("complete: %s", mustJSON(t, done))
	}
	return id
}

// refusedWith checks that a tool call fails with an error text holding every
// part of want.
func refusedWith(t *testing.T, cs *mcp.ClientSession, tool string, args map[string]any, want ...string) {
	t.Helper()
	_, errText := callTool(t, cs, tool, args)
	for _, w := range want {
		if !strings.Contains(errText, w) {
			t.Fatalf("%s %v: %q, want %q", tool, args, errText, w)
		}
	}
}

// An agent uploads files with the MCP tools only (the bytes go to the media
// host's signed URLs) and sends them as one message or as an album, under
// the app's limits, the hidden-from-AI rule and the chat's send rules.
func TestMCPSendMedia(t *testing.T) {
	ctx := context.Background()
	e := newMediaEnv(t, config.StorageFilesystem, nil)
	_, browser := e.signedIn(t)
	chats := appv1connect.NewChatsServiceClient(browser, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	mustCall(t, cs, "get_me", nil)
	cs2, user2 := e.secondUser(t)
	group := at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Ảnh", "user_ids": []any{user2}}), "chat", "id")

	// Upload limits and rules are the app's.
	refusedWith(t, cs, "start_media_upload", map[string]any{"kind": "sticker", "size": 10, "file_hash": strings.Repeat("a", 64)},
		"invalid_argument", "kind must be")
	refusedWith(t, cs, "start_media_upload", map[string]any{"kind": "photo", "size": 21 << 20, "file_hash": strings.Repeat("a", 64)},
		"invalid_argument", "photos are limited")
	refusedWith(t, cs, "start_media_upload", map[string]any{"kind": "document", "size": (64 << 20) + 1, "file_hash": strings.Repeat("a", 64)},
		"invalid_argument", fmt.Sprintf("size must be 1 to %d bytes", 64<<20))
	refusedWith(t, cs, "start_media_upload", map[string]any{"kind": "document", "size": 10, "file_hash": "nothex"},
		"invalid_argument", "file_hash")

	// One media id: one message, marked as sent via AI for its sender.
	photo := e.mcpUpload(t, cs, "photo", "a.jpg", photoWithGPS(t, 40, 30))
	single := mustCall(t, cs, "send_media", map[string]any{"chat_id": group, "media_ids": []any{photo}, "caption": "một ảnh"})
	if at(t, single, "message", "media", "file_id") != photo || at(t, single, "message", "text") != "một ảnh" || at(t, single, "message", "sent_via_ai") != true {
		t.Fatalf("single: %s", mustJSON(t, single))
	}
	// Uploading the same bytes again answers the stored file.
	if again := e.mcpUpload(t, cs, "photo", "a.jpg", photoWithGPS(t, 40, 30)); again != photo {
		t.Fatalf("dedupe: %s, want %s", again, photo)
	}

	// Several: one album, the caption under the first item.
	second := e.mcpUpload(t, cs, "photo", "b.jpg", photoWithGPS(t, 32, 48))
	album := mustCall(t, cs, "send_media", map[string]any{"chat_id": group, "media_ids": []any{photo, second}, "caption": "hai ảnh"})
	msgs, _ := album["messages"].([]any)
	if len(msgs) != 2 || at(t, msgs[0], "grouped_id") == nil || at(t, msgs[0], "grouped_id") != at(t, msgs[1], "grouped_id") ||
		at(t, msgs[0], "text") != "hai ảnh" || at(t, msgs[1], "media", "file_id") != second {
		t.Fatalf("album: %s", mustJSON(t, album))
	}
	refusedWith(t, cs, "send_media", map[string]any{"chat_id": group, "media_ids": []any{}}, "invalid_argument", "media_ids")

	// A chat the user cannot post in.
	channel := at(t, mustCall(t, cs, "create_channel", map[string]any{"title": "Kênh"}), "chat", "id")
	mustCall(t, cs, "add_members", map[string]any{"chat_id": channel, "user_ids": []any{user2}})
	own := e.mcpUpload(t, cs2, "document", "note.txt", []byte("tệp của người thứ hai"))
	refusedWith(t, cs2, "send_media", map[string]any{"chat_id": channel, "media_ids": []any{own}},
		"permission_denied", "you cannot send messages in this chat")

	// A chat copied from another app that only receives.
	linked := int64(at(t, mustCall(t, cs, "create_group", map[string]any{"title": "Bản sao Telegram"}), "chat", "id").(float64))
	var tester int64
	if err := e.store.Pool().QueryRow(ctx, `SELECT creator_id FROM chats WHERE id = $1`, linked).Scan(&tester); err != nil {
		t.Fatal(err)
	}
	var account int64
	if err := e.store.Pool().QueryRow(ctx, `
		INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', 'tg-media-test', '\x00') RETURNING id`,
		tester).Scan(&account); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.Pool().Exec(ctx, `INSERT INTO external_chats (account_id, external_chat_id, chat_id, direction) VALUES ($1, 'c1', $2, 'in')`,
		account, linked); err != nil {
		t.Fatal(err)
	}
	refusedWith(t, cs, "send_media", map[string]any{"chat_id": linked, "media_ids": []any{photo}},
		"permission_denied", "imported_chat_read_only")

	// A chat hidden from AI.
	if _, err := chats.SetDialogHiddenFromAI(ctx, connect.NewRequest(&appv1.SetDialogHiddenFromAIRequest{ChatId: int64(group.(float64)), Hidden: true})); err != nil {
		t.Fatal(err)
	}
	refusedWith(t, cs, "send_media", map[string]any{"chat_id": group, "media_ids": []any{photo}}, "permission_denied", "chat_hidden_from_ai:")
}

// Without media storage the upload tools answer media_disabled.
func TestMCPMediaUploadWithoutStorage(t *testing.T) {
	e := newEnv(t)
	e.signedIn(t)
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	mustCall(t, cs, "get_me", nil)
	e.requireStepUp(t, "chat:read", "start_media_upload", `scope="chat:read chat:write"`)
	refusedWith(t, cs, "start_media_upload", map[string]any{"kind": "document", "size": 10, "file_hash": strings.Repeat("a", 64)},
		"failed_precondition", "media_disabled")
}

// With direct uploads the part URLs are presigned storage URLs; the agent
// PUTs to them the same way.
func TestMCPMediaUploadDirectToStorage(t *testing.T) {
	e := newMediaEnv(t, config.StorageS3, nil)
	e.signedIn(t)
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	mustCall(t, cs, "get_me", nil)
	saved := firstChatID(t, mustCall(t, cs, "list_chats", nil))
	doc := e.mcpUpload(t, cs, "document", "report.txt", []byte("báo cáo do agent tạo"))
	sent := mustCall(t, cs, "send_media", map[string]any{"chat_id": saved, "media_ids": []any{doc}})
	if at(t, sent, "message", "media", "file_name") != "report.txt" || at(t, sent, "message", "sent_via_ai") != true {
		t.Fatalf("sent: %s", mustJSON(t, sent))
	}
}

package botapi

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bottest"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// A user's inline query reaches the bot as inline_query (query, user and
// kind of chat only); the bot's answer is shown to the user, its photos are
// downloadable through the query, and the pick is posted by the user via
// the bot. Another user reuses a cached answer.
func TestInlineMode(t *testing.T) {
	h := newHarnessWith(t, bottest.Options{Media: true})
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "searchbot")
	_, ownerChat := h.started(botID, "owner2")
	var photo fullMessage
	h.multipartCall("/bot/v1/messages:sendMedia", token, map[string]string{"chat_id": fmt.Sprint(ownerChat), "kind": "photo"},
		upload{"file", "meo.png", pngBytes(t, 64, 48)}).into(t, &photo)
	user, friend := h.User("lan"), h.User("minh")
	group := h.Group(user, friend)
	h.drain(token)

	// Off until the owner sets a placeholder.
	ask := &appv1.InlineQueryRequest{BotId: botID, ChatId: group, Query: "mèo"}
	if _, err := h.Chat.InlineQuery(ctx, user, ask); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("inline off: %v", err)
	}
	if _, err := h.Admin.UpdateBot(ctx, owner, &appv1.UpdateBotRequest{BotId: botID, InlinePlaceholder: proto.String("Tìm ảnh…")}); err != nil {
		t.Fatal(err)
	}
	q, err := h.Chat.InlineQuery(ctx, user, ask)
	if err != nil || q.Answered {
		t.Fatalf("query = %+v, %v", q, err)
	}
	h.CatchUp()
	list := h.updates(token, "timeout=0")
	if len(list) != 1 || list[0].InlineQuery == nil {
		t.Fatalf("updates = %+v", list)
	}
	got := list[0].InlineQuery
	if got.ID != q.ID || got.From.ID != user || got.Query != "mèo" || got.ChatType != "group" {
		t.Fatalf("inline_query = %+v", got)
	}

	answer := map[string]any{
		"cache_time": 60,
		"results": []map[string]any{
			{"type": "article", "id": "a1", "title": "Mèo gõ phím", "description": "Một bài", "thumbnail_file_id": photo.Media.FileID,
				"text": "*Mèo* gõ phím", "parse_mode": "markdown",
				"reply_markup": map[string]any{"inline_keyboard": [][]map[string]any{{{"text": "Xem", "url": "https://example.com"}}}}},
			{"type": "photo", "id": "p1", "file_id": photo.Media.FileID, "caption": "ảnh mèo"},
		},
	}
	path := "/bot/v1/inline/" + q.ID + ":answer"
	h.post(token, path, map[string]any{"results": []map[string]any{{"type": "article", "id": "x", "title": "t"}}}).
		fails(t, http.StatusBadRequest, "bad_request") // an article needs text
	h.post(token, path, map[string]any{"results": []map[string]any{{"type": "photo", "id": "x", "file_id": "AAAAAAAAAAAAAAAAAAAAAA"}}}).
		fails(t, http.StatusBadRequest, "bad_request") // not the bot's file
	h.post(token, path, map[string]any{"results": []map[string]any{{"type": "article", "id": "x", "title": "t", "text": "x",
		"reply_markup":                                map[string]any{"inline_keyboard": [][]map[string]any{{{"text": "Bấm", "callback_data": "c"}}}}}}}).
		fails(t, http.StatusBadRequest, "bad_request") // URL buttons only
	h.post(token, path, answer).into(t, new(bool))
	h.post(token, path, answer).fails(t, http.StatusBadRequest, "bad_request") // answered already

	res, err := h.Chat.InlineResults(ctx, user, q.ID)
	if err != nil || len(res.GetResults()) != 2 {
		t.Fatalf("results = %v, %v", res, err)
	}
	if a := res.GetResults()[0]; a.GetKind() != appv1.InlineResultKind_INLINE_RESULT_KIND_ARTICLE || a.GetTitle() != "Mèo gõ phím" ||
		a.GetThumbnail().GetFileId() != photo.Media.FileID {
		t.Fatalf("article = %v", a)
	}
	if p := res.GetResults()[1]; p.GetKind() != appv1.InlineResultKind_INLINE_RESULT_KIND_PHOTO || p.GetMedia().GetFileId() != photo.Media.FileID {
		t.Fatalf("photo = %v", p)
	}
	// The photo downloads through the query, for its user only.
	fileReq := []*appv1.GetFileUrlRequest{{FileId: photo.Media.FileID, Context: &appv1.GetFileUrlRequest_InlineQueryId{InlineQueryId: q.ID}}}
	if grants, err := h.Chat.AuthorizeFiles(ctx, user, fileReq); err != nil || grants[0] == nil || grants[0].ChatID != 0 {
		t.Fatalf("grants = %v, %v", grants, err)
	}
	if grants, err := h.Chat.AuthorizeFiles(ctx, friend, fileReq); err != nil || grants[0] != nil {
		t.Fatalf("another user's grants = %v, %v", grants, err)
	}

	sent, err := h.Chat.SendInlineResult(ctx, user, &appv1.SendInlineResultRequest{ChatId: group, QueryId: q.ID, ResultId: "a1", RandomId: 7})
	if err != nil {
		t.Fatal(err)
	}
	if m := sent.GetMessage(); m.GetViaBotId() != botID || m.GetFromId() != user || m.GetText() != "Mèo gõ phím" ||
		len(m.GetEntities()) != 1 || m.GetReplyMarkup().GetInlineKeyboard() == nil {
		t.Fatalf("article message = %v", m)
	}
	pic, err := h.Chat.SendInlineResult(ctx, user, &appv1.SendInlineResultRequest{ChatId: group, QueryId: q.ID, ResultId: "p1"})
	if err != nil || pic.GetMessage().GetMedia().GetFileId() != photo.Media.FileID || pic.GetMessage().GetViaBotId() != botID ||
		pic.GetMessage().GetText() != "ảnh mèo" {
		t.Fatalf("photo message = %v, %v", pic, err)
	}
	if _, err := h.Chat.SendInlineResult(ctx, user, &appv1.SendInlineResultRequest{ChatId: group, QueryId: q.ID, ResultId: "nope"}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown result: %v", err)
	}
	if _, err := h.Chat.SendInlineResult(ctx, friend, &appv1.SendInlineResultRequest{ChatId: group, QueryId: q.ID, ResultId: "a1"}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("another user's query: %v", err)
	}

	// The same query from the friend: the cached answer, no new update.
	again, err := h.Chat.InlineQuery(ctx, friend, ask)
	if err != nil || !again.Answered {
		t.Fatalf("cached = %+v, %v", again, err)
	}
	if res, err := h.Chat.InlineResults(ctx, friend, again.ID); err != nil || len(res.GetResults()) != 2 {
		t.Fatalf("cached results = %v, %v", res, err)
	}
	h.CatchUp()
	if list := h.updates(token, fmt.Sprintf("offset=%d&timeout=0", list[0].UpdateID+1)); len(list) != 0 {
		t.Fatalf("a cached answer asked the bot again: %+v", list)
	}
	// A chat the user is not in.
	other := h.Group(owner, h.User("x"))
	if _, err := h.Chat.InlineQuery(ctx, user, &appv1.InlineQueryRequest{BotId: botID, ChatId: other, Query: "a"}); err == nil {
		t.Fatal("inline query in a chat of others")
	}
}

package botapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/bottest"
)

type fullMessage struct {
	Seq      int64  `json:"seq"`
	Text     string `json:"text"`
	EditDate int64  `json:"edit_date"`
	Chat     struct {
		ID int64 `json:"id"`
	} `json:"chat"`
	From struct {
		ID int64 `json:"id"`
	} `json:"from"`
	ReplyMarkup *struct {
		InlineKeyboard [][]struct {
			Text         string `json:"text"`
			CallbackData string `json:"callback_data"`
		} `json:"inline_keyboard"`
	} `json:"reply_markup"`
	ForwardFrom *struct {
		UserID int64 `json:"user_id"`
	} `json:"forward_from"`
	Media *struct {
		Kind   string `json:"kind"`
		FileID string `json:"file_id"`
		Width  int32  `json:"width"`
	} `json:"media"`
	GroupedID int64 `json:"grouped_id"`
}

type member struct {
	User struct {
		ID int64 `json:"id"`
	} `json:"user"`
	Status      string `json:"status"`
	Permissions uint32 `json:"permissions"`
}

// started returns a user who started the bot, and their private chat.
func (h *harness) started(botID int64, name string) (int64, int64) {
	h.T.Helper()
	user := h.User(name)
	resp, err := h.Chat.StartBot(context.Background(), user, &appv1.StartBotRequest{BotId: botID})
	if err != nil {
		h.T.Fatal(err)
	}
	return user, resp.GetChat().GetId()
}

// drain acknowledges every pending update and returns the next offset.
func (h *harness) drain(token string) int64 {
	h.T.Helper()
	h.CatchUp()
	list := h.updates(token, "timeout=0")
	if len(list) == 0 {
		return 0
	}
	next := list[len(list)-1].UpdateID + 1
	h.updates(token, fmt.Sprintf("offset=%d", next))
	return next
}

func (h *harness) post(token, path string, body any) answer {
	h.T.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		h.T.Fatal(err)
	}
	return h.call(http.MethodPost, path, token, string(b))
}

func TestEditMessageAndKeyboard(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	botID, token := h.Bot(h.User("owner"), "editbot")
	user, private := h.started(botID, "lan")
	h.drain(token)

	var menu fullMessage
	h.send(token, private, `"text": "Chọn", "reply_markup": {"inline_keyboard": [[{"text": "A", "callback_data": "a"}]]}`).into(t, &menu)

	var edited fullMessage
	h.post(token, "/bot/v1/messages:edit", map[string]any{"chat_id": private, "seq": menu.Seq, "text": "*Đã chọn* A", "parse_mode": "markdown"}).
		into(t, &edited)
	if edited.Text != "Đã chọn A" || edited.EditDate == 0 || edited.ReplyMarkup == nil || edited.ReplyMarkup.InlineKeyboard[0][0].Text != "A" {
		t.Fatalf("edited = %+v", edited)
	}
	// The keyboard alone: replaced, then removed; neither is an edit.
	var marked fullMessage
	h.post(token, "/bot/v1/messages:editMarkup", map[string]any{"chat_id": private, "seq": menu.Seq,
		"reply_markup": map[string]any{"inline_keyboard": [][]map[string]string{{{"text": "B", "callback_data": "b"}}}}}).into(t, &marked)
	if marked.ReplyMarkup == nil || marked.ReplyMarkup.InlineKeyboard[0][0].CallbackData != "b" || marked.EditDate != edited.EditDate {
		t.Fatalf("markup edit = %+v", marked)
	}
	if _, err := h.Chat.PressInlineButton(ctx, user, &appv1.PressInlineButtonRequest{ChatId: private, Seq: menu.Seq, CallbackData: []byte("b")}); err != nil {
		t.Fatalf("the new button does not work: %v", err)
	}
	var bare fullMessage
	h.post(token, "/bot/v1/messages:editMarkup", map[string]any{"chat_id": private, "seq": menu.Seq}).into(t, &bare)
	if bare.ReplyMarkup != nil {
		t.Fatalf("keyboard not removed: %+v", bare)
	}
	// Refused: a reply keyboard, someone else's message, nothing to edit.
	h.post(token, "/bot/v1/messages:editMarkup", map[string]any{"chat_id": private, "seq": menu.Seq,
		"reply_markup": map[string]any{"keyboard": [][]map[string]string{{{"text": "x"}}}}}).fails(t, http.StatusBadRequest, "bad_request")
	theirs := h.userSends(user, private, "của tôi")
	h.post(token, "/bot/v1/messages:edit", map[string]any{"chat_id": private, "seq": theirs.GetSeq(), "text": "x"}).
		fails(t, http.StatusForbidden, "forbidden")
	h.post(token, "/bot/v1/messages:edit", map[string]any{"chat_id": private, "seq": menu.Seq}).fails(t, http.StatusBadRequest, "bad_request")
	h.post(token, "/bot/v1/messages:edit", map[string]any{"chat_id": private, "seq": 999, "text": "x"}).fails(t, http.StatusNotFound, "not_found")

	// A user's edit reaches the bot as message_edited.
	offset := h.drain(token)
	if _, err := h.Chat.EditMessage(ctx, user, &appv1.EditMessageRequest{ChatId: private, Seq: theirs.GetSeq(), Text: "đã sửa"}); err != nil {
		t.Fatal(err)
	}
	h.CatchUp()
	list := h.updates(token, fmt.Sprintf("offset=%d", offset))
	if len(list) != 1 || list[0].MessageEdited == nil || list[0].MessageEdited.Text != "đã sửa" {
		t.Fatalf("updates = %+v", list)
	}
}

func TestDeleteForwardAndCopy(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "tidybot")
	other := h.User("member")
	group := h.Group(owner, other, botID)
	_, private := h.started(botID, "lan")

	// In privacy mode the bot reposts only what it could receive: a command
	// for it, not a plain message.
	plain := h.userSends(other, group, "tin thường")
	theirs := h.userSends(other, group, "/note tin của member")
	var mine fullMessage
	h.send(token, group, `"text": "tin của bot"`).into(t, &mine)
	h.post(token, "/bot/v1/messages:forward", map[string]any{"from_chat_id": group, "seqs": []int64{plain.GetSeq()}, "chat_id": private}).
		fails(t, http.StatusNotFound, "not_found")
	h.post(token, "/bot/v1/messages:copy", map[string]any{"from_chat_id": group, "seq": plain.GetSeq(), "chat_id": private}).
		fails(t, http.StatusNotFound, "not_found")
	var own fullMessage
	h.post(token, "/bot/v1/messages:copy", map[string]any{"from_chat_id": group, "seq": mine.Seq, "chat_id": private}).into(t, &own)

	// Forward and copy before anything is deleted.
	var forwarded []fullMessage
	h.post(token, "/bot/v1/messages:forward", map[string]any{"from_chat_id": group, "seqs": []int64{theirs.GetSeq()}, "chat_id": private,
		"random_ids": []int64{11}}).into(t, &forwarded)
	if len(forwarded) != 1 || forwarded[0].ForwardFrom == nil || forwarded[0].ForwardFrom.UserID != other || forwarded[0].Chat.ID != private {
		t.Fatalf("forwarded = %+v", forwarded)
	}
	var again []fullMessage
	h.post(token, "/bot/v1/messages:forward", map[string]any{"from_chat_id": group, "seqs": []int64{theirs.GetSeq()}, "chat_id": private,
		"random_ids": []int64{11}}).into(t, &again)
	if len(again) != 1 || again[0].Seq != forwarded[0].Seq {
		t.Fatalf("a retried forward posted again: %+v", again)
	}
	var copied fullMessage
	h.post(token, "/bot/v1/messages:copy", map[string]any{"from_chat_id": group, "seq": theirs.GetSeq(), "chat_id": private,
		"text": "<b>bản sao</b>", "parse_mode": "html"}).into(t, &copied)
	if copied.Text != "bản sao" || copied.ForwardFrom != nil {
		t.Fatalf("copied = %+v", copied)
	}
	h.post(token, "/bot/v1/messages:copy", map[string]any{"from_chat_id": group, "seq": theirs.GetSeq(), "chat_id": private,
		"entities": []any{}, "parse_mode": "html"}).fails(t, http.StatusBadRequest, "bad_request")
	// A chat the bot is not in is not a source.
	elsewhere := h.Group(owner, other)
	hidden := h.userSends(other, elsewhere, "bí mật")
	h.post(token, "/bot/v1/messages:forward", map[string]any{"from_chat_id": elsewhere, "seqs": []int64{hidden.GetSeq()}, "chat_id": private}).
		fails(t, http.StatusNotFound, "not_found")
	h.post(token, "/bot/v1/messages:forward", map[string]any{"from_chat_id": group, "seqs": []int64{theirs.GetSeq()}, "chat_id": private,
		"random_ids": []int64{1, 2}}).fails(t, http.StatusBadRequest, "bad_request")

	// Not an admin: its own message goes, the member's stays.
	h.post(token, "/bot/v1/messages:delete", map[string]any{"chat_id": group, "seqs": []int64{mine.Seq, theirs.GetSeq()}}).into(t, new(bool))
	h.post(token, "/bot/v1/messages:delete", map[string]any{"chat_id": group, "seqs": []int64{theirs.GetSeq()}}).
		fails(t, http.StatusForbidden, "forbidden")
	if _, err := h.Chat.SetAdmin(ctx, owner, group, botID, true); err != nil {
		t.Fatal(err)
	}
	h.post(token, "/bot/v1/messages:delete", map[string]any{"chat_id": group, "seqs": []int64{theirs.GetSeq()}}).into(t, new(bool))
	history, err := h.Chat.GetHistory(ctx, owner, &appv1.GetHistoryRequest{ChatId: group})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range history.GetMessages() {
		if (m.GetSeq() == mine.Seq || m.GetSeq() == theirs.GetSeq()) && !m.GetRecalled() {
			t.Fatalf("message %d not deleted: %v", m.GetSeq(), m)
		}
	}
	h.post(token, "/bot/v1/messages:delete", map[string]any{"chat_id": group, "seqs": []int64{}}).fails(t, http.StatusBadRequest, "bad_request")
}

func TestReactionsPinsAndReactionUpdates(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "likebot")
	user, private := h.started(botID, "lan")
	theirs := h.userSends(user, private, "xin chào")

	h.post(token, "/bot/v1/messages:react", map[string]any{"chat_id": private, "seq": theirs.GetSeq(), "emoji": "👍"}).into(t, new(bool))
	h.post(token, "/bot/v1/messages:react", map[string]any{"chat_id": private, "seq": theirs.GetSeq(), "emoji": "x"}).
		fails(t, http.StatusBadRequest, "bad_request")
	h.post(token, "/bot/v1/messages:react", map[string]any{"chat_id": private, "seq": theirs.GetSeq(), "emoji": ""}).into(t, new(bool))
	// The bot's tier, not the per-person write limit (burst 30), applies.
	for i := range 40 {
		emoji := []string{"👍", "🎉"}[i%2]
		h.post(token, "/bot/v1/messages:react", map[string]any{"chat_id": private, "seq": theirs.GetSeq(), "emoji": emoji}).into(t, new(bool))
	}

	h.post(token, "/bot/v1/messages:pin", map[string]any{"chat_id": private, "seq": theirs.GetSeq()}).into(t, new(bool))
	pinned, err := h.Chat.GetPinnedMessages(ctx, user, &appv1.GetPinnedMessagesRequest{ChatId: private})
	if err != nil || pinned.GetCount() != 1 {
		t.Fatalf("pinned = %v, %v", pinned, err)
	}
	h.post(token, "/bot/v1/messages:unpin", map[string]any{"chat_id": private, "seq": theirs.GetSeq()}).into(t, new(bool))
	// Group members may not pin by default.
	group := h.Group(owner, botID)
	inGroup := h.userSends(owner, group, "ghim?")
	h.post(token, "/bot/v1/messages:pin", map[string]any{"chat_id": group, "seq": inGroup.GetSeq()}).fails(t, http.StatusForbidden, "forbidden")

	// Reactions on the bot's messages are opt-in.
	var mine fullMessage
	h.send(token, private, `"text": "thả tim đi"`).into(t, &mine)
	offset := h.drain(token)
	if _, err := h.Chat.SetReaction(ctx, user, private, mine.Seq, "❤️"); err != nil {
		t.Fatal(err)
	}
	h.CatchUp()
	if list := h.updates(token, fmt.Sprintf("offset=%d", offset)); len(list) != 0 {
		t.Fatalf("reaction delivered without opting in: %+v", list)
	}
	h.updates(token, fmt.Sprintf("offset=%d&allowed_updates=message,reaction", offset))
	if _, err := h.Chat.SetReaction(ctx, user, private, mine.Seq, "👍"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Chat.SetReaction(ctx, user, private, theirs.GetSeq(), "👍"); err != nil { // not the bot's message
		t.Fatal(err)
	}
	h.CatchUp()
	list := h.updates(token, fmt.Sprintf("offset=%d", offset))
	if len(list) != 1 || list[0].Reaction == nil || list[0].Reaction.Emoji != "👍" || list[0].Reaction.User.ID != user ||
		list[0].Reaction.Seq != mine.Seq || list[0].Reaction.Chat.ID != private {
		t.Fatalf("reaction updates = %+v", list)
	}
	h.call(http.MethodGet, "/bot/v1/updates?allowed_updates=nonsense", token, "").fails(t, http.StatusBadRequest, "bad_request")
}

func TestGroupAdministration(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "modbot")
	other := h.User("member")
	group := h.Group(owner, other, botID)
	h.drain(token)

	path := func(rest string) string { return fmt.Sprintf("/bot/v1/chats/%d%s", group, rest) }
	// A plain member: no bans, but it sees the admins and members.
	h.call(http.MethodPost, path(fmt.Sprintf("/members/%d:ban", other)), token, "").fails(t, http.StatusForbidden, "forbidden")
	if _, err := h.Chat.SetAdmin(ctx, owner, group, botID, true); err != nil {
		t.Fatal(err)
	}
	h.CatchUp()
	list := h.updates(token, "timeout=0")
	if len(list) != 1 || list[0].MemberChanged == nil || list[0].MemberChanged.Member.Status != "admin" ||
		list[0].MemberChanged.From == nil || list[0].MemberChanged.From.ID != owner || list[0].MemberChanged.Member.User.ID != botID {
		t.Fatalf("promotion updates = %+v", list)
	}
	var admins []member
	h.call(http.MethodGet, path("/admins"), token, "").into(t, &admins)
	if len(admins) != 2 || admins[0].User.ID != owner || admins[0].Status != "owner" || admins[1].User.ID != botID {
		t.Fatalf("admins = %+v", admins)
	}
	h.call(http.MethodPost, path(fmt.Sprintf("/members/%d:restrict", other)), token, `{"permissions": 1}`).into(t, new(bool))
	var m member
	h.call(http.MethodGet, path(fmt.Sprintf("/members/%d", other)), token, "").into(t, &m)
	if m.Status != "member" || m.Permissions != 1 {
		t.Fatalf("restricted member = %+v", m)
	}
	h.call(http.MethodPost, path(fmt.Sprintf("/members/%d:restrict", other)), token, `{}`).fails(t, http.StatusBadRequest, "bad_request")
	h.call(http.MethodPost, path(fmt.Sprintf("/members/%d:ban", other)), token, "").into(t, new(bool))
	h.call(http.MethodGet, path(fmt.Sprintf("/members/%d", other)), token, "").into(t, &m)
	if m.Status != "banned" || m.Permissions != 0 {
		t.Fatalf("banned member = %+v", m)
	}
	h.call(http.MethodPost, path(fmt.Sprintf("/members/%d:unban", other)), token, "").into(t, new(bool))
	h.call(http.MethodGet, path(fmt.Sprintf("/members/%d", other)), token, "").into(t, &m)
	if m.Status != "left" {
		t.Fatalf("unbanned member = %+v", m)
	}
	h.call(http.MethodPost, path(fmt.Sprintf("/members/%d:unban", other)), token, "").fails(t, http.StatusNotFound, "not_found")
	h.call(http.MethodPost, path(fmt.Sprintf("/members/%d:kick", other)), token, "").fails(t, http.StatusNotFound, "not_found")
	h.call(http.MethodGet, path("/members/424242"), token, "").fails(t, http.StatusNotFound, "not_found")

	var info struct {
		Title string `json:"title"`
		About string `json:"about"`
	}
	h.call(http.MethodPatch, path(""), token, `{"title": "Nhóm vận hành", "about": "Trực ca"}`).into(t, &info)
	if info.Title != "Nhóm vận hành" || info.About != "Trực ca" {
		t.Fatalf("chat = %+v", info)
	}
	h.call(http.MethodPatch, path(""), token, `{}`).fails(t, http.StatusBadRequest, "bad_request")

	// Chat actions reach the realtime gateway.
	h.call(http.MethodPost, path("/actions"), token, `{"action": "typing"}`).into(t, new(bool))
	h.call(http.MethodPost, path("/actions"), token, `{"action": "upload_photo"}`).into(t, new(bool))
	h.call(http.MethodPost, path("/actions"), token, `{"action": "dancing"}`).fails(t, http.StatusBadRequest, "bad_request")
	got := h.typer.list()
	if len(got) != 2 || got[0] != fmt.Sprintf("%d:%d:0:TYPING_ACTION_TYPING", botID, group) || !strings.HasSuffix(got[1], "UPLOADING_PHOTO") {
		t.Fatalf("relayed actions = %v", got)
	}
	stranger := h.Group(owner, other)
	h.call(http.MethodPost, fmt.Sprintf("/bot/v1/chats/%d/actions", stranger), token, `{"action": "typing"}`).
		fails(t, http.StatusNotFound, "not_found")

	// Leaving: the bot is told, and the chat is gone for it.
	offset := h.drain(token)
	h.call(http.MethodPost, path(":leave"), token, "").into(t, new(bool))
	h.call(http.MethodPost, path(":stay"), token, "").fails(t, http.StatusNotFound, "not_found")
	h.CatchUp()
	list = h.updates(token, fmt.Sprintf("offset=%d", offset))
	if n := len(list); n == 0 || list[n-1].MemberChanged == nil || list[n-1].MemberChanged.Member.Status != "left" {
		t.Fatalf("after leaving = %+v", list)
	}
	// A former member is refused.
	h.call(http.MethodGet, path("/admins"), token, "").fails(t, http.StatusForbidden, "forbidden")
}

func TestChannelPostReachesAdminBot(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, token := h.Bot(owner, "newsbot")
	ch, err := h.Chat.CreateChannel(ctx, owner, "Tin tức", "")
	if err != nil {
		t.Fatal(err)
	}
	channel := ch.GetChat().GetId()
	if _, err := h.Chat.AddMembers(ctx, owner, channel, []int64{botID}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Chat.SetAdmin(ctx, owner, channel, botID, true); err != nil {
		t.Fatal(err)
	}
	offset := h.drain(token)
	if _, err := h.Chat.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: channel, Text: "Bản tin sáng"}); err != nil {
		t.Fatal(err)
	}
	h.CatchUp()
	var list []map[string]json.RawMessage
	h.call(http.MethodGet, fmt.Sprintf("/bot/v1/updates?offset=%d", offset), token, "").into(t, &list)
	if len(list) != 1 || list[0]["channel_post"] == nil {
		t.Fatalf("updates = %v", list)
	}
}

// --------------------------------------------------------------- files

func pngBytes(t *testing.T, side int, shade uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, side, side))
	for x := range side {
		for y := range side {
			img.Set(x, y, color.RGBA{R: shade, G: uint8(x), B: uint8(y), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type upload struct {
	name, filename string
	data           []byte
}

// multipartCall posts a multipart/form-data body.
func (h *harness) multipartCall(path, token string, fields map[string]string, files ...upload) answer {
	h.T.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			h.T.Fatal(err)
		}
	}
	for _, f := range files {
		part, err := w.CreateFormFile(f.name, f.filename)
		if err != nil {
			h.T.Fatal(err)
		}
		if _, err := part.Write(f.data); err != nil {
			h.T.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		h.T.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "https://"+bottest.Host+path, &body)
	req.RemoteAddr = "192.0.2.1:4000"
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	h.api.ServeHTTP(rec, req)
	h.checkContract(http.MethodPost, path, rec.Code, rec.Body.Bytes())
	var a answer
	if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil {
		h.T.Fatalf("%s: not an envelope: %q", path, rec.Body.String())
	}
	a.status = rec.Code
	return a
}

func TestSendFilesAndGetFile(t *testing.T) {
	h := newHarnessWith(t, bottest.Options{Media: true})
	botID, token := h.Bot(h.User("owner"), "photobot")
	user, private := h.started(botID, "lan")

	var photo fullMessage
	h.multipartCall("/bot/v1/messages:sendMedia", token, map[string]string{
		"chat_id": fmt.Sprint(private), "kind": "photo", "text": "*Ảnh* mới", "parse_mode": "markdown", "random_id": "5",
	}, upload{"file", "anh.png", pngBytes(t, 64, 10)}).into(t, &photo)
	if photo.Media == nil || photo.Media.Kind != "photo" || photo.Media.FileID == "" || photo.Media.Width != 64 || photo.Text != "Ảnh mới" {
		t.Fatalf("photo = %+v", photo)
	}
	// The user sees it like any photo.
	history, err := h.Chat.GetHistory(context.Background(), user, &appv1.GetHistoryRequest{ChatId: private, Limit: 1})
	if err != nil || history.GetMessages()[0].GetMedia().GetFileId() != photo.Media.FileID {
		t.Fatalf("history = %v, %v", history, err)
	}
	var file struct {
		FileID     string `json:"file_id"`
		Kind       string `json:"kind"`
		Size       int64  `json:"size"`
		URL        string `json:"url"`
		URLExpires int64  `json:"url_expires"`
	}
	h.call(http.MethodGet, "/bot/v1/files/"+photo.Media.FileID, token, "").into(t, &file)
	if file.FileID != photo.Media.FileID || file.Kind != "photo" || file.Size == 0 || !strings.HasPrefix(file.URL, "https://media.example.test/f/") || file.URLExpires == 0 {
		t.Fatalf("file = %+v", file)
	}
	h.call(http.MethodGet, "/bot/v1/files/AAAAAAAAAAAAAAAAAAAAAA", token, "").fails(t, http.StatusNotFound, "not_found")
	h.call(http.MethodGet, "/bot/v1/files/short", token, "").fails(t, http.StatusNotFound, "not_found")
	// Another bot that cannot see the message cannot read the file.
	_, otherToken := h.Bot(h.User("owner2"), "otherbot")
	h.call(http.MethodGet, "/bot/v1/files/"+photo.Media.FileID, otherToken, "").fails(t, http.StatusNotFound, "not_found")

	// Again by file_id (JSON), and refused uploads.
	var resent fullMessage
	h.post(token, "/bot/v1/messages:sendMedia", map[string]any{"chat_id": private, "file_id": photo.Media.FileID}).into(t, &resent)
	if resent.Media == nil || resent.Media.FileID != photo.Media.FileID {
		t.Fatalf("resent = %+v", resent)
	}
	h.multipartCall("/bot/v1/messages:sendMedia", token, map[string]string{"chat_id": fmt.Sprint(private), "kind": "photo"},
		upload{"file", "note.txt", []byte("not an image")}).fails(t, http.StatusBadRequest, "bad_request")
	h.multipartCall("/bot/v1/messages:sendMedia", token, map[string]string{"chat_id": fmt.Sprint(private), "kind": "photo"}).
		fails(t, http.StatusBadRequest, "bad_request")
	h.multipartCall("/bot/v1/messages:sendMedia", token, map[string]string{"chat_id": fmt.Sprint(private), "kind": "photo", "bogus": "1"},
		upload{"file", "a.png", pngBytes(t, 8, 1)}).fails(t, http.StatusBadRequest, "bad_request")
	h.post(token, "/bot/v1/messages:sendMedia", map[string]any{"chat_id": private, "file_id": photo.Media.FileID, "kind": "photo"}).
		fails(t, http.StatusBadRequest, "bad_request")
	// A user who never started the bot gets nothing stored or sent.
	stranger := h.privateWith(h.User("stranger"), botID)
	h.multipartCall("/bot/v1/messages:sendMedia", token, map[string]string{"chat_id": fmt.Sprint(stranger), "kind": "document"},
		upload{"file", "a.pdf", []byte("%PDF-1.4 x")}).fails(t, http.StatusForbidden, "no_consent")

	// An album: two uploads and a file_id.
	var album []fullMessage
	h.multipartCall("/bot/v1/messages:sendAlbum", token, map[string]string{
		"chat_id": fmt.Sprint(private),
		"items": fmt.Sprintf(`[{"attach": "p1", "kind": "photo", "text": "một"}, {"attach": "p2", "kind": "photo"}, {"file_id": %q}]`,
			photo.Media.FileID),
	}, upload{"p1", "1.png", pngBytes(t, 16, 20)}, upload{"p2", "2.png", pngBytes(t, 16, 30)}).into(t, &album)
	if len(album) != 3 || album[0].GroupedID == 0 || album[1].GroupedID != album[0].GroupedID || album[0].Text != "một" {
		t.Fatalf("album = %+v", album)
	}
	h.multipartCall("/bot/v1/messages:sendAlbum", token, map[string]string{
		"chat_id": fmt.Sprint(private), "items": `[{"attach": "p1", "kind": "photo"}, {"file_id": "` + photo.Media.FileID + `"}]`,
	}, upload{"p1", "1.png", pngBytes(t, 16, 20)}, upload{"extra", "x.png", pngBytes(t, 8, 2)}).fails(t, http.StatusBadRequest, "bad_request")
	h.post(token, "/bot/v1/messages:sendAlbum", map[string]any{"chat_id": private, "items": []map[string]any{{"file_id": photo.Media.FileID}}}).
		fails(t, http.StatusBadRequest, "bad_request")
	var byID []fullMessage
	h.post(token, "/bot/v1/messages:sendAlbum", map[string]any{"chat_id": private,
		"items": []map[string]any{{"file_id": photo.Media.FileID}, {"file_id": album[1].Media.FileID}}}).into(t, &byID)
	if len(byID) != 2 {
		t.Fatalf("album by file_id = %+v", byID)
	}
}

func TestFilesWithoutMediaStorage(t *testing.T) {
	h := newHarness(t)
	botID, token := h.Bot(h.User("owner"), "nomediabot")
	_, private := h.started(botID, "lan")
	h.multipartCall("/bot/v1/messages:sendMedia", token, map[string]string{"chat_id": fmt.Sprint(private), "kind": "photo"},
		upload{"file", "a.png", pngBytes(t, 8, 1)}).fails(t, http.StatusBadRequest, "bad_request")
	h.call(http.MethodGet, "/bot/v1/files/AAAAAAAAAAAAAAAAAAAAAA", token, "").fails(t, http.StatusBadRequest, "bad_request")
}

// The group command menu of the composer (BotsService.GetChatBotCommands):
// the bots in a group with their GROUP lists, GROUP_ADMIN for admins.
func TestGroupCommandMenus(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	member := h.User("member")
	deployID, deploy := h.Bot(owner, "deploy_bot")
	oncallID, oncall := h.Bot(owner, "oncall_bot")
	quietID, _ := h.Bot(owner, "quiet_bot")
	group := h.Group(owner, member, deployID, oncallID, quietID)
	h.call(http.MethodPut, "/bot/v1/commands", deploy, `{"scope": "group", "commands": [{"command": "status", "description": "Trạng thái"}]}`).into(t, new(bool))
	h.call(http.MethodPut, "/bot/v1/commands", deploy, `{"scope": "group_admin", "commands": [{"command": "rollback", "description": "Quay lại"}]}`).into(t, new(bool))
	h.call(http.MethodPut, "/bot/v1/commands", oncall, `{"commands": [{"command": "ca", "description": "Ai trực"}]}`).into(t, new(bool))

	menus := func(user int64) string {
		t.Helper()
		ids, admin, err := h.Chat.ChatBots(ctx, user, group)
		if err != nil {
			t.Fatal(err)
		}
		role := botadmin.RoleGroupMember
		if admin {
			role = botadmin.RoleGroupAdmin
		}
		list, err := h.Admin.Menus(ctx, ids, role)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, m := range list {
			for _, c := range m.GetCommands() {
				out = append(out, m.GetBot().GetUsername()+"/"+c.GetCommand())
			}
		}
		return strings.Join(out, " ")
	}
	if got := menus(member); got != "deploy_bot/status oncall_bot/ca" {
		t.Fatalf("member menu = %q", got)
	}
	if got := menus(owner); got != "deploy_bot/rollback oncall_bot/ca" {
		t.Fatalf("admin menu = %q", got)
	}
	// A private chat has no group menu; a stranger gets nothing.
	_, private := h.started(deployID, "lan")
	if ids, _, err := h.Chat.ChatBots(ctx, owner, private); err == nil && len(ids) != 0 {
		t.Fatalf("private chat bots = %v", ids)
	}
	if _, _, err := h.Chat.ChatBots(ctx, h.User("stranger"), group); err == nil {
		t.Fatal("a stranger read the group's bots")
	}
}

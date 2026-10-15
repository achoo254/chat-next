package chat

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/search"
	"app.local/server/internal/vifold"
	"connectrpc.com/connect"
)

// found runs a global search and returns the texts of the first page.
func (h *harness) found(me int64, query string) []string {
	h.t.Helper()
	resp, err := h.svc.SearchMessages(context.Background(), me, &appv1.SearchMessagesRequest{Query: query, Limit: 50})
	if err != nil {
		h.t.Fatalf("SearchMessages(%q): %v", query, err)
	}
	var out []string
	for _, m := range resp.GetMessages() {
		out = append(out, m.GetText())
	}
	return out
}

func (h *harness) foundIn(me, chatID int64, query string, filter *appv1.SearchFilter) []string {
	h.t.Helper()
	resp, err := h.svc.SearchChatMessages(context.Background(), me, &appv1.SearchChatMessagesRequest{ChatId: chatID, Query: query, Filter: filter, Limit: 50})
	if err != nil {
		h.t.Fatalf("SearchChatMessages(%q): %v", query, err)
	}
	var out []string
	for _, m := range resp.GetMessages() {
		out = append(out, m.GetText())
	}
	return out
}

func TestSearchIgnoresAccentsAndMatchesWordStarts(t *testing.T) {
	h := newHarness(t, nil)
	alice, bob := h.user("alice"), h.user("bob")
	chatID := h.group(alice, bob)
	h.send(alice, chatID, "Người đẹp Đà Nẵng")
	h.send(alice, chatID, "Ưu đãi tháng 10: giảm 1.250.000₫")

	for _, q := range []string{"nguoi dep da nang", "Người đẹp", "NGUOI DEP", "da nan", "dep  da", "Đà Nẵ"} {
		if got := h.found(bob, q); !slices.Equal(got, []string{"Người đẹp Đà Nẵng"}) {
			t.Errorf("%q found %q", q, got)
		}
	}
	if got := h.found(bob, "uu dai 1.250.000"); len(got) != 1 {
		t.Errorf("number token: %q", got)
	}
	// Inside a word, or words of different messages, match nothing.
	for _, q := range []string{"guoi", "nang uu", "dep thang"} {
		if got := h.found(bob, q); len(got) != 0 {
			t.Errorf("%q found %q", q, got)
		}
	}
	// Nothing to match and no filter: no results, no error.
	if got := h.found(bob, "  ?! "); len(got) != 0 {
		t.Errorf("punctuation found %q", got)
	}
}

func TestSearchVisibility(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	alice, bob, carol, dave := h.user("alice"), h.user("bob"), h.user("carol"), h.user("dave")
	chatID := h.group(alice, bob)
	if _, err := h.svc.SetHistoryVisibility(ctx, alice, chatID, appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN); err != nil {
		t.Fatal(err)
	}
	h.send(alice, chatID, "kế hoạch quý một")
	hidden := h.send(alice, chatID, "kế hoạch bí mật").GetMessage().GetSeq()
	recalled := h.send(alice, chatID, "kế hoạch thu hồi").GetMessage().GetSeq()

	// A non-member finds nothing and may not search the chat.
	if got := h.found(carol, "ke hoach"); len(got) != 0 {
		t.Fatalf("non-member found %q", got)
	}
	if _, err := h.svc.SearchChatMessages(ctx, carol, &appv1.SearchChatMessagesRequest{ChatId: chatID, Query: "ke hoach"}); err == nil {
		t.Fatal("non-member searched the chat")
	}

	// Hidden for bob: gone for bob only. Recalled: gone for everyone.
	if _, err := h.svc.DeleteMessages(ctx, bob, chatID, []int64{hidden}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.DeleteMessages(ctx, alice, chatID, []int64{recalled}, true); err != nil {
		t.Fatal(err)
	}
	if got := h.found(bob, "ke hoach"); !slices.Equal(got, []string{"kế hoạch quý một"}) {
		t.Fatalf("bob found %q", got)
	}
	if got := h.found(alice, "ke hoach"); !slices.Equal(got, []string{"kế hoạch bí mật", "kế hoạch quý một"}) {
		t.Fatalf("alice found %q", got)
	}
	if got := h.found(alice, "thu hoi"); len(got) != 0 {
		t.Fatalf("recalled message found: %q", got)
	}

	// A member who joined later (history since join) finds only newer ones.
	if _, err := h.svc.AddMembers(ctx, alice, chatID, []int64{dave}); err != nil {
		t.Fatal(err)
	}
	h.send(alice, chatID, "kế hoạch quý hai")
	if got := h.found(dave, "ke hoach"); !slices.Equal(got, []string{"kế hoạch quý hai"}) {
		t.Fatalf("late member found %q", got)
	}

	// After leaving, nothing of the chat is found.
	if _, err := h.svc.LeaveChat(ctx, bob, chatID, 0); err != nil {
		t.Fatal(err)
	}
	if got := h.found(bob, "ke hoach"); len(got) != 0 {
		t.Fatalf("former member found %q", got)
	}

	// Another tenant's chat, or a secret chat, is never searched.
	if err := h.st.EnsureTenant(ctx, "other", "other.test", "other.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET tenant_id = 'other' WHERE id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	if got := h.found(alice, "ke hoach"); len(got) != 0 {
		t.Fatalf("other tenant's chat searched: %q", got)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET tenant_id = $2, type = 'secret' WHERE id = $1`, chatID, testTenant); err != nil {
		t.Fatal(err)
	}
	if got := h.found(alice, "ke hoach"); len(got) != 0 {
		t.Fatalf("secret chat searched: %q", got)
	}
}

func TestSearchFindsHiddenTopicsAndEdits(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	alice, bob := h.user("alice"), h.user("bob")
	resp, err := h.svc.CreateGroup(ctx, alice, "forum", []int64{bob}, true)
	if err != nil {
		t.Fatal(err)
	}
	chatID := resp.GetChat().GetId()
	topic, _, err := h.svc.CreateForumTopic(ctx, alice, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "Lưu trữ"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendMessage(ctx, alice, &appv1.SendMessageRequest{ChatId: chatID, TopicId: topic.GetId(), Text: "Biên bản họp"}); err != nil {
		t.Fatal(err)
	}
	general := h.send(alice, chatID, "Bien ban cu").GetMessage().GetSeq()
	if _, _, err := h.svc.HideForumTopic(ctx, alice, chatID, topic.GetId(), true); err != nil {
		t.Fatal(err)
	}
	// A hidden topic only leaves the topic list.
	if got := h.found(bob, "bien ban hop"); !slices.Equal(got, []string{"Biên bản họp"}) {
		t.Fatalf("hidden topic: %q", got)
	}
	// Topic filter of the in-chat search.
	topicResp, err := h.svc.SearchChatMessages(ctx, bob, &appv1.SearchChatMessagesRequest{ChatId: chatID, TopicId: topic.GetId(), Query: "bien ban"})
	if err != nil || len(topicResp.GetMessages()) != 1 || topicResp.GetMessages()[0].GetTopicId() != topic.GetId() {
		t.Fatalf("topic search = %v, %v", topicResp, err)
	}

	// An edit re-indexes the message in the same transaction.
	if _, err := h.svc.EditMessage(ctx, alice, &appv1.EditMessageRequest{ChatId: chatID, Seq: general, Text: "Lịch trực tuần này"}); err != nil {
		t.Fatal(err)
	}
	if got := h.found(bob, "bien ban cu"); len(got) != 0 {
		t.Fatalf("old text still found: %q", got)
	}
	if got := h.found(bob, "lich truc"); !slices.Equal(got, []string{"Lịch trực tuần này"}) {
		t.Fatalf("edited text: %q", got)
	}
}

func TestSearchRanksExactAccentsFirst(t *testing.T) {
	h := newHarness(t, nil)
	alice, bob := h.user("alice"), h.user("bob")
	chatID := h.group(alice, bob)
	for _, text := range []string{"Má ơi con về", "mã nguồn mới", "ma trận lỗi", "Mạ lúa xanh", "MÁ gọi rồi", "mà thôi"} {
		h.send(alice, chatID, text)
	}
	// Exact accents first, newest first within each group.
	want := []string{"MÁ gọi rồi", "Má ơi con về", "mà thôi", "Mạ lúa xanh", "ma trận lỗi", "mã nguồn mới"}
	if got := h.found(bob, "má"); !slices.Equal(got, want) {
		t.Fatalf("má:\n got %q\nwant %q", got, want)
	}
	// Without accents: newest first only.
	want = []string{"mà thôi", "MÁ gọi rồi", "Mạ lúa xanh", "ma trận lỗi", "mã nguồn mới", "Má ơi con về"}
	if got := h.found(bob, "ma"); !slices.Equal(got, want) {
		t.Fatalf("ma:\n got %q\nwant %q", got, want)
	}
	// In-chat search keeps date order even for an accented query.
	if got := h.foundIn(bob, chatID, "má", nil); !slices.Equal(got, want) {
		t.Fatalf("in-chat má: %q", got)
	}
}

// pages walks every page of a search and returns the texts in order.
func pages(t *testing.T, h *harness, me int64, query string, limit int32) []string {
	t.Helper()
	var out []string
	cursor := ""
	for i := 0; ; i++ {
		resp, err := h.svc.SearchMessages(context.Background(), me, &appv1.SearchMessagesRequest{Query: query, Cursor: cursor, Limit: limit})
		if err != nil {
			t.Fatal(err)
		}
		if resp.GetNextCursor() != "" && len(resp.GetMessages()) != int(limit) {
			t.Fatalf("page %d holds %d of %d but is not the last", i, len(resp.GetMessages()), limit)
		}
		for _, m := range resp.GetMessages() {
			out = append(out, m.GetText())
		}
		cursor = resp.GetNextCursor()
		if cursor == "" {
			return out
		}
		if i > 100 {
			t.Fatal("cursor never ends")
		}
	}
}

func TestSearchCursorPagesWithoutRepeats(t *testing.T) {
	h := newHarness(t, nil)
	alice, bob := h.user("alice"), h.user("bob")
	g1, g2 := h.group(alice, bob), h.group(alice, bob)
	var exact, other []string
	for i := range 11 {
		chatID := g1
		if i%2 == 1 {
			chatID = g2
		}
		text := fmt.Sprintf("báo cáo số %d", i)
		if i%3 == 0 {
			text = fmt.Sprintf("bao cao so %d", i)
			other = append([]string{text}, other...)
		} else {
			exact = append([]string{text}, exact...)
		}
		h.send(alice, chatID, text)
	}
	whole := pages(t, h, bob, "báo cáo", 50)
	if want := append(slices.Clone(exact), other...); !slices.Equal(whole, want) {
		t.Fatalf("one page:\n got %q\nwant %q", whole, want)
	}
	for _, limit := range []int32{1, 2, 3, 4, 7, 8} {
		if got := pages(t, h, bob, "báo cáo", limit); !slices.Equal(got, whole) {
			t.Fatalf("limit %d:\n got %q\nwant %q", limit, got, whole)
		}
		if got, want := pages(t, h, bob, "bao cao", limit), pages(t, h, bob, "bao cao", 50); !slices.Equal(got, want) || len(got) != 11 {
			t.Fatalf("unaccented limit %d: %q", limit, got)
		}
	}

	// A cursor only continues its own search.
	resp, err := h.svc.SearchMessages(context.Background(), bob, &appv1.SearchMessagesRequest{Query: "báo cáo", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.SearchMessages(context.Background(), bob, &appv1.SearchMessagesRequest{Query: "bao", Cursor: resp.GetNextCursor()})
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("foreign cursor: %v", err)
	}
	_, err = h.svc.SearchMessages(context.Background(), bob, &appv1.SearchMessagesRequest{Query: "bao", Cursor: "not-a-cursor"})
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("garbage cursor: %v", err)
	}
}

func TestSearchFilters(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	alice, bob := h.user("alice"), h.user("bob")
	chatID := h.group(alice, bob)
	h.send(alice, chatID, "thiết kế màn đăng nhập")
	h.send(bob, chatID, "thiết kế xem ở https://example.test/design")
	photo := h.send(alice, chatID, "thiết kế icon").GetMessage().GetSeq()
	// A photo message as SendMedia stores it (media needs storage here).
	if _, err := h.st.Pool().Exec(ctx, `UPDATE messages SET media_kind = $3 WHERE chat_id = $1 AND seq = $2`,
		chatID, photo, int16(appv1.MediaKind_MEDIA_KIND_PHOTO)); err != nil {
		t.Fatal(err)
	}
	if got := h.foundIn(alice, chatID, "thiet ke", &appv1.SearchFilter{FromId: bob}); !slices.Equal(got, []string{"thiết kế xem ở https://example.test/design"}) {
		t.Fatalf("from bob: %q", got)
	}
	if got := h.foundIn(alice, chatID, "thiet ke", &appv1.SearchFilter{HasLink: true}); len(got) != 1 || got[0] != "thiết kế xem ở https://example.test/design" {
		t.Fatalf("links: %q", got)
	}
	// A filter alone (no words) lists the matching messages.
	if got := h.foundIn(alice, chatID, "", &appv1.SearchFilter{MediaKind: appv1.MediaKind_MEDIA_KIND_PHOTO}); !slices.Equal(got, []string{"thiết kế icon"}) {
		t.Fatalf("photos: %q", got)
	}
	now := time.Now().Unix()
	if got := h.foundIn(alice, chatID, "thiet ke", &appv1.SearchFilter{MinDate: now - 60, MaxDate: now + 60}); len(got) != 3 {
		t.Fatalf("date range: %q", got)
	}
	if got := h.foundIn(alice, chatID, "thiet ke", &appv1.SearchFilter{MaxDate: now - 3600}); len(got) != 0 {
		t.Fatalf("before the range: %q", got)
	}
	for _, f := range []*appv1.SearchFilter{{MinDate: now, MaxDate: now - 1}, {FromId: -1}, {MediaKind: 99}} {
		if _, err := h.svc.SearchMessages(ctx, alice, &appv1.SearchMessagesRequest{Query: "x", Filter: f}); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("filter %v: %v", f, err)
		}
	}
}

func TestSearchResponseCarriesSendersAndChats(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	alice, bob := h.user("alice"), h.user("bob")
	chat, _, err := h.svc.CreatePrivate(ctx, alice, bob)
	if err != nil {
		t.Fatal(err)
	}
	h.send(bob, chat.GetId(), "Lịch trực tuần này")
	h.send(alice, chat.GetId(), "Lịch trực tuần sau")
	resp, err := h.svc.SearchMessages(ctx, alice, &appv1.SearchMessagesRequest{Query: "lich truc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.GetMessages()) != 2 || len(resp.GetChats()) != 1 || resp.GetChats()[0].GetPeerUserId() != bob {
		t.Fatalf("response = %v", resp)
	}
	users := map[int64]bool{}
	for _, u := range resp.GetUsers() {
		users[u.GetId()] = true
	}
	if !users[bob] {
		t.Fatalf("users = %v", resp.GetUsers())
	}
}

func TestSearchBackfillIndexesOldRows(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	alice, bob := h.user("alice"), h.user("bob")
	chatID := h.group(alice, bob)
	h.send(alice, chatID, "Đi ăn trưa không")
	gone := h.send(alice, chatID, "tin đã thu hồi").GetMessage().GetSeq()
	if _, err := h.svc.DeleteMessages(ctx, alice, chatID, []int64{gone}, true); err != nil {
		t.Fatal(err)
	}
	// As rows written before the migration (or by the previous binary).
	if _, err := h.st.Pool().Exec(ctx, `UPDATE messages SET search_tsv = NULL WHERE chat_id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	if got := h.found(bob, "di an trua"); len(got) != 0 {
		t.Fatalf("unindexed row found: %q", got)
	}
	n, err := search.Backfill(ctx, h.st.Pool(), quiet)
	if err != nil || n < 3 {
		t.Fatalf("backfill = %d, %v", n, err)
	}
	if got := h.found(bob, "di an trua"); !slices.Equal(got, []string{"Đi ăn trưa không"}) {
		t.Fatalf("after backfill: %q", got)
	}
	var empty int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM messages WHERE chat_id = $1 AND search_tsv IS NULL`, chatID).Scan(&empty); err != nil || empty != 0 {
		t.Fatalf("rows left unindexed: %d, %v", empty, err)
	}
	if n, err := search.Backfill(ctx, h.st.Pool(), quiet); err != nil || n != 0 {
		t.Fatalf("second backfill = %d, %v", n, err)
	}
}

func TestSearchUsersIgnoresAccents(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me := h.user("me")
	dat := h.user("dattqh")
	if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET name = 'Đạt Trịnh Quốc Hoàn' WHERE id = $1`, dat); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"dat trinh", "Đạt", "QUOC HOAN", "trịnh"} {
		users, err := h.svc.SearchUsers(ctx, me, q, 10)
		if err != nil || len(users) != 1 || users[0].GetId() != dat {
			t.Fatalf("SearchUsers(%q) = %v, %v", q, users, err)
		}
	}
	// chat_fold_name matches vifold for every Vietnamese letter, in both cases
	// and in decomposed form.
	letters := "aàáạảãâầấậẩẫăằắặẳẵeèéẹẻẽêềếệểễiìíịỉĩoòóọỏõôồốộổỗơờớợởỡuùúụủũưừứựửữyỳýỵỷỹdđ"
	for _, r := range letters {
		for _, s := range []string{string(r), strings.ToUpper(string(r))} {
			var composed, decomposed string
			if err := h.st.Pool().QueryRow(ctx, `SELECT chat_fold_name($1), chat_fold_name(normalize($1, NFD))`, s).Scan(&composed, &decomposed); err != nil {
				t.Fatal(err)
			}
			if want := vifold.Fold(s); composed != want || decomposed != want {
				t.Errorf("chat_fold_name(%q) = %q, decomposed %q, want %q", s, composed, decomposed, want)
			}
		}
	}
}

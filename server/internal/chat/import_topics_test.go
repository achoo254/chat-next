package chat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
)

// forumCopy makes a forum chat for an imported conversation of owner, linked to
// a new external account, and returns its chat id.
func (h *harness) forumCopy(owner int64) int64 {
	h.t.Helper()
	ctx := context.Background()
	var accountID int64
	if err := h.st.Pool().QueryRow(ctx, `
		INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', $2, '\x00') RETURNING id`, owner, fmt.Sprintf("tg-forum-%d", owner)).Scan(&accountID); err != nil {
		h.t.Fatal(err)
	}
	chatID, err := h.svc.CreateImportedChat(ctx, owner, ImportedChat{Kind: "group", Title: "Diễn đàn", Forum: true}, func(tx pgx.Tx, chatID int64) error {
		_, err := tx.Exec(ctx, `INSERT INTO external_chats (account_id, external_chat_id, chat_id, direction) VALUES ($1, 'channel:1', $2, 'in')`, accountID, chatID)
		return err
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return chatID
}

func (h *harness) topicOfMessage(chatID, seq int64) int64 {
	h.t.Helper()
	var id int64
	if err := h.st.Pool().QueryRow(context.Background(), `SELECT topic_id FROM messages WHERE chat_id = $1 AND seq = $2`, chatID, seq).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func TestImportedForumStartsWithGeneralAndMessagesLandInTheirTopics(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.forumCopy(owner)
	var forum bool
	var topics int
	if err := h.st.Pool().QueryRow(ctx, `SELECT forum, (SELECT count(*) FROM forum_topics WHERE chat_id = $1) FROM chats WHERE id = $1`, chatID).Scan(&forum, &topics); err != nil || !forum || topics != 1 {
		t.Fatalf("forum=%v topics=%d (%v), want a forum with only the General topic", forum, topics, err)
	}
	opened := time.Now().Add(-72 * time.Hour).Truncate(time.Second)
	var infra int64
	var seqs []int64
	err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		if infra, err = it.CreateTopic(ctx, TopicImport{Title: "Hạ tầng", IconColor: 0x6FB9F0, Created: opened}); err != nil {
			return err
		}
		seqs, err = it.Append(ctx, []ImportMessage{
			{FromID: owner, Date: opened, Text: "vào topic", TopicID: infra},
			{FromID: owner, Date: opened.Add(time.Hour), Text: "vào General"},
			{FromID: owner, Date: opened.Add(2 * time.Hour), Text: "lại vào topic", TopicID: infra},
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if infra != 2 {
		t.Fatalf("the first topic opened gets id %d, want 2 (General is 1)", infra)
	}
	if got := []int64{h.topicOfMessage(chatID, seqs[0]), h.topicOfMessage(chatID, seqs[1]), h.topicOfMessage(chatID, seqs[2])}; got[0] != infra || got[1] != generalTopicID || got[2] != infra {
		t.Fatalf("topics of the messages = %v, want [%d %d %d]", got, infra, generalTopicID, infra)
	}
	var title string
	var color int
	var created time.Time
	var count int
	var top int64
	if err := h.st.Pool().QueryRow(ctx, `SELECT title, icon_color, created_at, message_count, top_seq FROM forum_topics WHERE chat_id = $1 AND id = $2`, chatID, infra).Scan(&title, &color, &created, &count, &top); err != nil {
		t.Fatal(err)
	}
	if title != "Hạ tầng" || color != 0x6FB9F0 || !created.Equal(opened) || count != 2 || top != seqs[2] {
		t.Fatalf("topic = %q %x created %v count %d top %d; want the title, colour, original date, 2 messages and the newest as top", title, color, created, count, top)
	}
	told := false
	for _, u := range h.logOf(owner) {
		if u.GetTopicChanged() != nil && u.GetTopicChanged().GetTopic().GetTitle() == "Hạ tầng" {
			told = true
		}
	}
	if !told {
		t.Fatal("opening a topic did not reach the owner's updates")
	}
}

func TestUpdateTopicAppliesNameClosedAndPinnedAndSaysWhenNothingChanged(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.forumCopy(owner)
	var id int64
	update := func(ti TopicImport) (changed bool, err error) {
		err = h.importInto(chatID, owner, func(it *ImportTx) error {
			var e error
			changed, e = it.UpdateTopic(ctx, id, ti)
			return e
		})
		return
	}
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		id, err = it.CreateTopic(ctx, TopicImport{Title: "Cũ", IconColor: 0x6FB9F0})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if changed, err := update(TopicImport{Title: "Cũ", IconColor: 0x6FB9F0}); err != nil || changed {
		t.Fatalf("the same values = changed %v, %v; want no change and nothing sent", changed, err)
	}
	before := len(h.logOf(owner))
	if changed, err := update(TopicImport{Title: "Mới", IconColor: 0xFF93B2, Closed: true, Pinned: true}); err != nil || !changed {
		t.Fatalf("new values = changed %v, %v", changed, err)
	}
	if after := len(h.logOf(owner)); after != before+1 {
		t.Fatalf("updates went from %d to %d, want one topic update", before, after)
	}
	var title string
	var closed, pinned bool
	if err := h.st.Pool().QueryRow(ctx, `SELECT title, closed, pinned FROM forum_topics WHERE chat_id = $1 AND id = $2`, chatID, id).Scan(&title, &closed, &pinned); err != nil || title != "Mới" || !closed || !pinned {
		t.Fatalf("topic = %q closed %v pinned %v (%v)", title, closed, pinned, err)
	}
	id = 99
	if _, err := update(TopicImport{Title: "x"}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("a topic that does not exist = %v, want NotFound", err)
	}
}

func TestImportedTopicTitlesAndColoursAreFittedNotRefused(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.forumCopy(owner)
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		a, err := it.CreateTopic(ctx, TopicImport{Title: "   ", IconColor: -5, Created: time.Now().Add(48 * time.Hour)})
		if err != nil {
			return err
		}
		b, err := it.CreateTopic(ctx, TopicImport{Title: strings.Repeat("ế", 500), IconColor: 0x1000000})
		if err != nil {
			return err
		}
		if a != 2 || b != 3 {
			t.Fatalf("ids = %d %d", a, b)
		}
		return nil
	}); err != nil {
		t.Fatalf("a topic with an empty or huge title must still open: %v", err)
	}
	rows, err := h.st.Pool().Query(ctx, `SELECT title, icon_color, created_at <= now() FROM forum_topics WHERE chat_id = $1 AND id > 1 ORDER BY id`, chatID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var title string
		var color int
		var notFuture bool
		if err := rows.Scan(&title, &color, &notFuture); err != nil {
			t.Fatal(err)
		}
		if n == 0 && (title != "Topic" || color != 0 || !notFuture) {
			t.Fatalf("empty title topic = %q colour %d notFuture %v, want a placeholder title, no colour and a date not after now", title, color, notFuture)
		}
		if n == 1 && (len([]rune(title)) > titleMax || color != 0) {
			t.Fatalf("long title topic = %d characters, colour %d", len([]rune(title)), color)
		}
		n++
	}
}

func TestAMessageForAnUnknownTopicOrInAChatWithoutTopicsIsRefusedWhole(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.forumCopy(owner)
	err := h.importInto(chatID, owner, func(it *ImportTx) error {
		_, err := it.Append(ctx, []ImportMessage{{FromID: owner, Date: time.Now(), Text: "tốt"}, {FromID: owner, Date: time.Now(), Text: "topic lạ", TopicID: 77}})
		return err
	})
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("a batch naming topic 77 = %v, want InvalidArgument", err)
	}
	var n int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM messages WHERE chat_id = $1`, chatID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d messages were written (%v): the refused batch must write nothing", n, err)
	}
	plain := h.group(owner)
	err = h.importInto(plain, owner, func(it *ImportTx) error {
		_, err := it.Append(ctx, []ImportMessage{{FromID: owner, Date: time.Now(), Text: "x", TopicID: 2}})
		return err
	})
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("a topic in a chat without topics = %v, want InvalidArgument", err)
	}
	if err := h.importInto(plain, owner, func(it *ImportTx) error {
		_, err := it.CreateTopic(ctx, TopicImport{Title: "x"})
		return err
	}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("opening a topic in a chat without topics = %v, want InvalidArgument", err)
	}
}

func TestOpeningTooManyTopicsIsAnErrorTheBridgeCanAnswer(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.forumCopy(owner)
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET last_topic_id = $2 WHERE id = $1`, chatID, topicsPerChatMax); err != nil {
		t.Fatal(err)
	}
	err := h.importInto(chatID, owner, func(it *ImportTx) error {
		_, err := it.CreateTopic(ctx, TopicImport{Title: "một nữa"})
		return err
	})
	if !errors.Is(err, ErrTooManyTopics) {
		t.Fatalf("topic number %d = %v, want ErrTooManyTopics", topicsPerChatMax+1, err)
	}
}

func TestTopicsOfALinkedChatAreManagedInTheOtherAppOnly(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.forumCopy(owner)
	if _, _, err := h.svc.CreateForumTopic(ctx, owner, &appv1.CreateForumTopicRequest{ChatId: chatID, Title: "của tôi"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("creating a topic in a linked chat = %v, want PermissionDenied", err)
	}
	if _, _, err := h.svc.EditForumTopic(ctx, owner, &appv1.EditForumTopicRequest{ChatId: chatID, TopicId: generalTopicID, Title: strPtr("khác")}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("renaming a topic of a linked chat = %v, want PermissionDenied", err)
	}
	if _, _, err := h.svc.CloseForumTopic(ctx, owner, chatID, generalTopicID, true); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("closing a topic of a linked chat = %v, want PermissionDenied", err)
	}
	got, _, err := h.svc.GetChat(ctx, owner, chatID)
	if err != nil {
		t.Fatal(err)
	}
	if got.GetMyPermissions()&permManageTopics != 0 {
		t.Fatalf("permissions %b still carry the right to manage topics", got.GetMyPermissions())
	}
	// The bridge itself still opens topics; and an ordinary forum is untouched.
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		_, err := it.CreateTopic(ctx, TopicImport{Title: "từ Telegram"})
		return err
	}); err != nil {
		t.Fatalf("the bridge could not open a topic: %v", err)
	}
	own, err := h.svc.CreateGroup(ctx, owner, "forum thường", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreateForumTopic(ctx, owner, &appv1.CreateForumTopicRequest{ChatId: own.GetChat().GetId(), Title: "topic thường"}); err != nil {
		t.Fatalf("creating a topic in an ordinary forum = %v, want it to work as before", err)
	}
}

func strPtr(s string) *string { return &s }

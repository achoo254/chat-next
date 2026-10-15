package chat

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// assistantChat returns the private chat between user and bot, 0 if none.
func (h *harness) assistantChat(user, bot int64) int64 {
	h.t.Helper()
	var id int64
	err := h.st.Pool().QueryRow(context.Background(), `
		SELECT chat_id FROM private_chats WHERE user_low = $1 AND user_high = $2`, min(user, bot), max(user, bot)).Scan(&id)
	if err != nil && !isNoRows(err) {
		h.t.Fatal(err)
	}
	return id
}

func TestSystemBotChatIsCreatedOnceWithAnUpdate(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	user := h.user("lan")
	// Off until the assistant is set.
	if err := h.svc.EnsureSystemBotChat(ctx, user); err != nil {
		t.Fatal(err)
	}
	bot := h.bot(user, "tro_ly_bot")
	h.svc.SetSystemBot(bot)
	if h.assistantChat(user, bot) != 0 {
		t.Fatal("a chat exists before the assistant was set")
	}
	// Concurrent starts (two tabs) create one chat.
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if err := h.svc.EnsureSystemBotChat(ctx, user); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	chatID := h.assistantChat(user, bot)
	if chatID == 0 {
		t.Fatal("no assistant chat")
	}
	var added int
	for _, u := range h.logOf(user) {
		if a := u.GetMemberAdded(); a != nil && a.GetChatId() == chatID {
			added++
		}
	}
	if added != 1 {
		t.Fatalf("member_added updates for the assistant chat = %d", added)
	}
	if len(h.logOf(bot)) != 0 {
		t.Fatal("the bot got an update")
	}
	dialogs, err := h.svc.GetDialogs(ctx, user, "", 0)
	if err != nil || len(dialogs.GetDialogs()) != 1 || dialogs.GetDialogs()[0].GetChatId() != chatID {
		t.Fatalf("dialogs = %v, %v", dialogs, err)
	}
	// A deleted chat stays deleted.
	if _, err := h.svc.DeleteChat(ctx, user, chatID); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.EnsureSystemBotChat(ctx, user); err != nil {
		t.Fatal(err)
	}
	if dialogs, _ := h.svc.GetDialogs(ctx, user, "", 0); len(dialogs.GetDialogs()) != 0 {
		t.Fatalf("the deleted assistant chat came back: %v", dialogs)
	}
	// Bots get none.
	other := h.bot(user, "other_bot")
	if err := h.svc.EnsureSystemBotChat(ctx, other); err != nil || h.assistantChat(other, bot) != 0 {
		t.Fatalf("a bot got the assistant chat: %v", err)
	}
	if err := h.svc.EnsureSystemBotChat(ctx, bot); err != nil {
		t.Fatal(err)
	}
}

func TestFeedbackQueue(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	user := h.user("lan")
	op := h.user("op")
	h = newHarnessOn(t, h.st, testTenant, func(c *Config) { c.Operators = []int64{op} })

	if _, err := h.svc.RecordFeedback(ctx, user, 10, 1, "rant", "x"); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unknown kind: %v", err)
	}
	if _, err := h.svc.RecordFeedback(ctx, user, 10, 1, FeedbackIdea, "   "); err == nil {
		t.Fatal("empty feedback accepted")
	}
	for i := range 5 {
		created, err := h.svc.RecordFeedback(ctx, user, 10, int64(i+1), FeedbackBug, "bug "+strconv.Itoa(i))
		if err != nil || !created {
			t.Fatalf("record %d: %v %v", i, created, err)
		}
	}
	// The same message again is a no-op.
	if created, err := h.svc.RecordFeedback(ctx, user, 10, 1, FeedbackIdea, "other"); err != nil || created {
		t.Fatalf("recorded twice: %v %v", created, err)
	}
	page, err := h.svc.GetFeedback(ctx, op, &appv1.GetFeedbackRequest{Limit: 3})
	if err != nil || len(page.GetFeedback()) != 3 || page.GetNextCursor() == "" || page.GetFeedback()[0].GetText() != "bug 4" {
		t.Fatalf("first page = %v, %v", page, err)
	}
	rest, err := h.svc.GetFeedback(ctx, op, &appv1.GetFeedbackRequest{Limit: 3, Cursor: page.GetNextCursor()})
	if err != nil || len(rest.GetFeedback()) != 2 || rest.GetNextCursor() != "" {
		t.Fatalf("second page = %v, %v", rest, err)
	}
	if _, err := h.svc.GetFeedback(ctx, op, &appv1.GetFeedbackRequest{Cursor: "x"}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad cursor: %v", err)
	}
	id := page.GetFeedback()[0].GetId()
	if _, err := h.svc.ResolveFeedback(ctx, user, id); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("resolve by a non-operator: %v", err)
	}
	first, err := h.svc.ResolveFeedback(ctx, op, id)
	if err != nil || first.GetStatus() != appv1.FeedbackStatus_FEEDBACK_STATUS_HANDLED {
		t.Fatalf("resolve = %v, %v", first, err)
	}
	again, err := h.svc.ResolveFeedback(ctx, op, id)
	if err != nil || again.GetHandledAt() != first.GetHandledAt() {
		t.Fatalf("resolve again = %v, %v", again, err)
	}
	if _, err := h.svc.ResolveFeedback(ctx, op, 999999); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown item: %v", err)
	}
	if _, err := CleanFeedbackReply(strings.Repeat("a", FeedbackReplyMax+1)); err == nil {
		t.Fatal("an over-long answer passed")
	}
}

// The assistant chat reaches an existing client only as member_added: the
// frame must carry the bot, or the client shows a nameless chat.
func TestSystemBotChatUpdateCarriesTheBot(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	user := h.user("lan")
	bot := h.bot(user, "tro_ly_bot")
	h.svc.SetSystemBot(bot)
	if err := h.svc.EnsureSystemBotChat(ctx, user); err != nil {
		t.Fatal(err)
	}
	chatID := h.assistantChat(user, bot)
	resp, err := h.svc.GetDifference(ctx, user, &appv1.GetDifferenceRequest{Pts: 0, ServerEpoch: h.svc.Epoch()})
	if err != nil {
		t.Fatal(err)
	}
	full := resp.GetFull()
	if full == nil || len(full.GetUpdates()) != 1 || full.GetUpdates()[0].GetMemberAdded().GetChatId() != chatID {
		t.Fatalf("difference = %v", resp)
	}
	var peer *appv1.User
	for _, u := range full.GetUsers() {
		if u.GetId() == bot {
			peer = u
		}
	}
	if peer == nil || !peer.GetIsBot() || peer.GetUsername() != "tro_ly_bot" {
		t.Fatalf("the frame's users miss the bot: %v", full.GetUsers())
	}
	if len(full.GetChats()) != 1 || full.GetChats()[0].GetPeerUserId() != bot {
		t.Fatalf("frame chats = %v", full.GetChats())
	}
}

package assistant_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/assistant"
	"app.local/server/internal/botapi"
	"app.local/server/internal/bottest"
	"app.local/server/internal/brand"
	"app.local/server/internal/chat"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

var names = brand.Names{AppName: "Demo App", ShortName: "Demo"}

type world struct {
	env       *bottest.Env
	api       *botapi.Service
	assistant *assistant.Service
	operator  int64
}

func newWorld(t *testing.T) *world {
	t.Helper()
	env := bottest.NewWith(t, bottest.Options{Operators: []string{"operator"}})
	api, err := botapi.New(botapi.Config{TenantID: bottest.TenantID, PublicOrigin: bottest.PublicOrigin, AppScheme: bottest.AppScheme},
		env.Chat, env.Admin, env.Updates, env.Limiter, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	a, err := assistant.New(env.Chat, env.Admin, env.Updates, api, names, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return &world{env: env, api: api, assistant: a, operator: env.Operators[0]}
}

// history returns the messages of chatID as user sees them.
func (w *world) history(t *testing.T, user, chatID int64) []*appv1.Message {
	t.Helper()
	resp, err := w.env.Chat.GetHistory(context.Background(), user, &appv1.GetHistoryRequest{ChatId: chatID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	return resp.GetMessages()
}

// waitBotMessage waits for the n-th message of the assistant in chatID.
func (w *world) waitBotMessage(t *testing.T, user, chatID int64, n int) *appv1.Message {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var mine []*appv1.Message
		for _, m := range w.history(t, user, chatID) {
			if m.GetFromId() == w.assistant.BotID() {
				mine = append(mine, m)
			}
		}
		if len(mine) >= n {
			return mine[n-1]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the assistant did not send message %d in chat %d", n, chatID)
	return nil
}

func (w *world) say(t *testing.T, user, chatID int64, text string) int64 {
	t.Helper()
	sent, err := w.env.Chat.SendMessage(context.Background(), user, &appv1.SendMessageRequest{ChatId: chatID, Text: text})
	if err != nil {
		t.Fatal(err)
	}
	return sent.GetMessage().GetSeq()
}

func (w *world) press(t *testing.T, user int64, m *appv1.Message, data string) {
	t.Helper()
	if _, err := w.env.Chat.PressInlineButton(context.Background(), user, &appv1.PressInlineButtonRequest{
		ChatId: m.GetChatId(), Seq: m.GetSeq(), CallbackData: []byte(data),
	}); err != nil {
		t.Fatal(err)
	}
}

func buttons(m *appv1.Message) []string {
	var out []string
	for _, row := range m.GetReplyMarkup().GetInlineKeyboard().GetRows() {
		for _, b := range row.GetButtons() {
			out = append(out, b.GetText())
		}
	}
	return out
}

// The whole assistant journey: an empty chat on first start, the greeting
// only after "Bắt đầu", feedback filed from free text and buttons, and the
// operator's answer delivered through the assistant.
func TestAssistantGreetsCollectsFeedbackAndRelaysTheAnswer(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	env := w.env
	botID := w.assistant.BotID()
	user := env.User("lan")

	if err := env.Chat.EnsureSystemBotChat(ctx, user); err != nil {
		t.Fatal(err)
	}
	if err := env.Chat.EnsureSystemBotChat(ctx, user); err != nil {
		t.Fatal(err)
	}
	dialogs, err := env.Chat.GetDialogs(ctx, user, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	var chatID int64
	for _, c := range dialogs.GetChats() {
		if c.GetPeerUserId() == botID {
			chatID = c.GetId()
		}
	}
	if chatID == 0 || len(dialogs.GetDialogs()) != 1 {
		t.Fatalf("dialogs after the first start: %v", dialogs)
	}
	if got := w.history(t, user, chatID); len(got) != 0 {
		t.Fatalf("the assistant chat starts empty, got %v", got)
	}
	// Consent as for any bot: nothing before the user starts it.
	if _, err := w.api.SendAsSystemBot(ctx, botID, botapi.OutgoingMessage{ChatID: chatID, Text: "hi"}); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("send before start: %v", err)
	}

	if _, err := env.Chat.StartBot(ctx, user, &appv1.StartBotRequest{BotId: botID, RandomId: 7}); err != nil {
		t.Fatal(err)
	}
	welcome := w.waitBotMessage(t, user, chatID, 1)
	if !strings.Contains(welcome.GetText(), "Chào mừng bạn đến với Demo App") || !strings.Contains(welcome.GetText(), "Developer Console") {
		t.Fatalf("welcome = %q", welcome.GetText())
	}
	if got := strings.Join(buttons(welcome), "|"); got != "Hướng dẫn nhanh|Gửi góp ý|Báo lỗi" {
		t.Fatalf("welcome buttons = %s", got)
	}

	w.press(t, user, welcome, "guide")
	if guide := w.waitBotMessage(t, user, chatID, 2); !strings.HasPrefix(guide.GetText(), "Hướng dẫn nhanh") {
		t.Fatalf("guide = %q", guide.GetText())
	}

	// Free text is feedback (an idea).
	idea := w.say(t, user, chatID, "Thêm chế độ tối nhé")
	thanks := w.waitBotMessage(t, user, chatID, 3)
	if thanks.GetText() != "Cảm ơn bạn! Đội ngũ đã nhận được góp ý." || thanks.GetReplyToSeq() != idea {
		t.Fatalf("thanks = %q (reply to %d)", thanks.GetText(), thanks.GetReplyToSeq())
	}
	// "Báo lỗi" files the next message as a bug.
	w.press(t, user, welcome, "bug")
	if ask := w.waitBotMessage(t, user, chatID, 4); !strings.Contains(ask.GetText(), "lỗi") {
		t.Fatalf("bug prompt = %q", ask.GetText())
	}
	w.say(t, user, chatID, "Không gửi được ảnh")
	w.waitBotMessage(t, user, chatID, 5)
	// /gopy with text files it at once; commands are not feedback.
	w.say(t, user, chatID, "/gopy Giao diện đẹp")
	w.waitBotMessage(t, user, chatID, 6)
	w.say(t, user, chatID, "/lenhla")
	if unknown := w.waitBotMessage(t, user, chatID, 7); !strings.Contains(unknown.GetText(), "/huongdan") {
		t.Fatalf("unknown command = %q", unknown.GetText())
	}

	if _, err := env.Chat.GetFeedback(ctx, user, &appv1.GetFeedbackRequest{}); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("feedback for a non-operator: %v", err)
	}
	open, err := env.Chat.GetFeedback(ctx, w.operator, &appv1.GetFeedbackRequest{})
	if err != nil {
		t.Fatal(err)
	}
	items := open.GetFeedback()
	if len(items) != 3 {
		t.Fatalf("open feedback = %v", items)
	}
	// Newest first.
	want := []struct {
		text string
		kind appv1.FeedbackKind
	}{
		{"Giao diện đẹp", appv1.FeedbackKind_FEEDBACK_KIND_IDEA},
		{"Không gửi được ảnh", appv1.FeedbackKind_FEEDBACK_KIND_BUG},
		{"Thêm chế độ tối nhé", appv1.FeedbackKind_FEEDBACK_KIND_IDEA},
	}
	for i, wnt := range want {
		if items[i].GetText() != wnt.text || items[i].GetKind() != wnt.kind || items[i].GetUserId() != user {
			t.Fatalf("item %d = %v, want %v", i, items[i], wnt)
		}
	}
	if len(open.GetUsers()) == 0 {
		t.Fatal("the senders are not listed")
	}

	answered, err := w.assistant.Reply(ctx, w.operator, items[2].GetId(), "Đã có trong kế hoạch, cảm ơn bạn!")
	if err != nil {
		t.Fatal(err)
	}
	if answered.GetStatus() != appv1.FeedbackStatus_FEEDBACK_STATUS_HANDLED || answered.GetRepliedBy() != w.operator ||
		answered.GetReplyText() != "Đã có trong kế hoạch, cảm ơn bạn!" {
		t.Fatalf("answered = %v", answered)
	}
	reply := w.waitBotMessage(t, user, chatID, 8)
	if !strings.HasPrefix(reply.GetText(), "Phản hồi từ đội ngũ Demo App") || reply.GetReplyToSeq() != idea {
		t.Fatalf("reply = %q (reply to %d)", reply.GetText(), reply.GetReplyToSeq())
	}
	if _, err := w.assistant.Reply(ctx, w.operator, items[2].GetId(), "again"); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("second answer: %v", err)
	}
	if _, err := w.assistant.Reply(ctx, user, items[1].GetId(), "x"); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("answer by a non-operator: %v", err)
	}
	resolved, err := env.Chat.ResolveFeedback(ctx, w.operator, items[1].GetId())
	if err != nil || resolved.GetStatus() != appv1.FeedbackStatus_FEEDBACK_STATUS_HANDLED || resolved.GetHandledBy() != w.operator {
		t.Fatalf("resolve = %v, %v", resolved, err)
	}
	handled, err := env.Chat.GetFeedback(ctx, w.operator, &appv1.GetFeedbackRequest{Status: appv1.FeedbackStatus_FEEDBACK_STATUS_HANDLED})
	if err != nil || len(handled.GetFeedback()) != 2 {
		t.Fatalf("handled = %v, %v", handled, err)
	}
}

// The assistant is set up again at every start without a second account,
// and stays out of everyone's Developer Console and bot limit.
func TestEnsureIsIdempotentAndHidden(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	again, err := assistant.New(w.env.Chat, w.env.Admin, w.env.Updates, w.api, brand.Names{AppName: "Renamed", ShortName: "Ren"}, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	if err := again.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if again.BotID() != w.assistant.BotID() {
		t.Fatalf("second Ensure made bot %d, first %d", again.BotID(), w.assistant.BotID())
	}
	bot, err := w.env.Admin.Live(ctx, again.BotID())
	if err != nil {
		t.Fatal(err)
	}
	if bot.Name != "Ren Trợ lý" || bot.Username != assistant.Username || !bot.System || bot.Tier() != "internal" || !bot.Verified {
		t.Fatalf("assistant = %+v", bot)
	}
	if mine, err := w.env.Admin.ListMyBots(ctx, again.BotID()); err != nil || len(mine) != 0 {
		t.Fatalf("the assistant lists itself: %v, %v", mine, err)
	}
	// Nobody else can take its username.
	owner := w.env.User("dev")
	if _, err := w.env.Admin.CreateBot(ctx, owner, assistant.Username, "Fake"); connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("taking the assistant's username: %v", err)
	}
	if _, err := w.env.Admin.Owned(ctx, again.BotID(), again.BotID()); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("the assistant is manageable: %v", err)
	}
}

func TestModerationNoticeReachesAUserWhoNeverStarted(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	user := w.env.User("binh")
	until := time.Date(2026, 10, 23, 7, 30, 0, 0, time.UTC)
	if err := w.assistant.NotifyModeration(ctx, user, chat.ModerationNotice{
		Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_WARN, appv1.ModerationAction_MODERATION_ACTION_RESTRICT_ACCOUNT},
		Note:    "spam vào nhóm", Until: until,
	}); err != nil {
		t.Fatal(err)
	}
	chatID, err := w.env.Chat.SystemBotNoticeChat(ctx, user)
	if err != nil || chatID == 0 {
		t.Fatalf("notice chat = %d, %v", chatID, err)
	}
	m := w.waitBotMessage(t, user, chatID, 1)
	for _, want := range []string{"cảnh cáo", "14:30 23/10/2026", "Lý do: spam vào nhóm"} {
		if !strings.Contains(m.GetText(), want) {
			t.Fatalf("notice %q lacks %q", m.GetText(), want)
		}
	}
	// Actions that do not concern the user say nothing.
	if err := w.assistant.NotifyModeration(ctx, user, chat.ModerationNotice{
		Actions: []appv1.ModerationAction{appv1.ModerationAction_MODERATION_ACTION_DISABLE_WEBHOOK}, Note: "x",
	}); err != nil {
		t.Fatal(err)
	}
	if n := len(w.history(t, user, chatID)); n != 1 {
		t.Fatalf("%d messages after a notice about nothing", n)
	}
}

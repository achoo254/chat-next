package chat

import (
	"context"
	"fmt"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// bot makes a live bot of owner directly in the tables, as botadmin does,
// that anyone may add to groups.
func (h *harness) bot(owner int64, username string) int64 {
	h.t.Helper()
	ctx := context.Background()
	var id int64
	if err := h.st.Pool().QueryRow(ctx, `
		INSERT INTO users (id, tenant_id, idp_sub, username, name, is_bot)
		VALUES ((SELECT coalesce(max(id), 0) + 1000 FROM users), $1, NULL, $2, $2, true) RETURNING id`,
		h.svc.cfg.TenantID, username).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO bots (user_id, tenant_id, owner_id) VALUES ($1, $2, $3)`,
		id, h.svc.cfg.TenantID, owner); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO privacy_settings (user_id, add_to_groups) VALUES ($1, 1)`, id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func TestBotConsentInCore(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	bot := h.bot(owner, "corebot")
	user := h.user("user")
	c, _, err := h.svc.CreatePrivate(ctx, user, bot)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.SendBotMessage(ctx, bot, BotMessage{ChatID: c.GetId(), Text: "unsolicited"})
	if codeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "no_consent") {
		t.Fatalf("bot without consent: %v", err)
	}
	// Forwards (like media) go through the same check: postable.
	group := h.group(owner, bot)
	posted := h.send(owner, group, "/news") // a command: privacy mode lets the bot repost it
	_, err = h.svc.ForwardMessages(ctx, bot, &appv1.ForwardMessagesRequest{
		FromChatId: group, ToChatId: c.GetId(), Seqs: []int64{posted.GetMessage().GetSeq()},
	})
	if codeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "no_consent") {
		t.Fatalf("forward without consent: %v", err)
	}
	h.send(user, c.GetId(), "hi bot")
	var source string
	if err := h.st.Pool().QueryRow(ctx, `SELECT source FROM bot_user_consent WHERE bot_id = $1 AND user_id = $2`, bot, user).Scan(&source); err != nil || source != ConsentMessage {
		t.Fatalf("consent = %q, %v", source, err)
	}
	if _, err := h.svc.SendBotMessage(ctx, bot, BotMessage{ChatID: c.GetId(), Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	// Blocking the bot stops it again.
	if err := h.svc.Block(ctx, user, bot); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SendBotMessage(ctx, bot, BotMessage{ChatID: c.GetId(), Text: "still here"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("blocked bot: %v", err)
	}
	// Users render with is_bot.
	users, err := h.svc.GetUsers(ctx, user, []int64{bot, user})
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		if u.GetIsBot() != (u.GetId() == bot) {
			t.Fatalf("user %d is_bot = %v", u.GetId(), u.GetIsBot())
		}
	}
}

func TestCommandOf(t *testing.T) {
	for text, want := range map[string]string{
		"/start":             "start|",
		"/start ref":         "start|",
		"/help@quietbot x":   "help|quietbot",
		"/help@quietbot\nx":  "help|quietbot",
		"hello /start":       "",
		"/":                  "",
		"/ab-c":              "",
		"/start@":            "",
		"//x":                "",
		"/x@" + "a_b":        "x|a_b",
		"/đ":                 "",
		"/start\tparam":      "start|",
		"/very_long_command": "very_long_command|",
	} {
		name, target, ok := CommandOf(text)
		got := ""
		if ok {
			got = name + "|" + target
		}
		if got != want {
			t.Errorf("CommandOf(%q) = %q, want %q", text, got, want)
		}
	}
}

// outboxHead is the id of the newest outbox row.
func (h *harness) outboxHead() int64 {
	h.t.Helper()
	var id int64
	if err := h.st.Pool().QueryRow(context.Background(), `SELECT coalesce(max(id), 0) FROM outbox`).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

// botUpdatesSince cuts the updates of every outbox row after id, as the
// bots consumer does, and returns their kinds per bot.
func (h *harness) botUpdatesSince(id int64) []BotUpdate {
	h.t.Helper()
	rows, err := h.svc.ReadOutbox(context.Background(), id, 1000)
	if err != nil {
		h.t.Fatal(err)
	}
	updates, err := h.svc.BotUpdates(context.Background(), rows)
	if err != nil {
		h.t.Fatal(err)
	}
	return updates
}

func kindsOf(updates []BotUpdate) []string {
	var out []string
	for _, u := range updates {
		out = append(out, u.Kind)
	}
	return out
}

func TestServerRewriteIsNotAnEditForBots(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	bot := h.bot(owner, "editbot")
	if _, err := h.st.Pool().Exec(ctx, `UPDATE bots SET privacy = false WHERE user_id = $1`, bot); err != nil {
		t.Fatal(err)
	}
	group := h.group(owner, bot)
	start := h.outboxHead()
	seq := h.send(owner, group, "hello").GetMessage().GetSeq()
	// A server-side rewrite of a message never edited: no update.
	preview := func(title string) {
		t.Helper()
		var version int32
		if err := h.st.Pool().QueryRow(ctx, `SELECT edit_version FROM messages WHERE chat_id = $1 AND seq = $2`, group, seq).Scan(&version); err != nil {
			t.Fatal(err)
		}
		if err := h.svc.setPreview(ctx, group, seq, version, &appv1.LinkPreview{Url: "https://example.com/", Title: title}); err != nil {
			t.Fatal(err)
		}
	}
	preview("first")
	if _, err := h.svc.EditMessage(ctx, owner, &appv1.EditMessageRequest{ChatId: group, Seq: seq, Text: "hello again", NoLinkPreview: true}); err != nil {
		t.Fatal(err)
	}
	// The preview of the edited text arrives later: still one edit.
	preview("second")
	if got := fmt.Sprint(kindsOf(h.botUpdatesSince(start))); got != "[message message_edited]" {
		t.Fatalf("updates = %s, want one message and one edit", got)
	}
}

func TestDeletedMessageHasNoCallback(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	bot := h.bot(owner, "pressbot")
	group := h.group(owner, bot)
	markup := &appv1.ReplyMarkup{Kind: &appv1.ReplyMarkup_InlineKeyboard{InlineKeyboard: &appv1.InlineKeyboard{
		Rows: []*appv1.InlineKeyboardRow{{Buttons: []*appv1.InlineButton{{Text: "Go", Action: &appv1.InlineButton_CallbackData{CallbackData: []byte("go")}}}}},
	}}}
	sent, err := h.svc.SendBotMessage(ctx, bot, BotMessage{ChatID: group, Text: "pick", Markup: markup})
	if err != nil {
		t.Fatal(err)
	}
	seq := sent.GetMessage().GetSeq()
	start := h.outboxHead()
	press := &appv1.PressInlineButtonRequest{ChatId: group, Seq: seq, CallbackData: []byte("go")}
	if _, err := h.svc.PressInlineButton(ctx, owner, press); err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(kindsOf(h.botUpdatesSince(start))); got != "[callback]" {
		t.Fatalf("updates before delete = %s", got)
	}
	// The bot deletes the message before the consumer reads the press.
	if _, err := h.svc.DeleteMessages(ctx, bot, group, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	if got := kindsOf(h.botUpdatesSince(start)); len(got) != 0 {
		t.Fatalf("updates after delete = %v", got)
	}
	if _, err := h.svc.PressInlineButton(ctx, owner, press); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("press on a deleted message: %v", err)
	}
}

func TestStartBotConsentOnlyWithTheMessage(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	bot := h.bot(owner, "startbot")
	user := h.user("user")
	if _, _, err := h.svc.CreatePrivate(ctx, user, bot); err != nil {
		t.Fatal(err)
	}
	// The bot blocked the user: /start is refused and gives no consent.
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, bot, user); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.StartBot(ctx, user, &appv1.StartBotRequest{BotId: bot, StartParam: "ref"}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("StartBot while blocked: %v", err)
	}
	consent := func() string {
		t.Helper()
		var source string
		err := h.st.Pool().QueryRow(ctx, `SELECT source FROM bot_user_consent WHERE bot_id = $1 AND user_id = $2`, bot, user).Scan(&source)
		if err != nil && !isNoRows(err) {
			t.Fatal(err)
		}
		return source
	}
	if got := consent(); got != "" {
		t.Fatalf("consent after a refused start = %q", got)
	}
	if _, err := h.st.Pool().Exec(ctx, `DELETE FROM blocks WHERE blocker_id = $1`, bot); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.StartBot(ctx, user, &appv1.StartBotRequest{BotId: bot, StartParam: "ref"}); err != nil {
		t.Fatal(err)
	}
	if got := consent(); got != ConsentDeepLink {
		t.Fatalf("consent = %q, want %q", got, ConsentDeepLink)
	}
}

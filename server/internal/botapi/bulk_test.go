package botapi

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botbulk"
	"app.local/server/internal/chat"
)

// runBulk runs bulk rounds until the job finished.
func (h *harness) runBulk(token string, id int64) bulkJob {
	h.T.Helper()
	var job bulkJob
	// A job waits a second between batches (its pace).
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if err := h.bulk.Round(context.Background()); err != nil {
			h.T.Fatal(err)
		}
		h.call(http.MethodGet, fmt.Sprintf("/bot/v1/bulk/%d", id), token, "").into(h.T, &job)
		if job.State == botbulk.StateDone || job.State == botbulk.StateCancelled {
			return job
		}
	}
	h.T.Fatalf("bulk send %d did not finish: %+v", id, job)
	return job
}

// texts returns the texts the bot sent in chatID, read by user.
func (h *harness) texts(user, chatID int64) []string {
	h.T.Helper()
	history, err := h.Chat.GetHistory(context.Background(), user, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil {
		h.T.Fatal(err)
	}
	var out []string
	for _, m := range history.GetMessages() {
		if m.GetText() != "" && m.GetFromId() != user {
			out = append(out, m.GetText())
		}
	}
	return out
}

// A bulk send reaches each listed user who started the bot, once, in the
// bot's private chat; users who did not start it are skipped.
func TestBulkSend(t *testing.T) {
	h := newHarness(t)
	botID, token := h.Bot(h.User("owner"), "newsbot")
	lan, lanChat := h.started(botID, "lan")
	minh, minhChat := h.started(botID, "minh")
	stranger := h.User("stranger")

	var job bulkJob
	h.post(token, "/bot/v1/messages:bulk", map[string]any{
		"user_ids": []int64{lan, minh, stranger, lan}, "text": "<b>Tin mới</b>", "parse_mode": "html",
		"reply_markup": map[string]any{"inline_keyboard": [][]map[string]any{{{"text": "Xem", "url": "https://example.com"}}}},
	}).into(t, &job)
	if job.State != botbulk.StateQueued || job.Total != 3 || job.BulkID == 0 {
		t.Fatalf("queued = %+v", job)
	}
	done := h.runBulk(token, job.BulkID)
	if done.State != botbulk.StateDone || done.Sent != 2 || done.Skipped != 1 || done.Failed != 0 || done.FinishedAt == 0 {
		t.Fatalf("done = %+v", done)
	}
	for _, c := range []struct{ user, chat int64 }{{lan, lanChat}, {minh, minhChat}} {
		if got := h.texts(c.user, c.chat); len(got) != 1 || got[0] != "Tin mới" {
			t.Fatalf("user %d got %q", c.user, got)
		}
	}

	// A job resumed from the start (as after a crash) sends nobody twice.
	if _, err := h.Store.Pool().Exec(context.Background(),
		`UPDATE bot_bulk_jobs SET state = 'running', progress = 0, finished_at = NULL WHERE id = $1`, job.BulkID); err != nil {
		t.Fatal(err)
	}
	h.runBulk(token, job.BulkID)
	if got := h.texts(lan, lanChat); len(got) != 1 {
		t.Fatalf("resumed job sent again: %q", got)
	}

	// Everyone who started the bot.
	var all bulkJob
	h.post(token, "/bot/v1/messages:bulk", map[string]any{"all": true, "text": "Cho tất cả"}).into(t, &all)
	if all.Total != 2 {
		t.Fatalf("all = %+v", all)
	}
	if done := h.runBulk(token, all.BulkID); done.Sent != 2 || done.Skipped != 0 {
		t.Fatalf("all done = %+v", done)
	}

	// Cancelled before its turn: nothing is sent.
	var cancelled bulkJob
	h.post(token, "/bot/v1/messages:bulk", map[string]any{"user_ids": []int64{lan}, "text": "Huỷ"}).into(t, &cancelled)
	h.call(http.MethodDelete, fmt.Sprintf("/bot/v1/bulk/%d", cancelled.BulkID), token, "").into(t, &cancelled)
	if cancelled.State != botbulk.StateCancelled || cancelled.Reason != botbulk.ReasonCancelled {
		t.Fatalf("cancelled = %+v", cancelled)
	}
	if done := h.runBulk(token, cancelled.BulkID); done.Sent != 0 {
		t.Fatalf("a cancelled job sent: %+v", done)
	}
	if got := h.texts(lan, lanChat); len(got) != 2 {
		t.Fatalf("lan got %q", got)
	}

	// Requests and other bots' jobs.
	h.post(token, "/bot/v1/messages:bulk", map[string]any{"user_ids": []int64{lan}, "all": true, "text": "x"}).
		fails(t, http.StatusBadRequest, "bad_request")
	h.post(token, "/bot/v1/messages:bulk", map[string]any{"text": "x"}).fails(t, http.StatusBadRequest, "bad_request")
	h.post(token, "/bot/v1/messages:bulk", map[string]any{"user_ids": []int64{lan}, "text": ""}).
		fails(t, http.StatusBadRequest, "bad_request")
	_, other := h.Bot(h.User("owner2"), "otherbot")
	h.call(http.MethodGet, fmt.Sprintf("/bot/v1/bulk/%d", job.BulkID), other, "").fails(t, http.StatusNotFound, "not_found")
	h.post(other, "/bot/v1/messages:bulk", map[string]any{"all": true, "text": "x"}).fails(t, http.StatusBadRequest, "bad_request")
}

// The daily cap counts the recipients of the last 24 hours.
func TestBulkDailyCap(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	botID, _ := h.Bot(h.User("owner"), "capbot")
	a, _ := h.started(botID, "a")
	b, _ := h.started(botID, "b")
	req := botbulk.Request{BotID: botID, UserIDs: []int64{a, b}, Pace: 10, Cap: 3, Message: chat.BotMessage{Text: "x"}}
	if _, err := h.bulk.Create(ctx, req); err != nil {
		t.Fatal(err)
	}
	_, err := h.bulk.Create(ctx, req)
	if qe, ok := err.(*botbulk.QuotaError); !ok || qe.Left != 1 {
		t.Fatalf("over the cap: %v", err)
	}
	req.UserIDs = []int64{a}
	if _, err := h.bulk.Create(ctx, req); err != nil {
		t.Fatalf("within the cap: %v", err)
	}
}

// A job stops when its bot is restricted (or deleted) meanwhile.
func TestBulkStopsWithTheBot(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	botID, token := h.Bot(h.User("owner"), "stopbot")
	a, aChat := h.started(botID, "a")
	var job bulkJob
	h.post(token, "/bot/v1/messages:bulk", map[string]any{"user_ids": []int64{a}, "text": "x"}).into(t, &job)
	if _, err := h.Store.Pool().Exec(ctx, `UPDATE bots SET restricted_at = now() WHERE user_id = $1`, botID); err != nil {
		t.Fatal(err)
	}
	if err := h.bulk.Round(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := h.bulk.Get(ctx, botID, job.BulkID)
	if err != nil || got.State != botbulk.StateCancelled || got.Reason != botbulk.ReasonRestricted || got.Sent != 0 {
		t.Fatalf("job = %+v, %v", got, err)
	}
	if texts := h.texts(a, aChat); len(texts) != 0 {
		t.Fatalf("sent %q", texts)
	}
}

// A bot's jobs share its pace: one batch per bot per round.
func TestBulkOneBatchPerBotPerRound(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	botID, _ := h.Bot(h.User("owner"), "pacebot")
	a, _ := h.started(botID, "a")
	b, _ := h.started(botID, "b")
	req := botbulk.Request{BotID: botID, UserIDs: []int64{a, b}, Pace: 1, Cap: botbulk.Unlimited, Message: chat.BotMessage{Text: "x"}}
	first, err := h.bulk.Create(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.bulk.Create(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.bulk.Round(ctx); err != nil {
		t.Fatal(err)
	}
	j1, _ := h.bulk.Get(ctx, botID, first.ID)
	j2, _ := h.bulk.Get(ctx, botID, second.ID)
	if j1.Sent+j2.Sent != 1 {
		t.Fatalf("one round sent %d + %d", j1.Sent, j2.Sent)
	}
	// Right away again: the job just served waits for the next second.
	if err := h.bulk.Round(ctx); err != nil {
		t.Fatal(err)
	}
	j1, _ = h.bulk.Get(ctx, botID, first.ID)
	j2, _ = h.bulk.Get(ctx, botID, second.ID)
	if j1.Sent+j2.Sent > 2 {
		t.Fatalf("two quick rounds sent %d + %d", j1.Sent, j2.Sent)
	}
}

package assistant_test

import (
	"context"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botbulk"
	"app.local/server/internal/bottest"
	"connectrpc.com/connect"
)

// An operator's announcement reaches every user who started the assistant,
// formatted as previewed, and is listed with its progress.
func TestAnnouncementReachesUsersWhoStarted(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	bulk := botbulk.New(w.env.Store.Pool(), w.env.Chat, bottest.TenantID, bottest.Quiet)
	w.assistant.UseBulk(bulk)
	user := w.env.User("lan")
	started, err := w.env.Chat.StartBot(ctx, user, &appv1.StartBotRequest{BotId: w.assistant.BotID()})
	if err != nil {
		t.Fatal(err)
	}
	w.env.User("never") // never started: not a recipient

	preview, err := w.assistant.PreviewAnnouncement(ctx, "*Mới:* gửi album")
	if err != nil || preview.GetText() != "Mới: gửi album" || preview.GetAudience() != 1 ||
		len(preview.GetEntities()) != 1 || preview.GetEntities()[0].GetType() != appv1.EntityType_ENTITY_TYPE_BOLD {
		t.Fatalf("preview = %v, %v", preview, err)
	}
	if _, err := w.assistant.PreviewAnnouncement(ctx, "*không đóng"); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad markdown: %v", err)
	}

	sent, err := w.assistant.SendAnnouncement(ctx, w.operator, "*Mới:* gửi album")
	if err != nil || sent.GetTotal() != 1 || sent.GetCreatedBy() != w.operator {
		t.Fatalf("send = %v, %v", sent, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if err := bulk.Round(ctx); err != nil {
			t.Fatal(err)
		}
		list, operators, audience, err := w.assistant.Announcements(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(list) == 1 && list[0].GetState() == appv1.AnnouncementState_ANNOUNCEMENT_STATE_DONE {
			if list[0].GetSent() != 1 || len(operators) != 1 || operators[0] != w.operator || audience != 1 ||
				len(list[0].GetEntities()) != 1 {
				t.Fatalf("announcements = %v %v %d", list, operators, audience)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the announcement did not finish: %v", list)
		}
		time.Sleep(50 * time.Millisecond)
	}
	var got *appv1.Message
	for _, m := range w.history(t, user, started.GetChat().GetId()) {
		if m.GetFromId() == w.assistant.BotID() && m.GetText() == "Mới: gửi album" {
			got = m
		}
	}
	if got == nil || len(got.GetEntities()) != 1 {
		t.Fatalf("message = %v", got)
	}
	if done, err := w.assistant.CancelAnnouncement(ctx, w.operator, sent.GetId()); err != nil ||
		done.GetState() != appv1.AnnouncementState_ANNOUNCEMENT_STATE_DONE {
		t.Fatalf("cancel after done = %v, %v", done, err)
	}
}

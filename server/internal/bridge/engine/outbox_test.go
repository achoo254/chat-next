package engine_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"app.local/server/internal/media"
)

// twoWay enables g1 with two imported messages and turns on sending.
func (e *env) twoWay() int64 {
	e.t.Helper()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1), e.msg("m2", lan, "tin 2", 2))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	if err := e.chat.SetImportedDirection(context.Background(), e.owner, chatID, chat.DirectionBoth); err != nil {
		e.t.Fatal(err)
	}
	return chatID
}

func (e *env) say(chatID int64, text string) int64 {
	e.t.Helper()
	r, err := e.chat.SendMessage(context.Background(), e.owner, &appv1.SendMessageRequest{ChatId: chatID, Text: text})
	if err != nil {
		e.t.Fatal(err)
	}
	return r.GetMessage().GetSeq()
}

func (e *env) outboxStatus(chatID, seq int64, op string) string {
	var s string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT status FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = $3`, chatID, seq, op).Scan(&s); err != nil {
		return "none"
	}
	return s
}

func (e *env) waitOutbox(chatID, seq int64, op, want string) {
	e.t.Helper()
	e.eventually(func() bool { return e.outboxStatus(chatID, seq, op) == want },
		func() string {
			return fmt.Sprintf("outbox %s of seq %d = %q, want %q", op, seq, e.outboxStatus(chatID, seq, op), want)
		})
}

func sentTexts(f interface{ Sent() []bridge.OutMessage }) []string {
	var out []string
	for _, m := range f.Sent() {
		out = append(out, m.Text)
	}
	return out
}

func TestChatMessageIsSentAndItsEchoIsNotImportedAgain(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	seq := e.say(chatID, "xin chào")
	e.waitOutbox(chatID, seq, "send", "sent")
	if got := sentTexts(e.fake); fmt.Sprint(got) != "[xin chào]" {
		t.Fatalf("sent = %v, want the one message", got)
	}
	if m := e.fake.Sent()[0]; m.Conversation != "g1" || m.RandomID <= 0 {
		t.Fatalf("sent message = %+v, want conversation g1 and the stored random id", m)
	}
	var key string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT external_msg_id FROM external_messages WHERE chat_id = $1 AND seq = $2`, chatID, seq).Scan(&key); err != nil || key == "" {
		t.Fatalf("the sent message has no key (%v): its echo would be imported as a second message", err)
	}
	// The fake sends the message back as an event of the account owner, as an
	// app may; it must not become a second message in Chat.
	time.Sleep(300 * time.Millisecond)
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "xin chào"})
}

func TestSendsGoOutInOrderAndAFloodWaitPausesThem(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.fake.FailSend(&bridge.RateLimitError{RetryAfter: 80 * time.Millisecond})
	a := e.say(chatID, "a")
	b := e.say(chatID, "b")
	e.waitOutbox(chatID, b, "send", "sent")
	e.waitOutbox(chatID, a, "send", "sent")
	if got := sentTexts(e.fake); fmt.Sprint(got) != "[a b]" {
		t.Fatalf("sent = %v, want a then b", got)
	}
}

func TestAFailureForGoodDoesNotHoldBackTheNextMessage(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.fake.FailSend(fmt.Errorf("channel: %w", bridge.ErrNotAllowed))
	a := e.say(chatID, "refused")
	b := e.say(chatID, "goes")
	e.waitOutbox(chatID, b, "send", "sent")
	if got := e.outboxStatus(chatID, a, "send"); got != "failed" {
		t.Fatalf("refused message status = %q, want failed", got)
	}
	var reason string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT last_error FROM external_outbox WHERE chat_id = $1 AND seq = $2`, chatID, a).Scan(&reason); err != nil || !strings.Contains(reason, "not allowed") {
		t.Fatalf("reason = %q (%v), want the refusal kept for the user", reason, err)
	}
}

func TestATemporaryFailureIsRetriedInPlace(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.fake.FailSend(errors.New("connection reset"), errors.New("connection reset"))
	a := e.say(chatID, "first")
	b := e.say(chatID, "second")
	e.waitOutbox(chatID, b, "send", "sent")
	if got := sentTexts(e.fake); fmt.Sprint(got) != "[first second]" {
		t.Fatalf("sent = %v: a retry must keep the order", got)
	}
	var attempts int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT attempts FROM external_outbox WHERE chat_id = $1 AND seq = $2`, chatID, a).Scan(&attempts); err != nil || attempts != 3 {
		t.Fatalf("attempts = %d (%v), want 3 (two failures and the send)", attempts, err)
	}
}

func TestAMessageInFlightDuringACrashIsNotSentTwice(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.stop()
	e.fake.EchoSent = false // the app does not send a message back to the session that sent it
	seq := e.say(chatID, "maybe sent")
	var randomID int64
	if err := e.st.Pool().QueryRow(context.Background(), `UPDATE external_outbox SET status = 'sending', attempts = 1 WHERE chat_id = $1 AND seq = $2 RETURNING random_id`, chatID, seq).Scan(&randomID); err != nil {
		t.Fatal(err)
	}
	// The app took the message, then the server died before it wrote the key.
	took, err := e.fake.SendMessage(context.Background(), bridge.Account{}, bridge.OutMessage{Conversation: "g1", Text: "maybe sent", RandomID: randomID})
	if err != nil {
		t.Fatal(err)
	}
	e.start()
	e.waitOutbox(chatID, seq, "send", "sent")
	if n := len(e.fake.Sent()); n != 1 {
		t.Fatalf("the app holds %d messages, want 1: the repeat must carry the same random id", n)
	}
	var key string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT external_msg_id FROM external_messages WHERE chat_id = $1 AND seq = $2`, chatID, seq).Scan(&key); err != nil || key != took.IDs[0] {
		t.Fatalf("key = %q (%v), want the id the app gave the first time %q", key, err, took.IDs[0])
	}
}

func TestASendInFlightForTooLongIsLeftToTheUser(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.stop()
	seq := e.say(chatID, "who knows")
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE external_outbox SET status = 'sending', updated_at = now() - interval '1 hour' WHERE chat_id = $1 AND seq = $2`, chatID, seq); err != nil {
		t.Fatal(err)
	}
	e.start()
	e.waitOutbox(chatID, seq, "send", "unknown")
	time.Sleep(200 * time.Millisecond)
	if n := len(e.fake.Sent()); n != 0 {
		t.Fatalf("%d messages were sent, want none until the user decides", n)
	}
}

func TestEditAndDeleteOfASentMessageReachTheOtherApp(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	seq := e.say(chatID, "one")
	e.waitOutbox(chatID, seq, "send", "sent")
	var key string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT external_msg_id FROM external_messages WHERE chat_id = $1 AND seq = $2`, chatID, seq).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.EditMessage(context.Background(), e.owner, &appv1.EditMessageRequest{ChatId: chatID, Seq: seq, Text: "one, corrected"}); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "edit", "sent")
	edits := e.fake.Edits()
	if len(edits) != 1 || edits[0].ID != key || edits[0].Conversation != "g1" || edits[0].Text != "one, corrected" {
		t.Fatalf("edits = %+v, want the new text on message %s", edits, key)
	}
	if _, err := e.chat.DeleteMessages(context.Background(), e.owner, chatID, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "delete", "sent")
	dels := e.fake.Deletes()
	if len(dels) != 1 || dels[0].Conversation != "g1" || fmt.Sprint(dels[0].IDs) != "["+key+"]" {
		t.Fatalf("deletes = %+v, want message %s of g1", dels, key)
	}
}

func TestAReplyPointsAtTheMessageAnsweredInTheOtherApp(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	var target int64
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT seq FROM external_messages WHERE chat_id = $1 AND external_msg_id = 'm1'`, chatID).Scan(&target); err != nil {
		t.Fatal(err)
	}
	r, err := e.chat.SendMessage(context.Background(), e.owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "re", ReplyToSeq: target})
	if err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, r.GetMessage().GetSeq(), "send", "sent")
	if got := e.fake.Sent()[0].ReplyTo; got != "m1" {
		t.Fatalf("reply_to = %q, want m1", got)
	}
}

func TestStylingGoesOutAsTheOtherAppsKinds(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	r, err := e.chat.SendMessage(context.Background(), e.owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "bold link",
		Entities: []*appv1.MessageEntity{
			{Type: appv1.EntityType_ENTITY_TYPE_BOLD, Offset: 0, Length: 4},
			{Type: appv1.EntityType_ENTITY_TYPE_TEXT_LINK, Offset: 5, Length: 4, Url: "https://example.com"},
		}})
	if err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, r.GetMessage().GetSeq(), "send", "sent")
	got := e.fake.Sent()[0].Entities
	if len(got) != 2 || got[0].Kind != "bold" || got[1].Kind != "link" || got[1].URL != "https://example.com" || got[1].Offset != 5 {
		t.Fatalf("entities = %+v, want bold and a link", got)
	}
}

func TestARevokedSessionStopsSendingAndKeepsWhatWasQueued(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.fake.FailSend(bridge.ErrSessionRevoked)
	seq := e.say(chatID, "kept")
	e.eventually(func() bool {
		var status string
		_ = e.st.Pool().QueryRow(context.Background(), `SELECT status FROM external_accounts WHERE id = $1`, e.account).Scan(&status)
		return status == "needs_login"
	}, func() string { return "account never needed a new login" })
	if got := e.outboxStatus(chatID, seq, "send"); got != "pending" {
		t.Fatalf("message status = %q, want it kept pending for after the new login", got)
	}
}

func TestAnAlbumGoesOutAsOneSendAndEachItemGetsItsKey(t *testing.T) {
	e := newEnvWithMedia(t, true)
	chatID := e.twoWay()
	ctx := context.Background()
	var files []string
	for i, body := range []string{"first file", "second file"} {
		f, err := e.media.UploadStream(ctx, e.owner, media.StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, FileName: fmt.Sprintf("f%d.txt", i),
			Body: strings.NewReader(body), MaxBytes: 1 << 20})
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f.PublicID)
	}
	r, err := e.chat.SendAlbum(ctx, e.owner, &appv1.SendAlbumRequest{ChatId: chatID, Items: []*appv1.AlbumItem{
		{FileId: files[0], Text: "the album"}, {FileId: files[1]},
	}})
	if err != nil {
		t.Fatal(err)
	}
	seqs := []int64{r.GetMessages()[0].GetSeq(), r.GetMessages()[1].GetSeq()}
	e.waitOutbox(chatID, seqs[1], "send", "sent")
	sent := e.fake.Sent()
	if len(sent) != 1 || len(sent[0].Media) != 2 || sent[0].Text != "the album" {
		t.Fatalf("sent = %+v, want one send of two files captioned by the first", sent)
	}
	for i, m := range sent[0].Media {
		rc, err := m.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(rc)
		_ = rc.Close()
		if want := []string{"first file", "second file"}[i]; string(body) != want || m.Kind != "document" || m.Name == "" {
			t.Fatalf("item %d = %q kind %q name %q, want %q as a document", i, body, m.Kind, m.Name, want)
		}
	}
	var keys int
	if err := e.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_messages WHERE chat_id = $1 AND seq = ANY($2)`, chatID, seqs).Scan(&keys); err != nil || keys != 2 {
		t.Fatalf("%d keys for the two items (%v), want 2", keys, err)
	}
}

package telegram_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/adapters/telegram"
)

// TestLiveTelegramSend sends, edits and deletes messages through the real
// adapter, into the account's own "Saved Messages" only (no one else sees
// them), then deletes what it sent and signs the session out. It is for a
// person to run by hand and never runs on its own:
//
//	BRIDGE_LIVE_SEND=1 BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… TELEGRAM_API_HASH=… \
//	  go test ./internal/bridge/adapters/telegram -run LiveTelegramSend -timeout 15m -v
//
// BRIDGE_LIVE_DIR holds the files phone, otp and pw (pw only for an account
// with a two-step password); the test waits for otp to appear. Nothing
// secret is typed into a command line or logged, and no message text is
// printed.
func TestLiveTelegramSend(t *testing.T) {
	if os.Getenv("BRIDGE_LIVE_SEND") == "" {
		t.Skip("set BRIDGE_LIVE_SEND=1 to run against a real Telegram account")
	}
	dir := os.Getenv("BRIDGE_LIVE_DIR")
	apiID, _ := strconv.Atoi(os.Getenv("TELEGRAM_API_ID"))
	if dir == "" || apiID == 0 || os.Getenv("TELEGRAM_API_HASH") == "" {
		t.Fatal("BRIDGE_LIVE_DIR, TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	a := telegram.New(telegram.Config{APIID: apiID, APIHash: os.Getenv("TELEGRAM_API_HASH")})
	t.Cleanup(a.Close)

	fileValue := func(name string, wait time.Duration) string {
		deadline := time.Now().Add(wait)
		for {
			if b, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
				return strings.TrimSpace(string(b))
			}
			if time.Now().After(deadline) {
				t.Fatalf("file %s never appeared in BRIDGE_LIVE_DIR", name)
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for step.Kind == bridge.StepInput {
		in := map[string]string{}
		for _, f := range step.Fields {
			switch f.Name {
			case "phone":
				in[f.Name] = fileValue("phone", time.Second)
			case "code":
				in[f.Name] = fileValue("otp", 6*time.Minute)
			case "password":
				in[f.Name] = fileValue("pw", time.Second)
			}
		}
		if step, err = a.Login(ctx, step.Token, in); err != nil {
			t.Fatal(err)
		}
	}
	if step.Kind != bridge.StepDone {
		t.Fatalf("login ended at %v", step.Kind)
	}
	acct := bridge.Account{ID: "live-send", Session: step.Session}
	conv := "user:" + step.Account // Saved Messages: the chat with oneself
	t.Log("signed in; sending only into Saved Messages")
	var made []string
	t.Cleanup(func() {
		c2, cancel2 := context.WithTimeout(context.Background(), time.Minute)
		defer cancel2()
		if len(made) > 0 {
			err := a.DeleteMessages(c2, acct, bridge.Delete{Conversation: conv, IDs: made})
			t.Logf("cleanup: deleted %d messages, err=%v", len(made), err)
		}
		t.Logf("logout err=%v", a.Logout(c2, acct))
	})
	sender := bridge.Sender(a)

	tag := fmt.Sprintf("[send spike %d]", time.Now().Unix())
	text := tag + " bold link"
	off := len([]rune(tag + " "))
	ents := []bridge.Entity{{Kind: "bold", Offset: off, Length: 4}, {Kind: "link", Offset: off + 5, Length: 4, URL: "https://example.com"}}

	// 1. text with styling, then the same random id again.
	first, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Text: text, Entities: ents, RandomID: 4242424242})
	if err != nil || len(first.IDs) != 1 {
		t.Fatalf("send text = %+v, %v", first, err)
	}
	made = append(made, first.IDs...)
	again, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Text: text, Entities: ents, RandomID: 4242424242})
	if err != nil || len(again.IDs) != 1 || again.IDs[0] != first.IDs[0] {
		t.Fatalf("the same random id gave %+v (%v), want the first message %v", again, err, first.IDs)
	}
	t.Logf("text: id %s; repeat with the same random id gave the same id", first.IDs[0])

	// 2. a reply, and a reply to a message that does not exist (sent plain).
	reply, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Text: tag + " reply", ReplyTo: first.IDs[0], RandomID: 4242424243})
	if err != nil || len(reply.IDs) != 1 {
		t.Fatalf("reply = %+v, %v", reply, err)
	}
	made = append(made, reply.IDs...)
	orphan, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Text: tag + " reply to nothing", ReplyTo: "1", RandomID: 4242424244})
	if err != nil || len(orphan.IDs) != 1 {
		t.Fatalf("reply to a missing message = %+v, %v; want it sent plain", orphan, err)
	}
	made = append(made, orphan.IDs...)
	t.Log("reply and reply-to-missing sent")

	// 3. edit: new text, then the same text (not an error).
	edit := bridge.EditRequest{Conversation: conv, ID: first.IDs[0], Text: tag + " edited", Entities: nil}
	if err := sender.EditMessage(ctx, acct, edit); err != nil {
		t.Fatalf("edit = %v", err)
	}
	if err := sender.EditMessage(ctx, acct, edit); err != nil {
		t.Fatalf("edit with the same text = %v, want nil", err)
	}
	t.Log("edit ok; edit with unchanged text ok")

	// 4. photo, file, album.
	pic := func(shade uint8) []byte {
		im := image.NewRGBA(image.Rect(0, 0, 96, 96))
		for x := 0; x < 96; x++ {
			for y := 0; y < 96; y++ {
				im.Set(x, y, color.RGBA{uint8(x * 2), uint8(y * 2), shade, 255})
			}
		}
		var b bytes.Buffer
		_ = png.Encode(&b, im)
		return b.Bytes()
	}
	media := func(kind, name, mime string, body []byte) bridge.OutMedia {
		return bridge.OutMedia{Kind: kind, MimeType: mime, Name: name, Size: int64(len(body)), Width: 96, Height: 96,
			Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }}
	}
	photo, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Text: tag + " photo",
		Media: []bridge.OutMedia{media("photo", "p.png", "image/png", pic(10))}, RandomID: 4242424250})
	if err != nil || len(photo.IDs) != 1 {
		t.Fatalf("photo = %+v, %v", photo, err)
	}
	made = append(made, photo.IDs...)
	doc, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Text: tag + " file",
		Media: []bridge.OutMedia{media("document", "ghi-chu.txt", "text/plain", []byte("xin chào từ Chat"))}, RandomID: 4242424251})
	if err != nil || len(doc.IDs) != 1 {
		t.Fatalf("file = %+v, %v", doc, err)
	}
	made = append(made, doc.IDs...)
	album := bridge.OutMessage{Conversation: conv, Text: tag + " album", RandomID: 4242424260, Media: []bridge.OutMedia{
		media("photo", "a1.png", "image/png", pic(60)), media("photo", "a2.png", "image/png", pic(160))}}
	al, err := sender.SendMessage(ctx, acct, album)
	if err != nil || len(al.IDs) != 2 {
		t.Fatalf("album = %+v, %v", al, err)
	}
	made = append(made, al.IDs...)
	t.Logf("photo, file and a two-photo album sent (album ids %v)", al.IDs)
	// Does a repeated album with the same random ids answer with the same messages?
	al2, err := sender.SendMessage(ctx, acct, album)
	if err != nil {
		t.Fatalf("repeated album: %v", err)
	}
	made = append(made, al2.IDs...)
	t.Logf("ALBUM DEDUPE: repeat answered ids %v (same as first: %v)", al2.IDs, fmt.Sprint(al2.IDs) == fmt.Sprint(al.IDs))

	// 5. too much text is refused before anything is sent.
	if _, err := sender.SendMessage(ctx, acct, bridge.OutMessage{Conversation: conv, Text: strings.Repeat("x", 5000), RandomID: 4242424270}); err == nil {
		t.Fatal("5000 characters were accepted")
	}
	t.Log("overlong text refused")
}

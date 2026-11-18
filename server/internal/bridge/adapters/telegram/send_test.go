package telegram

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

func TestOutEntitiesMapsTheKindsTelegramTakes(t *testing.T) {
	c := &conn{hashes: map[int64]int64{42: 777}}
	got := c.outEntities([]bridge.Entity{
		{Kind: "bold", Offset: 0, Length: 4},
		{Kind: "italic", Offset: 5, Length: 2},
		{Kind: "underline", Offset: 8, Length: 1},
		{Kind: "strike", Offset: 9, Length: 1},
		{Kind: "spoiler", Offset: 10, Length: 1},
		{Kind: "code", Offset: 11, Length: 3},
		{Kind: "pre", Offset: 14, Length: 5},
		{Kind: "link", Offset: 20, Length: 4, URL: "https://example.com"},
		{Kind: "url", Offset: 25, Length: 10},    // found by Telegram itself
		{Kind: "hashtag", Offset: 36, Length: 5}, // found by Telegram itself
		{Kind: "mention", Offset: 42, Length: 3, Mention: "42"},
		{Kind: "mention", Offset: 46, Length: 3, Mention: "99"},   // no access hash known: dropped
		{Kind: "mention", Offset: 50, Length: 3, Mention: "nope"}, // not a user id: dropped
		{Kind: "unheard-of", Offset: 54, Length: 1},
	})
	want := []string{"*tg.MessageEntityBold", "*tg.MessageEntityItalic", "*tg.MessageEntityUnderline", "*tg.MessageEntityStrike",
		"*tg.MessageEntitySpoiler", "*tg.MessageEntityCode", "*tg.MessageEntityPre", "*tg.MessageEntityTextURL", "*tg.InputMessageEntityMentionName"}
	if len(got) != len(want) {
		t.Fatalf("%d entities, want %d: %v", len(got), len(want), got)
	}
	for i, e := range got {
		if name := typeName(e); name != want[i] {
			t.Fatalf("entity %d = %s, want %s", i, name, want[i])
		}
	}
	link := got[7].(*tg.MessageEntityTextURL)
	if link.URL != "https://example.com" || link.Offset != 20 || link.Length != 4 {
		t.Fatalf("link = %+v", link)
	}
	mention := got[8].(*tg.InputMessageEntityMentionName)
	if u, ok := mention.UserID.(*tg.InputUser); !ok || u.UserID != 42 || u.AccessHash != 777 {
		t.Fatalf("mention = %+v, want user 42 with the access hash from the dialog list", mention)
	}
}

func typeName(e tg.MessageEntityClass) string {
	switch e.(type) {
	case *tg.MessageEntityBold:
		return "*tg.MessageEntityBold"
	case *tg.MessageEntityItalic:
		return "*tg.MessageEntityItalic"
	case *tg.MessageEntityUnderline:
		return "*tg.MessageEntityUnderline"
	case *tg.MessageEntityStrike:
		return "*tg.MessageEntityStrike"
	case *tg.MessageEntitySpoiler:
		return "*tg.MessageEntitySpoiler"
	case *tg.MessageEntityCode:
		return "*tg.MessageEntityCode"
	case *tg.MessageEntityPre:
		return "*tg.MessageEntityPre"
	case *tg.MessageEntityTextURL:
		return "*tg.MessageEntityTextURL"
	case *tg.InputMessageEntityMentionName:
		return "*tg.InputMessageEntityMentionName"
	}
	return "other"
}

func TestTranslateSendSortsErrorsByWhatTheEngineDoes(t *testing.T) {
	cases := []struct {
		rpc      string
		code     int
		is       error
		floodFor time.Duration
	}{
		{rpc: "CHAT_WRITE_FORBIDDEN", code: 403, is: bridge.ErrNotAllowed},
		{rpc: "CHAT_ADMIN_REQUIRED", code: 400, is: bridge.ErrNotAllowed},
		{rpc: "USER_IS_BLOCKED", code: 400, is: bridge.ErrNotAllowed},
		{rpc: "MESSAGE_AUTHOR_REQUIRED", code: 403, is: bridge.ErrNotAllowed},
		{rpc: "MESSAGE_EDIT_TIME_EXPIRED", code: 400, is: bridge.ErrEditExpired},
		{rpc: "MEDIA_CAPTION_TOO_LONG", code: 400, is: bridge.ErrTooLarge},
		{rpc: "AUTH_KEY_UNREGISTERED", code: 401, is: bridge.ErrSessionRevoked},
		{rpc: "SESSION_REVOKED", code: 401, is: bridge.ErrSessionRevoked},
		{rpc: "FLOOD_WAIT_7", code: 420, floodFor: 7 * time.Second},
		{rpc: "SLOWMODE_WAIT_12", code: 420, floodFor: 12 * time.Second},
	}
	for _, c := range cases {
		err := translateSend(tgerr.New(c.code, c.rpc))
		if c.floodFor > 0 {
			var limit *bridge.RateLimitError
			if !errors.As(err, &limit) || limit.RetryAfter != c.floodFor {
				t.Errorf("%s = %v, want a rate limit of %v", c.rpc, err, c.floodFor)
			}
			continue
		}
		if !errors.Is(err, c.is) {
			t.Errorf("%s = %v, want %v", c.rpc, err, c.is)
		}
	}
	// What is not known is returned as it is, to be tried again.
	plain := errors.New("connection reset")
	if got := translateSend(plain); got != plain {
		t.Errorf("an unknown error = %v, want it unchanged", got)
	}
	if translateSend(nil) != nil {
		t.Error("nil must stay nil")
	}
	for _, kind := range []error{bridge.ErrNotAllowed, bridge.ErrEditExpired, bridge.ErrTooLarge} {
		if errors.Is(translateSend(tgerr.New(400, "SOMETHING_NEW")), kind) {
			t.Errorf("an unknown rpc error was taken for %v: it must be retried, not failed for good", kind)
		}
	}
}

func TestSentRefReadsTheIDsOfEveryShapeOfAnswer(t *testing.T) {
	// A private chat is answered with a short update.
	ref, err := sentRef(&tg.UpdateShortSentMessage{ID: 55, Date: 1700000000}, []int64{9})
	if err != nil || len(ref.IDs) != 1 || ref.IDs[0] != "55" || ref.Date.Unix() != 1700000000 {
		t.Fatalf("short answer = %+v, %v", ref, err)
	}
	// A message is matched to its random id.
	ref, err = sentRef(&tg.Updates{Date: 1700000001, Updates: []tg.UpdateClass{
		&tg.UpdateMessageID{ID: 60, RandomID: 9},
	}}, []int64{9})
	if err != nil || len(ref.IDs) != 1 || ref.IDs[0] != "60" {
		t.Fatalf("answer = %+v, %v", ref, err)
	}
	// An album gives ids in the order of the random ids, whatever order they come in.
	ref, err = sentRef(&tg.Updates{Updates: []tg.UpdateClass{
		&tg.UpdateMessageID{ID: 72, RandomID: 101},
		&tg.UpdateMessageID{ID: 71, RandomID: 100},
	}}, []int64{100, 101})
	if err != nil || strings.Join(ref.IDs, ",") != "71,72" {
		t.Fatalf("album answer = %+v, %v; want the ids in the order sent", ref, err)
	}
	// Without the random-id updates, the messages this account created are used.
	ref, err = sentRef(&tg.Updates{Updates: []tg.UpdateClass{
		&tg.UpdateNewMessage{Message: &tg.Message{ID: 80, Out: true}},
		&tg.UpdateNewMessage{Message: &tg.Message{ID: 81, Out: false}},
	}}, []int64{5})
	if err != nil || strings.Join(ref.IDs, ",") != "80" {
		t.Fatalf("fallback answer = %+v, %v", ref, err)
	}
	if _, err := sentRef(&tg.Updates{}, []int64{5}); err == nil {
		t.Fatal("an answer naming no message must not be taken for a send")
	}
	if _, err := sentRef(&tg.UpdatesTooLong{}, []int64{5}); err == nil {
		t.Fatal("an unexpected answer must be an error")
	}
}

func TestOverlongTextIsRefusedBeforeAnythingIsSent(t *testing.T) {
	a := New(Config{})
	_, err := a.SendMessage(context.Background(), bridge.Account{}, bridge.OutMessage{Conversation: "user:1", Text: strings.Repeat("a", textMax+1)})
	if !errors.Is(err, bridge.ErrTooLarge) {
		t.Fatalf("a message over %d characters = %v, want ErrTooLarge", textMax, err)
	}
	_, err = a.SendMessage(context.Background(), bridge.Account{}, bridge.OutMessage{Conversation: "user:1", Text: strings.Repeat("a", captionMax+1),
		Media: []bridge.OutMedia{{Kind: "document"}}})
	if !errors.Is(err, bridge.ErrTooLarge) {
		t.Fatalf("a caption over %d characters = %v, want ErrTooLarge", captionMax, err)
	}
	// Characters outside the first plane count as two units, as in Telegram.
	_, err = a.SendMessage(context.Background(), bridge.Account{}, bridge.OutMessage{Conversation: "user:1", Text: strings.Repeat("😀", textMax/2+1)})
	if !errors.Is(err, bridge.ErrTooLarge) {
		t.Fatalf("emoji over the limit in UTF-16 units = %v, want ErrTooLarge", err)
	}
}

func TestSendsAnAdapterThatSaysSo(t *testing.T) {
	a := New(Config{})
	if !a.Capabilities().Has(bridge.CapSend) {
		t.Fatal("the adapter implements Sender and must declare CapSend")
	}
}

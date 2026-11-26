package engine_test

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

func TestMentionsOfTheOwnerFollowTheOtherAppAndSeeingOneInChatTellsIt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	// A live message that mentions the owner arrives unread.
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1), e.msg("m2", lan, "tin 2", 2))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	m3 := e.msg("m3", lan, "@tôi xem nhé", 3)
	m3.Conversation, m3.Mention = "g1", bridge.MentionUnread
	e.fake.Push(bridge.Event{Message: &m3})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "@tôi xem nhé"})
	unread := func() []int64 {
		seqs, err := e.chat.GetUnreadMentions(ctx, e.owner, chatID, 0)
		if err != nil {
			t.Fatal(err)
		}
		return seqs
	}
	if got := unread(); !slices.Equal(got, []int64{e.seqOf(chatID, "m3")}) {
		t.Fatalf("unread mentions = %v", got)
	}
	// The other app says the owner saw m3 there but not m1 (read past without seeing it).
	e.fake.SetUnreadMentions("g1", "m1")
	want := []int64{e.seqOf(chatID, "m1")}
	e.eventually(func() bool { return slices.Equal(unread(), want) }, func() string { return fmt.Sprintf("unread = %v, want %v", unread(), want) })
	// Seeing m1 in Chat tells the other app, in a chat that sends back.
	if err := e.chat.SetImportedDirection(ctx, e.owner, chatID, chat.DirectionBoth); err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.ReadMentions(ctx, e.owner, chatID, want); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.UnreadMentionsOf("g1")) == 0 },
		func() string { return fmt.Sprintf("the other app still has %v", e.fake.UnreadMentionsOf("g1")) })
	if got := unread(); len(got) != 0 {
		t.Fatalf("unread mentions after seeing it = %v", got)
	}
}

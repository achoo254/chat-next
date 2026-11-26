package chat

import (
	"context"
	"slices"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// A rendered mention shows the user's profile: a sender may mention only
// users it shares a chat or a contact with, in every write path.
func TestMentionsOnlyOfRelatedUsers(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, stranger := h.user("alice"), h.user("bob"), h.user("hidden")
	chatID := h.group(a, b)
	mention := func(id int64) []*appv1.MessageEntity {
		return []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_MENTION_NAME, Offset: 0, Length: 3, UserId: id}}
	}

	if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: "Bob", Entities: mention(b)}); err != nil {
		t.Fatalf("mention of a chat member: %v", err)
	}
	if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: "Who", Entities: mention(stranger)}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("mention of an unrelated user: %v", err)
	}
	sent := h.send(a, chatID, "hey")
	if _, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: sent.GetMessage().GetSeq(), Text: "Who",
		Entities: mention(stranger)}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("edit adding a mention of an unrelated user: %v", err)
	}
	if _, err := h.svc.CopyMessage(ctx, a, &appv1.CopyMessageRequest{FromChatId: chatID, Seq: sent.GetMessage().GetSeq(), ToChatId: chatID,
		Text: new("Who"), Entities: mention(stranger)}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("copy with a mention of an unrelated user: %v", err)
	}

	// Integrations mention members of their chat only.
	err := h.svc.WithIntegration(ctx, chatID, nil, func(it *IntegrationTx) error {
		_, err := it.Post(ctx, IntegrationMessage{Label: "CI", Text: "Who", Entities: mention(stranger)})
		return err
	})
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("integration mention of a non-member: %v", err)
	}
	err = h.svc.WithIntegration(ctx, chatID, nil, func(it *IntegrationTx) error {
		_, err := it.Post(ctx, IntegrationMessage{Label: "CI", Text: "Bob", Entities: mention(b)})
		return err
	})
	if err != nil {
		t.Fatalf("integration mention of a member: %v", err)
	}
}

// unreadMentions is the dialog's count of the user's unread mentions.
func (h *harness) unreadMentions(user, chatID int64) int32 {
	h.t.Helper()
	d, err := h.svc.GetPeerDialogs(context.Background(), user, []int64{chatID})
	if err != nil || len(d.GetDialogs()) != 1 {
		h.t.Fatalf("dialogs = %v, %v", d, err)
	}
	return d.GetDialogs()[0].GetUnreadMentionsCount()
}

func TestAMentionStaysUnreadUntilSeenAndTheButtonWalksThemOldestFirst(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("alice"), h.user("bob")
	chatID := h.group(a, b)
	mine := h.send(b, chatID, "bob's question").GetMessage().GetSeq()
	first := h.send(a, chatID, "chào").GetMessage().GetSeq()
	reply, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: "trả lời", ReplyToSeq: mine})
	if err != nil {
		t.Fatal(err)
	}
	at, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: "hi @bob",
		Entities: []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_MENTION, Offset: 3, Length: 4}}})
	if err != nil {
		t.Fatal(err)
	}
	r, at2 := reply.GetMessage().GetSeq(), at.GetMessage().GetSeq()
	seqs, err := h.svc.GetUnreadMentions(ctx, b, chatID, 0)
	if err != nil || !slices.Equal(seqs, []int64{r, at2}) {
		t.Fatalf("unread mentions = %v, %v, want %v", seqs, err, []int64{r, at2})
	}
	// Reading on up to the first message clears nothing it did not pass.
	if _, err := h.svc.ReadHistory(ctx, b, chatID, first, 0); err != nil {
		t.Fatal(err)
	}
	if n := h.unreadMentions(b, chatID); n != 2 {
		t.Fatalf("mentions = %d, want 2", n)
	}
	// Opening the reply from the "@" button reads it, and the session hears the count.
	if _, err := h.svc.ReadMentions(ctx, b, chatID, []int64{r}); err != nil {
		t.Fatal(err)
	}
	log := h.logOf(b)
	if got := log[len(log)-1].GetRead(); got == nil || got.GetUnreadMentionsCount() != 1 || got.GetMaxSeq() != first {
		t.Fatalf("last update = %v, want an inbox read at %d with one mention left", log[len(log)-1], first)
	}
	// An edit that keeps the mention keeps it read; the one left is still unread.
	if _, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: r, Text: "trả lời lại"}); err != nil {
		t.Fatal(err)
	}
	if seqs, _ := h.svc.GetUnreadMentions(ctx, b, chatID, 0); !slices.Equal(seqs, []int64{at2}) {
		t.Fatalf("unread mentions after the edit = %v, want %v", seqs, []int64{at2})
	}
	if _, err := h.svc.ReadMentions(ctx, a, chatID, nil); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("no seqs: %v", err)
	}
}

func TestAnImportedMentionFollowsWhatTheOtherAppSays(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	t0 := time.Now().Add(-time.Hour).Truncate(time.Second)
	var seqs []int64
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		// History: the import reads the chat, but a mention the owner has not seen stays.
		seqs, err = it.Append(ctx, []ImportMessage{
			{FromID: pup, Date: t0, Text: "một", OwnerMention: MentionRead},
			{FromID: pup, Date: t0.Add(time.Minute), Text: "hai", OwnerMention: MentionUnread},
			{FromID: pup, Date: t0.Add(2 * time.Minute), Text: "ba", OwnerMention: MentionNone},
		})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.svc.GetUnreadMentions(ctx, owner, chatID, 0); !slices.Equal(got, []int64{seqs[1]}) {
		t.Fatalf("unread mentions = %v, want %v", got, seqs[1:2])
	}
	// The other app counts differently now: the first is unread, the second seen there.
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		changed, err := it.SetOwnerMentions(ctx, []int64{seqs[0], seqs[2]}, false)
		if err == nil && !changed {
			t.Error("nothing changed")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.svc.GetUnreadMentions(ctx, owner, chatID, 0); !slices.Equal(got, []int64{seqs[0], seqs[2]}) {
		t.Fatalf("unread mentions = %v, want %v", got, []int64{seqs[0], seqs[2]})
	}
	if n := h.unreadMentions(owner, chatID); n != 2 {
		t.Fatalf("count = %d, want 2", n)
	}
}

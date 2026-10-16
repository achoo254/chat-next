package chat

import (
	"context"
	"testing"

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

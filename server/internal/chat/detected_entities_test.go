package chat

import (
	"context"
	"slices"
	"testing"
	"unicode/utf16"

	appv1 "app.local/server/gen/app/v1"
)

// entityTexts returns "type:text" for each entity, in order.
func entityTexts(text string, ents []*appv1.MessageEntity) []string {
	units := utf16.Encode([]rune(text))
	out := make([]string, 0, len(ents))
	for _, e := range ents {
		end := int(e.GetOffset() + e.GetLength())
		if end > len(units) {
			out = append(out, e.GetType().String()+":<out of range>")
			continue
		}
		out = append(out, e.GetType().String()+":"+string(utf16.Decode(units[e.GetOffset():end])))
	}
	return out
}

// A plain message gets url, email, mention and hashtag entities whoever
// writes it; the sender's own entities stay as they are, and a mention
// detected this way counts for the mentioned member.
func TestPlainTextGetsDetectedEntities(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("alice"), h.user("bobby")
	var bName string
	if err := h.st.Pool().QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, b).Scan(&bName); err != nil {
		t.Fatal(err)
	}
	chatID := h.group(a, b)

	text := "🎬 Hỏi @" + bName + " #ĐàLạt, xem hoandat.com hoặc gửi an@hoandat.vn"
	first, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: text, NoLinkPreview: true})
	if err != nil {
		t.Fatal(err)
	}
	sent := first.GetMessage()
	want := []string{
		"ENTITY_TYPE_MENTION:@" + bName, "ENTITY_TYPE_HASHTAG:#ĐàLạt",
		"ENTITY_TYPE_URL:hoandat.com", "ENTITY_TYPE_EMAIL:an@hoandat.vn",
	}
	if got := entityTexts(sent.GetText(), sent.GetEntities()); !slices.Equal(got, want) {
		t.Fatalf("entities = %v, want %v", got, want)
	}
	var mentioned int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM message_mentions WHERE user_id = $1 AND chat_id = $2 AND seq = $3`,
		b, chatID, sent.GetSeq()).Scan(&mentioned); err != nil {
		t.Fatal(err)
	}
	if mentioned != 1 {
		t.Fatalf("detected @%s recorded %d mentions", bName, mentioned)
	}

	// Sender entities first and unchanged; nothing is detected inside code,
	// a URL inside bold still is.
	code, bold := "run @"+bName, "https://hoandat.com/x"
	resp, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: chatID, Text: code + " " + bold, NoLinkPreview: true,
		Entities: []*appv1.MessageEntity{
			{Type: appv1.EntityType_ENTITY_TYPE_CODE, Offset: 0, Length: int32(len(code))},
			{Type: appv1.EntityType_ENTITY_TYPE_BOLD, Offset: int32(len(code) + 1), Length: int32(len(bold))},
		}})
	if err != nil {
		t.Fatal(err)
	}
	got := entityTexts(resp.GetMessage().GetText(), resp.GetMessage().GetEntities())
	want = []string{"ENTITY_TYPE_CODE:run @" + bName, "ENTITY_TYPE_BOLD:https://hoandat.com/x", "ENTITY_TYPE_URL:https://hoandat.com/x"}
	if !slices.Equal(got, want) {
		t.Fatalf("with sender entities = %v, want %v", got, want)
	}

	// Editing to the same plain text (as the composer sends it, without
	// entities) is no edit: detection gives the same entities.
	plain := h.send(a, chatID, "@"+bName+" #vui").GetMessage()
	edited, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: plain.GetSeq(), Text: plain.GetText(), NoLinkPreview: true})
	if err != nil {
		t.Fatal(err)
	}
	if edited.GetMessage().GetEditDate() != 0 {
		t.Fatalf("an unchanged edit was recorded: %v", edited.GetMessage())
	}

	// The total stays within entitiesMax.
	many := ""
	for range entitiesMax + 10 {
		many += "#a "
	}
	if got := h.send(a, chatID, many).GetMessage().GetEntities(); len(got) != entitiesMax {
		t.Fatalf("%d entities, want %d", len(got), entitiesMax)
	}
}

// Integrations (incoming webhooks) get the same detection.
func TestIntegrationTextGetsDetectedEntities(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a := h.user("alice")
	chatID := h.group(a)
	err := h.svc.WithIntegration(ctx, chatID, nil, func(it *IntegrationTx) error {
		_, err := it.Post(ctx, IntegrationMessage{Label: "CI", Text: "Deploy ok https://ci.hoandat.com/318 #release", Silent: true})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	history, err := h.svc.GetHistory(ctx, a, &appv1.GetHistoryRequest{ChatId: chatID, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	posted := history.GetMessages()[0]
	want := []string{"ENTITY_TYPE_URL:https://ci.hoandat.com/318", "ENTITY_TYPE_HASHTAG:#release"}
	if got := entityTexts(posted.GetText(), posted.GetEntities()); !slices.Equal(got, want) {
		t.Fatalf("entities = %v, want %v", got, want)
	}
}

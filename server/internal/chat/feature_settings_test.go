package chat

import (
	"context"
	"testing"
	"time"

	"app.local/server/internal/bridge/feature"
)

func TestEveryFeatureOfALinkedChatFollowsItsDirection(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	both := h.group(owner)
	h.linkChat(owner, both, DirectionBoth)
	reads := h.group(owner)
	h.linkChat(owner, reads, DirectionIn)
	for chatID, want := range map[int64]feature.Direction{both: feature.Both, reads: feature.In} {
		got, err := h.svc.ImportedFeatures(ctx, owner, chatID)
		if err != nil {
			t.Fatal(err)
		}
		if got[feature.Pins].Direction != want || !got[feature.Pins].Default || got[feature.Messages].Direction != want {
			t.Fatalf("pins %+v, messages %+v; want both to follow %s", got[feature.Pins], got[feature.Messages], want)
		}
		// One switch (ADR 0024): acting on people follows the chat too; its guard rails
		// are at each action.
		if got[feature.Members].Direction != want || got[feature.Typing].Direction != want {
			t.Fatalf("people and typing are %s and %s, want %s", got[feature.Members].Direction, got[feature.Typing].Direction, want)
		}
	}
}

func TestAFeatureSetOnItsOwnOverridesTheMessagesForThatFeatureOnly(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	seq := h.send(owner, chatID, "tin").GetMessage().GetSeq()

	// pins off: pinning in Chat stays in Chat, messages still go out
	if err := h.svc.SetImportedFeature(ctx, owner, chatID, feature.Pins, feature.In); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.PinMessage(ctx, owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	if rows := h.outboxRows(chatID, seq); !equalStrings(rows, []string{"send:pending"}) {
		t.Fatalf("outbox = %v, want only the send: pins only come in", rows)
	}
	// pins out again: the next pin is queued, under its feature
	if err := h.svc.SetImportedFeature(ctx, owner, chatID, feature.Pins, feature.Both); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.UnpinMessage(ctx, owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	var feat string
	if err := h.st.Pool().QueryRow(ctx, `SELECT feature FROM external_outbox WHERE chat_id = $1 AND seq = $2 AND op = 'pin_message'`, chatID, seq).Scan(&feat); err != nil || feat != "pins" {
		t.Fatalf("pin row feature = %q (%v), want pins", feat, err)
	}
	// a chat that only reads can send its pins on when the owner says so
	reads := h.group(owner)
	h.linkChat(owner, reads, DirectionIn)
	var imported []int64
	if err := h.importInto(reads, owner, func(it *ImportTx) error {
		var err error
		imported, err = it.Append(ctx, []ImportMessage{{FromID: owner, Date: time.Now(), Text: "x"}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	pseq := imported[0]
	if err := h.svc.SetImportedFeature(ctx, owner, reads, feature.Pins, feature.Both); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.PinMessage(ctx, owner, reads, pseq); err != nil {
		t.Fatal(err)
	}
	if rows := h.outboxRows(reads, pseq); !equalStrings(rows, []string{"pin_message:pending"}) {
		t.Fatalf("outbox of a reading chat = %v, want the pin queued", rows)
	}
}

func TestTurningAFeatureSoItNoLongerSendsCancelsWhatItQueued(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	seq := h.send(owner, chatID, "tin").GetMessage().GetSeq()
	if _, err := h.svc.PinMessage(ctx, owner, chatID, seq); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.SetImportedFeature(ctx, owner, chatID, feature.Pins, feature.Off); err != nil {
		t.Fatal(err)
	}
	if rows := h.outboxRows(chatID, seq); !equalStrings(rows, []string{"send:pending", "pin_message:cancelled"}) {
		t.Fatalf("outbox = %v, want the pin cancelled and the send kept", rows)
	}
}

func TestSettingAFeatureIsCheckedAndOnlyForTheOwner(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, other := h.user("owner"), h.user("other")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	for _, tc := range []struct {
		who  int64
		f    feature.Feature
		d    feature.Direction
		name string
	}{
		{owner, "nope", feature.Both, "an unknown feature"},
		{owner, feature.Pins, "sideways", "an unknown direction"},
		{owner, feature.Messages, feature.Off, "messages switched off"},
		{other, feature.Pins, feature.Both, "somebody else's chat"},
	} {
		if err := h.svc.SetImportedFeature(ctx, tc.who, chatID, tc.f, tc.d); err == nil {
			t.Errorf("%s was accepted", tc.name)
		}
	}
	// messages go through the direction they always had
	if err := h.svc.SetImportedFeature(ctx, owner, chatID, feature.Messages, feature.In); err != nil {
		t.Fatal(err)
	}
	var d string
	if err := h.st.Pool().QueryRow(ctx, `SELECT direction FROM external_chats WHERE chat_id = $1`, chatID).Scan(&d); err != nil || d != "in" {
		t.Fatalf("messages direction = %q (%v), want in", d, err)
	}
}

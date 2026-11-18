package chat

import (
	"context"
	"testing"
)

func TestTheOtherAppsTitleAndDescriptionReplaceTheChatsAndNoMessageIsMadeUp(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionIn)
	var changed, again bool
	var before int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM messages WHERE chat_id = $1`, chatID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		if changed, err = it.SetInfo(ctx, "Tên từ app kia", "Mô tả từ app kia"); err != nil {
			return err
		}
		again, err = it.SetInfo(ctx, "Tên từ app kia", "Mô tả từ app kia")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if !changed || again {
		t.Fatalf("changed = %v, repeated = %v, want true then false", changed, again)
	}
	var title, about string
	var messages int
	if err := h.st.Pool().QueryRow(ctx, `SELECT title, about, (SELECT count(*) FROM messages WHERE chat_id = $1) FROM chats WHERE id = $1`, chatID).Scan(&title, &about, &messages); err != nil {
		t.Fatal(err)
	}
	if title != "Tên từ app kia" || about != "Mô tả từ app kia" {
		t.Fatalf("info = %q / %q", title, about)
	}
	if messages != before {
		t.Fatalf("%d messages after a change of info from the other app, %d before: one was made up", messages, before)
	}
	// an unusable title keeps the old one
	if err := h.importInto(chatID, owner, func(it *ImportTx) error { _, err := it.SetInfo(ctx, "   ", "Mô tả khác"); return err }); err != nil {
		t.Fatal(err)
	}
	if err := h.st.Pool().QueryRow(ctx, `SELECT title, about FROM chats WHERE id = $1`, chatID).Scan(&title, &about); err != nil || title != "Tên từ app kia" || about != "Mô tả khác" {
		t.Fatalf("after an empty title: %q / %q (%v)", title, about, err)
	}
}

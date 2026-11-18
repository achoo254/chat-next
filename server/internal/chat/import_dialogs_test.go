package chat

import (
	"context"
	"testing"
	"time"

	"app.local/server/internal/bridge/feature"
)

func (h *harness) ownerDialog(chatID, owner int64) (mute int64, pinned, unread bool) {
	h.t.Helper()
	if err := h.st.Pool().QueryRow(context.Background(), `
		SELECT coalesce(mute_until, 0), pin_rank IS NOT NULL, unread_mark FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
		chatID, owner).Scan(&mute, &pinned, &unread); err != nil {
		h.t.Fatal(err)
	}
	return
}

func (h *harness) queuedOps(chatID int64) []string {
	h.t.Helper()
	rows, err := h.st.Pool().Query(context.Background(), `SELECT op || ':' || feature || ':' || status FROM external_outbox WHERE chat_id = $1 AND seq = 0 ORDER BY id`, chatID)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func TestTheOtherAppsStateOfAChatSetsTheOwnersMuteUnreadMarkAndPinWithoutQueueingAnything(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	until := time.Now().Add(time.Hour).Unix()
	var changed [3]bool
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		if changed[0], err = it.SetOwnerMute(ctx, until); err != nil {
			return err
		}
		if changed[1], err = it.SetOwnerUnreadMark(ctx, true); err != nil {
			return err
		}
		changed[2], err = it.SetOwnerDialogPinned(ctx, true)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if changed != [3]bool{true, true, true} {
		t.Fatalf("changed = %v, want all three", changed)
	}
	if m, p, u := h.ownerDialog(chatID, owner); m != until || !p || !u {
		t.Fatalf("owner state = %d %v %v", m, p, u)
	}
	if rows := h.queuedOps(chatID); len(rows) != 0 {
		t.Fatalf("a change that came from the other app was queued to go back: %v", rows)
	}
	// the same state again changes nothing, and a mute that ended counts as not muted
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		a, _ := it.SetOwnerMute(ctx, until)
		b, _ := it.SetOwnerUnreadMark(ctx, true)
		c, _ := it.SetOwnerDialogPinned(ctx, true)
		if a || b || c {
			t.Errorf("repeating a state reported changes: %v %v %v", a, b, c)
		}
		d, err := it.SetOwnerMute(ctx, 0)
		if err != nil || !d {
			t.Errorf("unmuting = %v, %v", d, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPinningMoreChatsThanChatAllowsIsRefusedAndTheOthersStay(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	var chats []int64
	for i := 0; i < pinnedDialogsMax+1; i++ {
		c := h.group(owner)
		h.linkChat(owner, c, DirectionIn)
		chats = append(chats, c)
	}
	for i, c := range chats {
		err := h.importInto(c, owner, func(it *ImportTx) error { _, err := it.SetOwnerDialogPinned(ctx, true); return err })
		if (i < pinnedDialogsMax) != (err == nil) {
			t.Fatalf("pin %d: err = %v", i, err)
		}
	}
}

func TestMuteUnreadMarkAndPinSetInChatAreQueuedForTheAppAsTheStateWantedUnderTheirFeature(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.linkChat(owner, chatID, DirectionBoth)
	if _, err := h.svc.SetDialogMute(ctx, owner, chatID, 3600, false); err != nil {
		t.Fatal(err)
	}
	for _, on := range []bool{true, false, true} {
		if _, err := h.svc.SetDialogPinned(ctx, owner, chatID, on); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.svc.SetDialogUnreadMark(ctx, owner, chatID, true); err != nil {
		t.Fatal(err)
	}
	want := []string{"set_mute:notify:pending", "set_dialog_pin:dialog:pending", "set_unread_mark:dialog:pending"}
	if got := h.queuedOps(chatID); !equalStrings(got, want) {
		t.Fatalf("queued = %v, want %v (one row per kind: the last state replaces the earlier)", got, want)
	}
	// switched off, nothing more is queued
	if err := h.svc.SetImportedFeature(ctx, owner, chatID, feature.Dialog, feature.In); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetDialogPinned(ctx, owner, chatID, false); err != nil {
		t.Fatal(err)
	}
	if got := h.queuedOps(chatID); !equalStrings(got, []string{"set_mute:notify:pending", "set_dialog_pin:dialog:cancelled", "set_unread_mark:dialog:cancelled"}) {
		t.Fatalf("queued = %v, want the dialog rows cancelled and no new one", got)
	}
}

package chat

import (
	"context"
	"testing"
	"time"
)

func TestImportSetPinnedPinsAndUnpinsWithoutAServiceMessage(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	old := time.Now().Add(-30 * 24 * time.Hour)
	var seqs []int64
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		seqs, err = it.Append(ctx, []ImportMessage{{FromID: pup, Date: old, Text: "một"}, {FromID: pup, Date: old, Text: "hai"}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	state := func() (pins, total int, top int64) {
		pool := h.st.Pool()
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pinned_messages WHERE chat_id = $1`, chatID).Scan(&pins); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE chat_id = $1`, chatID).Scan(&total); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT pinned_seq FROM chats WHERE id = $1`, chatID).Scan(&top); err != nil {
			t.Fatal(err)
		}
		return
	}
	set := func(seq int64, pinned bool) bool {
		var changed bool
		if err := h.importInto(chatID, owner, func(it *ImportTx) error {
			var err error
			changed, err = it.SetPinned(ctx, seq, pinned)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return changed
	}

	_, before, _ := state()
	if !set(seqs[0], true) || !set(seqs[1], true) {
		t.Fatal("pinning two live messages changed nothing")
	}
	if pins, total, top := state(); pins != 2 || total != before || top != seqs[1] {
		t.Fatalf("after pinning: %d pins, %d messages, pinned_seq %d; want 2, %d (no service message), %d", pins, total, top, before, seqs[1])
	}
	if set(seqs[0], true) {
		t.Fatal("pinning a pinned message reported a change")
	}
	if !set(seqs[1], false) {
		t.Fatal("unpinning a pinned message changed nothing")
	}
	if set(seqs[1], false) {
		t.Fatal("unpinning a message that is not pinned reported a change")
	}
	if pins, _, top := state(); pins != 1 || top != seqs[0] {
		t.Fatalf("after unpinning: %d pins, pinned_seq %d; want 1, %d", pins, top, seqs[0])
	}
	if set(9999, true) {
		t.Fatal("pinning a message that does not exist reported a change")
	}
}

func TestImportSetPinnedSkipsServiceMessages(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	var seqs []int64
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		seqs, err = it.Append(ctx, []ImportMessage{{FromID: pup, Text: "ghim tôi"}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// The service message the real PinMessage posts is itself never pinnable.
	if _, err := h.svc.PinMessage(ctx, owner, chatID, seqs[0], false); err != nil {
		t.Fatal(err)
	}
	var serviceSeq int64
	if err := h.st.Pool().QueryRow(ctx, `SELECT max(seq) FROM messages WHERE chat_id = $1`, chatID).Scan(&serviceSeq); err != nil || serviceSeq == seqs[0] {
		t.Fatalf("no service message was posted (%v)", err)
	}
	var changed bool
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		changed, err = it.SetPinned(ctx, serviceSeq, true)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("a service message was pinned")
	}
}

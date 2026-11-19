package chat

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestImportSetReactionsFollowsTheOtherAppAndLeavesWhatItDoesNotSay(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	member := h.user("member") // a Chat user, not of the other app
	chatID := h.group(owner, member)
	lan := h.puppet(chatID, "lan")
	minh := h.puppet(chatID, "minh")
	var seq int64
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		seqs, err := it.Append(ctx, []ImportMessage{{FromID: lan, Date: time.Now().Add(-time.Hour), Text: "một"}})
		seq = seqs[0]
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetReaction(ctx, member, chatID, seq, "🙂"); err != nil {
		t.Fatal(err)
	}
	names := map[int64]string{owner: "owner", member: "member", lan: "lan", minh: "minh"}
	state := func() string {
		rows, err := h.st.Pool().Query(ctx, `SELECT user_id, emoji FROM message_reactions WHERE chat_id = $1 AND seq = $2 ORDER BY user_id`, chatID, seq)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string]string{}
		for rows.Next() {
			var id int64
			var e string
			if err := rows.Scan(&id, &e); err != nil {
				t.Fatal(err)
			}
			got[names[id]] = e
		}
		return fmt.Sprint(got)
	}
	set := func(want []ImportedReaction, complete, keepOwner bool) bool {
		var changed bool
		if err := h.importInto(chatID, owner, func(it *ImportTx) error {
			var err error
			changed, err = it.SetReactions(ctx, seq, want, complete, keepOwner)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return changed
	}

	if !set([]ImportedReaction{{lan, "👍"}, {owner, "❤"}, {minh, "not one emoji"}}, true, false) {
		t.Fatal("setting reactions changed nothing")
	}
	if got := state(); got != "map[lan:👍 member:🙂 owner:❤]" {
		t.Fatalf("after a complete list: %s (the Chat user keeps theirs, a bad emoji is skipped)", got)
	}
	if set([]ImportedReaction{{lan, "👍"}, {owner, "❤"}}, true, false) {
		t.Fatal("repeating the same reactions reported a change")
	}
	// a partial list adds and changes, removes nobody
	if !set([]ImportedReaction{{minh, "😂"}}, false, false) {
		t.Fatal("a partial list changed nothing")
	}
	if got := state(); got != "map[lan:👍 member:🙂 minh:😂 owner:❤]" {
		t.Fatalf("after a partial list: %s", got)
	}
	// keepOwner: the owner is neither changed nor removed
	set([]ImportedReaction{{owner, "🔥"}}, true, true)
	if got := state(); got != "map[member:🙂 owner:❤]" {
		t.Fatalf("after a complete list that keeps the owner: %s", got)
	}
	// without it, an owner not listed loses theirs
	set(nil, true, false)
	if got := state(); got != "map[member:🙂]" {
		t.Fatalf("after an empty complete list: %s", got)
	}
}

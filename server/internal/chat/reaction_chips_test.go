package chat

import (
	"context"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

func usersIn(users []*appv1.User) []int64 {
	var ids []int64
	for _, u := range users {
		ids = append(ids, u.GetId())
	}
	return ids
}

func TestReactionChipsCarryRecentReactors(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	author, b, c, d, e := h.user("author"), h.user("b"), h.user("c"), h.user("d"), h.user("e")
	chatID := h.group(author, b, c, d, e)
	seq := h.send(author, chatID, "react").GetMessage().GetSeq()
	for _, u := range []int64{b, c, d, e} {
		if _, err := h.svc.SetReaction(ctx, u, chatID, seq, "👍"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.svc.SetReaction(ctx, author, chatID, seq, "🔥"); err != nil {
		t.Fatal(err)
	}

	resp, err := h.svc.GetHistory(ctx, author, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil {
		t.Fatal(err)
	}
	var msg *appv1.Message
	for _, m := range resp.GetMessages() {
		if m.GetSeq() == seq {
			msg = m
		}
	}
	chips := msg.GetReactions()
	if len(chips) != 2 || chips[0].GetEmoji() != "👍" || chips[0].GetCount() != 4 {
		t.Fatalf("chips = %v", chips)
	}
	// Up to three, newest first.
	if got := chips[0].GetRecentUserIds(); !slices.Equal(got, []int64{e, d, c}) {
		t.Fatalf("recent 👍 = %v", got)
	}
	if got := chips[1].GetRecentUserIds(); !slices.Equal(got, []int64{author}) || !chips[1].GetChosen() {
		t.Fatalf("recent 🔥 = %v", chips[1])
	}
	// Their users come with the page, so avatars need no second call.
	for _, id := range []int64{e, d, c} {
		if !slices.Contains(usersIn(resp.GetUsers()), id) {
			t.Fatalf("reactor %d missing from users %v", id, usersIn(resp.GetUsers()))
		}
	}

	// The realtime reaction update and its log entry carry them as well.
	h.drain()
	if _, err := h.svc.SetReaction(ctx, b, chatID, seq, "👍"); err != nil {
		t.Fatal(err) // no change: b already reacted with it
	}
	if _, err := h.svc.SetReaction(ctx, b, chatID, seq, "🔥"); err != nil {
		t.Fatal(err)
	}
	h.drain()
	var frame *appv1.UpdateFrame
	for _, f := range h.sink.frames[author] {
		for _, u := range f.GetUpdates() {
			if r := u.GetReaction(); r != nil && r.GetSeq() == seq {
				frame = f
			}
		}
	}
	if frame == nil {
		t.Fatal("no realtime reaction")
	}
	r := frame.GetUpdates()[len(frame.GetUpdates())-1].GetReaction()
	var fire *appv1.ReactionCount
	for _, chip := range r.GetReactions() {
		if chip.GetEmoji() == "🔥" {
			fire = chip
		}
	}
	if !slices.Equal(fire.GetRecentUserIds(), []int64{b, author}) || !slices.Contains(usersIn(frame.GetUsers()), b) {
		t.Fatalf("realtime 🔥 = %v users %v", fire, usersIn(frame.GetUsers()))
	}
	tail := h.logOf(c)
	if got := tail[len(tail)-1].GetReaction().GetReactions(); len(got) == 0 || len(got[0].GetRecentUserIds()) == 0 {
		t.Fatalf("log reaction = %v", tail[len(tail)-1])
	}
}

func TestReactionChipsHideReactorsInChannels(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner, sub := h.user("owner"), h.user("sub")
	created, err := h.svc.CreateChannel(ctx, owner, "news", "")
	if err != nil {
		t.Fatal(err)
	}
	chatID := created.GetChat().GetId()
	if _, err := h.svc.AddMembers(ctx, owner, chatID, []int64{sub}); err != nil {
		t.Fatal(err)
	}
	seq := h.send(owner, chatID, "post").GetMessage().GetSeq()
	if _, err := h.svc.SetReaction(ctx, sub, chatID, seq, "👍"); err != nil {
		t.Fatal(err)
	}
	chipOf := func(viewer int64) (*appv1.ReactionCount, []int64) {
		resp, err := h.svc.GetHistory(ctx, viewer, &appv1.GetHistoryRequest{ChatId: chatID})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range resp.GetMessages() {
			if m.GetSeq() == seq {
				return m.GetReactions()[0], usersIn(resp.GetUsers())
			}
		}
		t.Fatal("post missing")
		return nil, nil
	}
	// A subscriber sees the count, not who reacted (not even themselves in
	// the list: channel members are private).
	if chip, _ := chipOf(sub); chip.GetCount() != 1 || len(chip.GetRecentUserIds()) != 0 || !chip.GetChosen() {
		t.Fatalf("subscriber chip = %v", chip)
	}
	if chip, users := chipOf(owner); !slices.Equal(chip.GetRecentUserIds(), []int64{sub}) || !slices.Contains(users, sub) {
		t.Fatalf("owner chip = %v users %v", chip, users)
	}
}

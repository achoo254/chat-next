package zalo

import (
	"context"
	"errors"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

func react(t *testing.T, a *Adapter, id, emoji string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return a.SetReaction(ctx, testAccount, "500", id, emoji)
}

func (z *zaloSim) reactions() []command {
	z.mu.Lock()
	defer z.mu.Unlock()
	return append([]command(nil), z.reacts...)
}

func TestSetReactionSendsTheZaloCodeAndTheClientIDHeardLive(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	if err := react(t, a, "4000", "😮"); err != nil {
		t.Fatal(err)
	}
	got := z.reactions()
	if len(got) != 1 {
		t.Fatalf("react commands = %d, want 1", len(got))
	}
	c := got[0]
	if c.To != "500" || c.MsgID != "4000" || c.CliMsgID != "77" || c.Icon == nil || *c.Icon != ":o" {
		t.Errorf("command = %+v", c)
	}
	if z.historyReads() != 0 {
		t.Errorf("history reads = %d, want 0: the client id was heard live", z.historyReads())
	}
}

func TestSetReactionAcceptsThePickersVariationSelector(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	if err := react(t, a, "4000", "❤"); err != nil {
		t.Fatal(err)
	}
	if got := z.reactions(); len(got) != 1 || *got[0].Icon != "/-heart" {
		t.Fatalf("commands = %+v, want the heart", got)
	}
}

func TestSetReactionEmptyEmojiTakesTheReactionBack(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	if err := react(t, a, "4000", ""); err != nil {
		t.Fatal(err)
	}
	if got := z.reactions(); len(got) != 1 || got[0].Icon == nil || *got[0].Icon != "" {
		t.Fatalf("commands = %+v, want an empty icon", got)
	}
}

func TestSetReactionLooksTheClientIDUpInTheHistoryOrFallsBackToZero(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	if err := react(t, a, "9999", "👍"); err != nil {
		t.Fatal(err)
	}
	got := z.reactions()
	if len(got) != 1 || got[0].CliMsgID != "0" || z.historyReads() != 1 {
		t.Fatalf("commands = %+v, history reads = %d; want client id 0 after one history read", got, z.historyReads())
	}
}

func TestSetReactionRefusesWhatZaloCannotTake(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	for _, c := range []struct{ conv, id, emoji string }{
		{"500", "4000", "🦄"},
		{"500", "abc", "👍"},
		{"not-a-user", "4000", "👍"},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := a.SetReaction(ctx, testAccount, c.conv, c.id, c.emoji)
		cancel()
		if !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("SetReaction(%q, %q, %q) = %v, want ErrNotAllowed", c.conv, c.id, c.emoji, err)
		}
	}
	if got := z.reactions(); len(got) != 0 {
		t.Errorf("%d commands reached Zalo, want none", len(got))
	}
}

func TestSetReactionZaloRefusalIsPermanentAndRateLimitIsNot(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.reactFail = "refused" })
	if err := react(t, a, "4000", "👍"); !errors.Is(err, bridge.ErrNotAllowed) {
		t.Errorf("refused = %v, want ErrNotAllowed", err)
	}
	z.set(func(z *zaloSim) { z.reactFail = "rate_limited" })
	var limited *bridge.RateLimitError
	if err := react(t, a, "4000", "👍"); !errors.As(err, &limited) {
		t.Errorf("rate limited = %v, want a RateLimitError", err)
	}
}

func TestSetReactionNeedsTheListeningSidecar(t *testing.T) {
	a, _ := newTestAdapter(t, &fakeRunner{script: scriptedSession(t, nil, false)})
	if err := react(t, a, "4000", "👍"); !errors.Is(err, errNotListening) {
		t.Errorf("err = %v, want errNotListening", err)
	}
}

// What Chat offers for a Zalo chat (feature/reactions.go) is exactly what the adapter can send.
func TestZaloReactionListsAgree(t *testing.T) {
	offered, restricted := feature.ReactionsOf(Name)
	if !restricted {
		t.Fatal("Zalo chats are not restricted to Zalo's emoji")
	}
	for e := range zaloReactionCode {
		if !feature.ReactionAllowed(Name, e) {
			t.Errorf("the adapter sends %q but Chat does not offer it", e)
		}
	}
	if len(offered) != len(zaloReactionCode) {
		t.Errorf("Chat offers %d emoji, the adapter sends %d", len(offered), len(zaloReactionCode))
	}
}

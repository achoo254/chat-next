package zalo

import (
	"context"
	"errors"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func deleteMsgs(t *testing.T, a *Adapter, conv string, ids ...string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return a.DeleteMessages(ctx, testAccount, bridge.Delete{Conversation: conv, IDs: ids})
}

func (z *zaloSim) recalls() []command {
	z.mu.Lock()
	defer z.mu.Unlock()
	return append([]command(nil), z.undos...)
}

func TestDeleteMessagesRecallsWithTheClientIDHeardLive(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	if err := deleteMsgs(t, a, "500", "4000"); err != nil {
		t.Fatal(err)
	}
	got := z.recalls()
	if len(got) != 1 || got[0].To != "500" || got[0].MsgID != "4000" || got[0].CliMsgID != "77" {
		t.Fatalf("undo commands = %+v, want message 4000 with client id 77", got)
	}
	if z.historyReads() != 0 {
		t.Errorf("history reads = %d, want 0", z.historyReads())
	}
}

func TestDeleteMessagesFallsBackToZeroWhenTheClientIDIsUnknown(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	if err := deleteMsgs(t, a, "500", "9999"); err != nil {
		t.Fatal(err)
	}
	if got := z.recalls(); len(got) != 1 || got[0].CliMsgID != "0" {
		t.Fatalf("undo commands = %+v, want client id 0", got)
	}
}

func TestDeleteMessagesRefusesWhatIsNotAZaloMessage(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	for _, c := range []struct{ conv, id string }{{"not-a-user", "4000"}, {"500", "abc"}, {"500", ""}} {
		ids := []string{c.id}
		if c.id == "" {
			ids = nil
		}
		if err := deleteMsgs(t, a, c.conv, ids...); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("DeleteMessages(%q, %v) = %v, want ErrNotAllowed", c.conv, ids, err)
		}
	}
	if got := z.recalls(); len(got) != 0 {
		t.Errorf("%d commands reached Zalo, want none", len(got))
	}
}

func TestDeleteMessagesZaloRefusalIsPermanentAndRateLimitIsNot(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.undoFail = "refused" })
	if err := deleteMsgs(t, a, "500", "4000"); !errors.Is(err, bridge.ErrNotAllowed) {
		t.Errorf("refused = %v, want ErrNotAllowed", err)
	}
	z.set(func(z *zaloSim) { z.undoFail = "rate_limited" })
	var limited *bridge.RateLimitError
	if err := deleteMsgs(t, a, "500", "4000"); !errors.As(err, &limited) {
		t.Errorf("rate limited = %v, want a RateLimitError", err)
	}
}

func TestDeleteMessagesNeedsTheListeningSidecar(t *testing.T) {
	a, _ := newTestAdapter(t, &fakeRunner{script: scriptedSession(t, nil, false)})
	if err := deleteMsgs(t, a, "500", "4000"); !errors.Is(err, errNotListening) {
		t.Errorf("err = %v, want errNotListening", err)
	}
}

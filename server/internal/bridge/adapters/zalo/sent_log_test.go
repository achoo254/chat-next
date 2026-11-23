package zalo

import (
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func TestSentLogKeepsAtMostItsBound(t *testing.T) {
	l := newSentLog(time.Now)
	for rid := int64(1); rid <= maxSendAttempts+10; rid++ {
		l.tried(rid, "500", hashText("x"))
	}
	if len(l.attempts) != maxSendAttempts || len(l.order) != maxSendAttempts {
		t.Fatalf("kept %d attempts (%d ordered), want %d", len(l.attempts), len(l.order), maxSendAttempts)
	}
	if _, ok := l.lookup(1); ok {
		t.Error("the oldest RandomID was kept")
	}
	if _, ok := l.lookup(maxSendAttempts + 10); !ok {
		t.Error("the newest RandomID was dropped")
	}
	for i := 0; i < maxOwnHeard+5; i++ {
		l.heard(ownMessage{conv: "500", id: "1"})
	}
	if len(l.own) != maxOwnHeard || len(l.ownAt) != maxOwnHeard {
		t.Fatalf("kept %d heard messages, want %d", len(l.own), maxOwnHeard)
	}
}

func TestSentLogForgetsWhatIsTooOld(t *testing.T) {
	clock := newFakeClock()
	l := newSentLog(clock.now)
	l.tried(1, "500", hashText("x"))
	l.settle(1, bridge.SentRef{IDs: []string{"77"}})
	l.heard(ownMessage{conv: "500", id: "78"})
	clock.advance(maxSentAge + time.Second)
	if _, ok := l.lookup(1); ok {
		t.Error("an attempt older than maxSentAge was kept")
	}
	if len(l.own) != 0 || len(l.claimed) != 0 {
		t.Errorf("heard %d, claimed %d; want both empty", len(l.own), len(l.claimed))
	}
}

func TestSentLogClaimsAMessageForOneRandomIDOnly(t *testing.T) {
	clock := newFakeClock()
	l := newSentLog(clock.now)
	text := hashText("ok")
	l.tried(1, "500", text)
	l.tried(2, "500", text)
	at := clock.now()
	l.heard(ownMessage{conv: "500", text: text, id: "10", date: at})
	l.heard(ownMessage{conv: "600", text: text, id: "11", date: at})             // another person
	l.heard(ownMessage{conv: "500", text: hashText("khác"), id: "12", date: at}) // another text
	first, ok := l.claimHeard(1)
	if !ok || first.IDs[0] != "10" {
		t.Fatalf("claim of 1 = %v %v, want message 10", first, ok)
	}
	if ref, ok := l.claimHeard(2); ok {
		t.Fatalf("message 10 answered a second RandomID: %v", ref)
	}
	l.heard(ownMessage{conv: "500", text: text, id: "13", date: at.Add(time.Second)})
	if ref, ok := l.claimHeard(2); !ok || ref.IDs[0] != "13" {
		t.Fatalf("claim of 2 = %v %v, want message 13", ref, ok)
	}
}

func TestSentLogMatchesNothingOlderThanTheLowerBound(t *testing.T) {
	clock := newFakeClock()
	l := newSentLog(clock.now)
	text := hashText("đã gửi")
	start := clock.now()
	l.open(1, "500", text, start.Add(-time.Minute))
	before := ownMessage{conv: "500", text: text, id: "1", date: start.Add(-2 * time.Minute)}
	if ref, ok := l.claimAmong(1, []ownMessage{before}); ok {
		t.Fatalf("matched %v from before the send was queued", ref)
	}
	after := ownMessage{conv: "500", text: text, id: "2", date: start.Add(time.Minute)}
	if ref, ok := l.claimAmong(1, []ownMessage{before, after}); !ok || ref.IDs[0] != "2" {
		t.Fatalf("claim = %v %v, want message 2", ref, ok)
	}
}

func TestSentLogMatchesAnyTextTriedUnderTheRandomID(t *testing.T) {
	clock := newFakeClock()
	l := newSentLog(clock.now)
	l.tried(1, "500", hashText("trước khi sửa"))
	l.tried(1, "500", hashText("sau khi sửa"))
	m := ownMessage{conv: "500", text: hashText("trước khi sửa"), id: "9", date: clock.now()}
	if _, ok := l.claimAmong(1, []ownMessage{m}); !ok {
		t.Fatal("the text of the first try was not matched")
	}
}

// The sidecar hashes the texts of a history page the same way (src/history.mjs,
// textHash; the same vectors are in its test).
func TestTextHashMatchesTheSidecar(t *testing.T) {
	for text, want := range map[string]string{
		"ok":     "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
		"đã gửi": "e454723bc686b2c0ef3668c4453724dd0a18e939fa2465e7fb72ebd74af0abdb",
	} {
		got, ok := parseTextHash(want)
		if !ok || got != hashText(text) {
			t.Errorf("%q: parsed %v, hash differs or does not parse", text, ok)
		}
	}
	for _, bad := range []string{"", "ok", strings.Repeat("A", 64), strings.Repeat("g", 64), strings.Repeat("a", 62)} {
		if _, ok := parseTextHash(bad); ok {
			t.Errorf("%q parsed as a hash", bad)
		}
	}
}

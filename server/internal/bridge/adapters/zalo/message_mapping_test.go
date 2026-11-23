package zalo

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func mustEvent(t *testing.T, line string) wireEvent {
	t.Helper()
	ev, err := decodeEvent([]byte(line))
	if err != nil {
		t.Fatalf("decode %s: %v", line, err)
	}
	return ev
}

func TestMapMessageText(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	ev := mustEvent(t, `{"ev":"message","thread":"user","self":false,"msgType":"webchat","content":"chào","msgId":42,"uidFrom":"500","idTo":"999","dName":"Lan","ts":"1763700000123"}`)
	m, conv, err := mapMessage(ev, now)
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != "42" || m.Text != "chào" || m.Conversation != "500" || m.From.ID != "500" || m.From.IsSelf {
		t.Errorf("message = %+v", m)
	}
	if !m.Date.Equal(time.UnixMilli(1763700000123)) {
		t.Errorf("date = %v", m.Date)
	}
	if conv.Peer == nil || conv.Peer.Name != "Lan" || conv.Peer.NameUnknown || conv.Title != "Lan" {
		t.Errorf("conversation = %+v", conv)
	}
}

func TestMapMessageSelfUsesTheRecipientAsConversation(t *testing.T) {
	ev := mustEvent(t, `{"ev":"message","thread":"user","self":true,"msgType":"webchat","content":"ok","msgId":"7","uidFrom":"999","idTo":"500","dName":"Chủ","ts":"1763700000000"}`)
	m, conv, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if m.Conversation != "500" || !m.From.IsSelf || m.From.ID != "999" {
		t.Errorf("message = %+v", m)
	}
	// The owner's display name is not the other person's: the title stays a stand-in.
	if !conv.Peer.NameUnknown || conv.Title != "Zalo 500" {
		t.Errorf("conversation = %+v", conv)
	}
}

func TestMapMessageSelfTakesTheLookedUpPeerName(t *testing.T) {
	ev := mustEvent(t, `{"ev":"message","thread":"user","self":true,"peerName":"Trịnh Hải Ngân","msgType":"webchat","content":"ok","msgId":"7","uidFrom":"999","idTo":"500","dName":"Chủ","ts":"1763700000000"}`)
	m, conv, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !m.From.IsSelf || m.From.Name != "" {
		t.Errorf("sender = %+v", m.From)
	}
	if conv.Peer.NameUnknown || conv.Peer.Name != "Trịnh Hải Ngân" || conv.Title != "Trịnh Hải Ngân" {
		t.Errorf("conversation = %+v", conv)
	}
	if m.Peer == nil || m.Peer.ID != "500" || m.Peer.Name != "Trịnh Hải Ngân" {
		t.Errorf("message peer = %+v", m.Peer)
	}
}

func TestMapMessageLabels(t *testing.T) {
	cases := map[string]string{
		`{"ev":"message","thread":"user","msgType":"chat.sticker","content":{"id":1,"catId":2,"type":7},"msgId":"1","uidFrom":"5","idTo":"6"}`: labelSticker,
		`{"ev":"message","thread":"user","msgType":"chat.photo","content":{"href":"x"},"msgId":"1","uidFrom":"5","idTo":"6"}`:                  labelUnsupported,
		`{"ev":"message","thread":"user","msgType":"webchat","content":{"title":"link"},"msgId":"1","uidFrom":"5","idTo":"6"}`:                 labelUnsupported,
		`{"ev":"message","thread":"user","msgType":"webchat","content":"","msgId":"1","uidFrom":"5","idTo":"6"}`:                               labelUnsupported,
	}
	for line, want := range cases {
		m, _, err := mapMessage(mustEvent(t, line), time.Now())
		if err != nil || m.Text != want {
			t.Errorf("%s: text = %q, err = %v, want %q", line, m.Text, err, want)
		}
	}
}

func TestMapMessageRefusesGroupsAndMissingIDs(t *testing.T) {
	group := mustEvent(t, `{"ev":"message","thread":"group","msgType":"webchat","content":"x","msgId":"1","uidFrom":"5","idTo":"6"}`)
	if _, _, err := mapMessage(group, time.Now()); !errors.Is(err, errNotPrivate) {
		t.Errorf("group: err = %v", err)
	}
	noID := mustEvent(t, `{"ev":"message","thread":"user","msgType":"webchat","content":"x","uidFrom":"5","idTo":"6"}`)
	if _, _, err := mapMessage(noID, time.Now()); err == nil {
		t.Error("a message without an id was mapped")
	}
}

func TestParseTimestamp(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	cases := map[looseString]time.Time{
		"1763700000123": time.UnixMilli(1763700000123).UTC(),
		"1763700000":    time.Unix(1763700000, 0).UTC(),
		"":              now,
		"soon":          now,
		"-5":            now,
		"9999999999999": now, // year 2286: far ahead of now
	}
	for in, want := range cases {
		if got := parseTimestamp(in, now); !got.Equal(want) {
			t.Errorf("parseTimestamp(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestLooseStringTakesNumbersAndNull(t *testing.T) {
	var v struct{ A, B, C looseString }
	if err := json.Unmarshal([]byte(`{"A":12345678901234567890,"B":null,"C":"x"}`), &v); err != nil {
		t.Fatal(err)
	}
	if v.A != "12345678901234567890" || v.B != "" || v.C != "x" {
		t.Errorf("got %+v", v)
	}
	if err := json.Unmarshal([]byte(`{"A":{"x":1}}`), &v); err == nil {
		t.Error("an object was taken as a string")
	}
}

func TestBoundedSeenSetForgetsTheOldest(t *testing.T) {
	s := newBoundedSeenSet(2)
	if !s.add("a") || !s.add("b") || s.add("a") {
		t.Fatal("first sightings wrong")
	}
	if !s.add("c") { // evicts a
		t.Fatal("c not new")
	}
	if !s.add("a") || s.add("c") {
		t.Error("eviction order wrong")
	}
}

func TestSessionsKeepOnlyTheirFieldsAndCarryTheAccount(t *testing.T) {
	if _, err := parseSidecarSession([]byte(`{"cookie":null,"imei":"i","userAgent":"u"}`)); err == nil {
		t.Error("a null cookie was taken")
	}
	s, err := parseSidecarSession([]byte(`{"cookie":[],"imei":"i","userAgent":"u","x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "undefined", "null", "12a", "123456789012345678901"} {
		if _, err := sealable(s, bad); err == nil {
			t.Errorf("account %q was taken", bad)
		}
	}
	sealed, err := sealable(s, "42")
	if err != nil || string(sealed) != `{"cookie":[],"imei":"i","userAgent":"u","uid":"42"}` {
		t.Fatalf("sealed %s, %v", sealed, err)
	}
	forSidecar, uid, err := openStored(sealed)
	if err != nil || uid != "42" || string(forSidecar) != `{"cookie":[],"imei":"i","userAgent":"u"}` {
		t.Errorf("opened %s %q, %v", forSidecar, uid, err)
	}
}

package zalo

import (
	"context"
	"errors"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

const testAvatar = "https://s120-ava-talk.zadn.vn/a/b/c/120/abc.jpg"

func TestAvatarAllowedOnlyOnTheImageCDN(t *testing.T) {
	ok := []string{testAvatar, "https://ava-grp-talk.zadn.vn/x.jpg"}
	withCredentials := "https://u" + ":p" + "@s120-ava-talk.zadn.vn/x.jpg"
	bad := []string{"", "http://s120-ava-talk.zadn.vn/x.jpg", "https://zadn.vn/x.jpg", "https://evil.example/x.zadn.vn",
		"https://s120-ava-talk.zadn.vn.evil.example/x.jpg", withCredentials,
		"https://s120-ava-talk.zadn.vn:8443/x.jpg", "https://127.0.0.1/x.jpg"}
	for _, u := range ok {
		if !avatarAllowed(u) {
			t.Errorf("%q refused", u)
		}
	}
	for _, u := range bad {
		if avatarAllowed(u) {
			t.Errorf("%q allowed", u)
		}
	}
}

func TestMapMessageGivesThePeerTheirPhoto(t *testing.T) {
	ev := mustEvent(t, `{"ev":"message","thread":"user","self":false,"peerAvatar":"`+testAvatar+`","msgType":"webchat","content":"hi","msgId":"7","uidFrom":"500","idTo":"999","dName":"Lan","ts":"1763700000000"}`)
	m, conv, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []bridge.Participant{m.From, *conv.Peer} {
		if !p.PhotoKnown || p.PhotoID != testAvatar || p.PhotoRef != avatarRef+testAvatar {
			t.Errorf("participant = %+v", p)
		}
	}
}

func TestMapMessageSelfWithOnlyAPhotoNamesThePeer(t *testing.T) {
	ev := mustEvent(t, `{"ev":"message","thread":"user","self":true,"peerAvatar":"`+testAvatar+`","msgType":"webchat","content":"ok","msgId":"7","uidFrom":"999","idTo":"500","dName":"Chủ"}`)
	m, _, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if m.Peer == nil || !m.Peer.PhotoKnown || !m.Peer.NameUnknown {
		t.Fatalf("message peer = %+v", m.Peer)
	}
}

func TestMapMessageWithAnUnexpectedPhotoURLLeavesItUnknown(t *testing.T) {
	ev := mustEvent(t, `{"ev":"message","thread":"user","peerAvatar":"https://evil.example/x.jpg","msgType":"webchat","content":"hi","msgId":"7","uidFrom":"500","idTo":"999","dName":"Lan"}`)
	m, _, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if m.From.PhotoKnown || m.From.PhotoRef != "" {
		t.Fatalf("sender = %+v", m.From)
	}
}

func TestFetchMediaRefusesAnythingButACDNPhoto(t *testing.T) {
	a := &Adapter{}
	for _, ref := range []string{"conv/1", avatarRef + "https://evil.example/x.jpg"} {
		if _, err := a.FetchMedia(context.Background(), bridge.Account{}, ref); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("ref %q: err = %v", ref, err)
		}
	}
}

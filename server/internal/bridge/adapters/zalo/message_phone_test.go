package zalo

import (
	"testing"
	"time"
)

func TestTheProfilePhoneOfTheOtherPersonTravelsWithTheirMessages(t *testing.T) {
	in := mustEvent(t, `{"ev":"message","thread":"user","self":false,"msgType":"webchat","content":"chào","msgId":"1","uidFrom":"500","idTo":"999","dName":"Lan","peerPhone":"84900000001","ts":"1763700000000"}`)
	m, conv, err := mapMessage(in, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !m.From.PhoneKnown || m.From.Phone != "84900000001" || !conv.Peer.PhoneKnown {
		t.Fatalf("incoming: sender phone known = %v, conversation peer phone known = %v", m.From.PhoneKnown, conv.Peer.PhoneKnown)
	}
	// The owner's own message names the other person through Peer, phone included.
	out := mustEvent(t, `{"ev":"message","thread":"user","self":true,"msgType":"webchat","content":"ok","msgId":"2","uidFrom":"999","idTo":"500","dName":"Chủ","peerPhone":"84900000001","ts":"1763700000000"}`)
	m, _, err = mapMessage(out, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if m.From.PhoneKnown || m.Peer == nil || !m.Peer.PhoneKnown {
		t.Fatalf("own message: owner phone known = %v, peer given = %v", m.From.PhoneKnown, m.Peer != nil)
	}
}

func TestAnEmptyProfilePhoneLeavesTheNumberUnknown(t *testing.T) {
	ev := mustEvent(t, `{"ev":"message","thread":"user","self":false,"msgType":"webchat","content":"chào","msgId":"1","uidFrom":"500","idTo":"999","dName":"Lan","peerPhone":"","ts":"1763700000000"}`)
	m, _, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if m.From.PhoneKnown || m.From.Phone != "" {
		t.Fatalf("phone known = %v; want unknown, so the recorded number stays", m.From.PhoneKnown)
	}
}

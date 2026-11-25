package zalo

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"app.local/server/internal/bridge"
)

// Message types seen on a real account (21/11/2026); those of files are in
// message_media.go.
const (
	msgTypeText    = "webchat"
	msgTypeSticker = "chat.sticker"
)

// Labels in place of content Chat does not copy, worded like the engine's
// own labels for media it does not copy.
const (
	labelSticker     = "[Nhãn dán]"
	labelUnsupported = "[Tin nhắn không hỗ trợ]"
)

// Thread kinds of a message event.
const (
	threadUser  = "user"
	threadGroup = "group"
)

// errNotPrivate marks a message of a thread the adapter does not publish.
var errNotPrivate = errors.New("zalo: not a 1-1 message")

// mapMessage turns a 1-1 message event into the bridge message and its
// conversation. The conversation id is the other person's Zalo id: for the
// owner's own message (self) it is the recipient, otherwise the sender.
func mapMessage(ev wireEvent, now time.Time) (bridge.Message, bridge.Conversation, error) {
	if ev.Thread != threadUser {
		return bridge.Message{}, bridge.Conversation{}, errNotPrivate
	}
	id, from, to := string(ev.MsgID), string(ev.UIDFrom), string(ev.IDTo)
	if !zaloID.MatchString(id) || !zaloID.MatchString(from) || !zaloID.MatchString(to) {
		return bridge.Message{}, bridge.Conversation{}, errors.New("zalo: message without valid ids")
	}
	peerID := from
	if ev.Self {
		peerID = to
	}
	peer := bridge.Participant{ID: peerID, Name: "Zalo " + peerID, NameUnknown: true}
	sender := bridge.Participant{ID: from, IsSelf: true}
	if ev.Self {
		if ev.PeerName != "" {
			peer.Name, peer.NameUnknown = ev.PeerName, false
		}
	} else if ev.DName != "" {
		peer.Name, peer.NameUnknown = ev.DName, false
	}
	withAvatar(&peer, ev.PeerAvatar)
	withPhone(&peer, ev.PeerPhone)
	if !ev.Self {
		sender = peer
	}
	conv := bridge.Conversation{ID: peerID, Kind: bridge.ConvPrivate, Title: peer.Name, Peer: &peer}
	m := bridge.Message{Conversation: peerID, ID: id, From: sender, Date: parseTimestamp(ev.TS, now)}
	m.Text, m.Media = messageContent(ev)
	if ev.Self && (!peer.NameUnknown || peer.PhotoKnown || peer.PhoneKnown) {
		m.Peer = &peer
	}
	return m, conv, nil
}

// withPhone gives a participant the phone number their profile shows. Zalo's
// profile of another person usually leaves the number out, and nobody knows
// whether an empty one means «none» or «not shown to you», so only a number
// that is there counts: an empty one leaves the recorded number as it is.
func withPhone(p *bridge.Participant, raw string) {
	if raw == "" {
		return
	}
	p.PhoneKnown, p.Phone = true, raw
}

// textContent is the text of a text message's content, false when it has none.
func textContent(content json.RawMessage) (string, bool) {
	var text string
	if err := json.Unmarshal(content, &text); err != nil || text == "" {
		return "", false
	}
	return text, true
}

// parseTimestamp reads Zalo's send time, milliseconds since 1970 (seconds are
// accepted too). Anything unreadable, or more than a day ahead, is the time it
// was heard.
func parseTimestamp(ts looseString, now time.Time) time.Time {
	n, err := strconv.ParseInt(string(ts), 10, 64)
	if err != nil || n <= 0 {
		return now
	}
	var t time.Time
	if n >= 1e12 {
		t = time.UnixMilli(n)
	} else {
		t = time.Unix(n, 0)
	}
	if t.After(now.Add(24 * time.Hour)) {
		return now
	}
	return t.UTC()
}

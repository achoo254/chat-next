package zalo

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"app.local/server/internal/bridge"
)

// Message types seen on a real account (21/11/2026). Images, files, voice and
// the rest were not observed yet: they come in as the unsupported label.
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
	if !ev.Self {
		if ev.DName != "" {
			peer.Name, peer.NameUnknown = ev.DName, false
		}
		sender = peer
	}
	conv := bridge.Conversation{ID: peerID, Kind: bridge.ConvPrivate, Title: peer.Name, Peer: &peer}
	m := bridge.Message{Conversation: peerID, ID: id, From: sender, Date: parseTimestamp(ev.TS, now), Text: messageText(ev)}
	return m, conv, nil
}

// messageText is the text of a message, or the label of content not copied.
func messageText(ev wireEvent) string {
	switch string(ev.MsgType) {
	case msgTypeText:
		var text string
		if err := json.Unmarshal(ev.Content, &text); err == nil && text != "" {
			return text
		}
	case msgTypeSticker:
		return labelSticker
	}
	return labelUnsupported
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

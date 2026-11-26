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
	withSeen(&peer, ev.PeerSeen)
	if !ev.Self {
		sender = peer
	}
	conv := bridge.Conversation{ID: peerID, Kind: bridge.ConvPrivate, Title: peer.Name, Peer: &peer}
	m := bridge.Message{Conversation: peerID, ID: id, From: sender, Date: parseTimestamp(ev.TS, now)}
	m.Text, m.Media = messageContent(ev)
	if ev.Self && (!peer.NameUnknown || peer.PhotoKnown || peer.SeenKnown) {
		m.Peer = &peer
	}
	return m, conv, nil
}

// undoPayload is what the listener reports when a message is recalled: the
// message that took its place carries the recalled one's id as globalMsgId.
type undoPayload struct {
	ThreadID looseString `json:"threadId"`
	IsGroup  bool        `json:"isGroup"`
	Data     struct {
		Content struct {
			GlobalMsgID looseString `json:"globalMsgId"`
		} `json:"content"`
	} `json:"data"`
}

// mapUndo turns a recall of a 1-1 message into the conversation (the other
// person's Zalo id) and the id of the message to remove.
func mapUndo(raw json.RawMessage) (conv, id string, err error) {
	var p undoPayload
	if err := json.Unmarshal(raw, &p); err != nil || p.IsGroup {
		return "", "", errNotPrivate
	}
	conv, id = string(p.ThreadID), string(p.Data.Content.GlobalMsgID)
	if !zaloID.MatchString(conv) || !zaloID.MatchString(id) {
		return "", "", errors.New("zalo: recall without valid ids")
	}
	return conv, id, nil
}

// withSeen gives a participant the time Zalo says they were last online (milliseconds
// since 1970). 0 means unknown or hidden, which leaves the recorded time as it is.
func withSeen(p *bridge.Participant, ms int64) {
	if ms <= 0 {
		return
	}
	p.SeenKnown, p.Seen = true, time.UnixMilli(ms)
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

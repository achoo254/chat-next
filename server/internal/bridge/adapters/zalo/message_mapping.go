package zalo

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
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

// errNotPrivate marks a payload of a thread the adapter does not publish.
var errNotPrivate = errors.New("zalo: not a 1-1 or group message")

// mapMessage turns a message event into the bridge message and its conversation.
// A group message is mapped by mapGroupMessage. Of a 1-1 message the conversation
// id is the other person's Zalo id: for the owner's own message (self) it is the
// recipient, otherwise the sender.
func mapMessage(ev wireEvent, now time.Time) (bridge.Message, bridge.Conversation, error) {
	if ev.Thread == threadGroup {
		return mapGroupMessage(ev, now)
	}
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
	m.Text, m.Media, m.Entities = messageContent(ev)
	if ev.Self && (!peer.NameUnknown || peer.PhotoKnown || peer.SeenKnown) {
		m.Peer = &peer
	}
	return m, conv, nil
}

// undoPayload is what the listener reports when a message is recalled: the
// message that took its place carries the recalled one's id as globalMsgId and
// its client id as cliMsgId. A recall made on a phone was seen (28/11/2026) with
// globalMsgId 0: only the client id names the message then.
type undoPayload struct {
	ThreadID looseString `json:"threadId"`
	IsGroup  bool        `json:"isGroup"`
	Data     struct {
		Content struct {
			GlobalMsgID looseString `json:"globalMsgId"`
			CliMsgID    looseString `json:"cliMsgId"`
		} `json:"content"`
	} `json:"data"`
}

// recall is a recalled message: its conversation (the other person's Zalo id, or
// the group's conversation), and its id or, when Zalo did not give it, its client id.
type recall struct {
	conv, id, cli string
}

// mapUndo reads a recall. Ids of 0 count as absent.
func mapUndo(raw json.RawMessage) (recall, error) {
	var p undoPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return recall{}, errNotPrivate
	}
	conv := string(p.ThreadID)
	if p.IsGroup {
		if !accountUID.MatchString(conv) {
			return recall{}, errors.New("zalo: recall without a valid group")
		}
		conv = groupConv(conv)
	}
	if !zaloID.MatchString(conv) {
		return recall{}, errors.New("zalo: recall without a valid conversation")
	}
	r := recall{conv: conv}
	if id := string(p.Data.Content.GlobalMsgID); messageID.MatchString(id) && strings.Trim(id, "0") != "" {
		r.id = id
	}
	if cli := string(p.Data.Content.CliMsgID); messageID.MatchString(cli) && strings.Trim(cli, "0") != "" {
		r.cli = cli
	}
	if r.id == "" && r.cli == "" {
		return recall{}, errors.New("zalo: recall without valid ids")
	}
	return r, nil
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

package zalo

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
	"unicode/utf8"

	"app.local/server/internal/bridge"
)

// Sending is to one person the owner already talks with, through the account's
// listening sidecar (a second login would kick the listener): text here, photos
// and files in send_media.go.
//
// Zalo does not recognise a repeated send: zca-js gives each request a
// client id from the clock. So the adapter keeps, per account, the RandomIDs
// it tried and the owner's own messages it heard (sent_log.go). A RandomID it
// never tried is new and goes out at once, unless the engine says it repeats
// a call that may have gone out (OutMessage.RetrySince: the owner retried a
// send left 'unknown', maybe in another process). Only then, or for a
// RandomID it tried itself without learning the outcome, it looks for the
// message an earlier try created: first among the messages heard live, then
// in the newest history page. When neither can tell, it returns an error and
// sends nothing.
//
// Looking only then matters: the owner may type the same text on the phone
// ("ok"), and a new message from Chat must not be taken for that one.

const (
	// maxTextRunes bounds one message; a longer text is refused, not cut.
	maxTextRunes = 4000
	// rateLimitWait is how long the engine waits after Zalo throttled a send
	// (Zalo names no time).
	rateLimitWait = time.Minute
)

var (
	_ bridge.Sender      = (*Adapter)(nil)
	_ bridge.RetryUnsafe = (*Adapter)(nil)
)

// errNotListening: the account's sidecar is not running, so nothing was sent
// or checked; the owner can retry once the account is connected again.
var errNotListening = errors.New("zalo: not connected to Zalo for this account; nothing was sent")

// errUnsure: an earlier try of this RandomID may have created the message and
// neither what was heard nor the history can tell; nothing is sent.
var errUnsure = errors.New("zalo: cannot tell whether an earlier try of this message went out; not sending it again")

// sendState is the sending side of one account. turn lets one send run at a
// time; lastSend and peers are only touched while holding it.
type sendState struct {
	turn     chan struct{}
	lastSend time.Time
	peers    *boundedSeenSet // people proven through a history page
	log      *sentLog
}

// RetryUnsafe implements bridge.RetryUnsafe: the sent log lives in this process
// only and is bounded, so a doubtful send is left to the owner.
func (a *Adapter) RetryUnsafe() {}

// EditMessage implements bridge.Sender. Zalo has no editing; it is never declared.
func (a *Adapter) EditMessage(context.Context, bridge.Account, bridge.EditRequest) error {
	return fmt.Errorf("%w: Zalo messages cannot be edited from Chat", bridge.ErrNotAllowed)
}

// DeleteMessages implements bridge.Sender. Deleting is not offered for Zalo.
func (a *Adapter) DeleteMessages(context.Context, bridge.Account, bridge.Delete) error {
	return fmt.Errorf("%w: Zalo messages cannot be deleted from Chat", bridge.ErrNotAllowed)
}

// SendMessage implements bridge.Sender: one text message, or the photos and files
// of one message or album, to one person. Entities are dropped (plain text) and a
// reply goes as a plain message.
func (a *Adapter) SendMessage(ctx context.Context, acct bridge.Account, m bridge.OutMessage) (bridge.SentRef, error) {
	if err := checkOutgoing(m); err != nil {
		return bridge.SentRef{}, err
	}
	files, err := planFiles(m)
	if err != nil {
		return bridge.SentRef{}, err
	}
	st := a.sendStateFor(acct.ID)
	select {
	case st.turn <- struct{}{}:
	case <-ctx.Done():
		return bridge.SentRef{}, ctx.Err()
	}
	defer func() { <-st.turn }()
	side := a.sidecarOf(acct.ID)
	if side == nil {
		return bridge.SentRef{}, errNotListening
	}
	var page *historyPage
	if !a.heardFor(acct.ID).knows(m.Conversation) && !st.peers.has(m.Conversation) {
		p, err := a.readHistory(ctx, side, m.Conversation)
		if err != nil {
			return bridge.SentRef{}, fmt.Errorf("zalo: cannot check that the owner talks with this person: %w", err)
		}
		if len(p.messages) == 0 {
			return bridge.SentRef{}, fmt.Errorf("%w: Chat sends on Zalo only to people the account has recently talked with", bridge.ErrNotAllowed)
		}
		st.peers.add(m.Conversation)
		page = &p
	}
	if len(files) > 0 {
		return a.sendFiles(ctx, st, side, m, files, page)
	}
	text := hashText(m.Text)
	if ref, done, err := a.earlierTry(ctx, st, side, m, text, page); done {
		return ref, err
	}
	return a.sendNow(ctx, st, side, m, text)
}

// checkOutgoing refuses what Zalo sending does not take, for good. The text of a
// message with files is its caption, which may be empty (planFiles checks the rest).
func checkOutgoing(m bridge.OutMessage) error {
	switch {
	case m.Topic != "":
		return fmt.Errorf("%w: Zalo chats have no topics", bridge.ErrNotAllowed)
	case !accountUID.MatchString(m.Conversation):
		return fmt.Errorf("%w: not a Zalo 1-1 chat", bridge.ErrNotAllowed)
	case m.Text == "" && len(m.Media) == 0:
		return fmt.Errorf("%w: an empty message cannot be sent to Zalo", bridge.ErrNotAllowed)
	case !utf8.ValidString(m.Text):
		return fmt.Errorf("%w: the text is not valid UTF-8", bridge.ErrNotAllowed)
	case utf8.RuneCountInString(m.Text) > maxTextRunes:
		return fmt.Errorf("%w: a Zalo message is limited to %d characters here", bridge.ErrNotAllowed, maxTextRunes)
	}
	return nil
}

// earlierTry answers a RandomID that may have been sent before (done true),
// or says it is to be sent now (done false). page is a history page already
// read for this call, if any.
func (a *Adapter) earlierTry(ctx context.Context, st *sendState, side *sidecar, m bridge.OutMessage, text textHash, page *historyPage) (bridge.SentRef, bool, error) {
	rid, now := m.RandomID, a.now()
	att, seen := st.log.lookup(rid)
	switch {
	case seen && att.ref != nil:
		return *att.ref, true, nil
	case !seen && m.RetrySince.IsZero():
		return bridge.SentRef{}, false, nil // new
	case seen && now.Sub(att.lastTry) < a.timing.sendAnswer:
		// The last try may still land; its answer or echo is not in yet.
		return bridge.SentRef{}, true, fmt.Errorf("%w (the last try is too recent)", errUnsure)
	}
	// Tried here with an open outcome, or a retry of a call that may have gone out
	// (from this process, or from one before it): its message is no older than the send.
	st.log.open(rid, m.Conversation, text, m.RetrySince.Add(-zaloClockSlack))
	if ref, ok := st.log.claimHeard(rid); ok {
		return ref, true, nil
	}
	if page == nil {
		p, err := a.readHistory(ctx, side, m.Conversation)
		if err != nil {
			return bridge.SentRef{}, true, fmt.Errorf("%w: %w", errUnsure, err)
		}
		page = &p
	}
	if ref, ok := st.log.claimAmong(rid, page.candidates(m.Conversation)); ok {
		return ref, true, nil
	}
	att, _ = st.log.lookup(rid)
	if !page.reaches(att.lower) {
		return bridge.SentRef{}, true, fmt.Errorf("%w (the history page does not reach back to the first try)", errUnsure)
	}
	return bridge.SentRef{}, false, nil // the history shows no earlier copy
}

// sendNow sends the text, at least sendGap after the account's last send.
func (a *Adapter) sendNow(ctx context.Context, st *sendState, side *sidecar, m bridge.OutMessage, text textHash) (bridge.SentRef, error) {
	if err := a.waitGap(ctx, st); err != nil {
		return bridge.SentRef{}, err
	}
	st.log.tried(m.RandomID, m.Conversation, text)
	st.lastSend = a.now()
	ev, err := side.request(ctx, command{Cmd: cmdSend, ID: a.nextRequestID(), To: m.Conversation, Text: m.Text}, a.timing.sendAnswer)
	return a.answered(st, m.RandomID, ev, err)
}

// waitGap waits until sendGap has passed since the account's last send.
func (a *Adapter) waitGap(ctx context.Context, st *sendState) error {
	wait := st.lastSend.Add(a.timing.sendGap).Sub(a.now())
	if wait <= 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// answered reads the sidecar's answer to the send (or send_media) of rid: the
// message Zalo created, or why it failed. A failure that says Zalo created
// nothing forgets rid, so a retry goes out at once.
func (a *Adapter) answered(st *sendState, rid int64, ev wireEvent, err error) (bridge.SentRef, error) {
	if err != nil {
		return bridge.SentRef{}, fmt.Errorf("zalo: whether the message went out is not known: %w", err)
	}
	if ev.Ev == evSent && zaloID.MatchString(string(ev.MsgID)) {
		ref := bridge.SentRef{IDs: []string{string(ev.MsgID)}, Date: parseTimestamp(ev.TS, a.now())}
		st.log.settle(rid, ref)
		return ref, nil
	}
	code := safeCode(string(ev.Code))
	if ev.Ev != evSendError {
		code = "unclear"
	}
	nothingCreated, err := sendError(code, safeCode(string(ev.ZaloCode)))
	a.logger.Warn("zalo send failed", "code", code, "zalo_code", safeCode(string(ev.ZaloCode)), "created", !nothingCreated)
	if nothingCreated {
		st.log.forget(rid)
	}
	return bridge.SentRef{}, err
}

// sendError classifies a send_error code (sidecar src/send.mjs) and says
// whether Zalo surely created nothing.
func sendError(code, zaloCode string) (nothingCreated bool, err error) {
	switch code {
	case "rate_limited":
		return true, &bridge.RateLimitError{RetryAfter: rateLimitWait}
	case "session_rejected":
		return true, fmt.Errorf("%w: Zalo refused the session while sending", bridge.ErrSessionRevoked)
	case "refused":
		return true, fmt.Errorf("%w: Zalo refused the message (code %s)", bridge.ErrNotAllowed, zaloCode)
	case "bad_request":
		return true, fmt.Errorf("%w: the message was refused before it was sent", bridge.ErrNotAllowed)
	case "not_logged_in":
		return true, errors.New("zalo: the sidecar is not logged in yet; nothing was sent")
	case "too_large":
		return true, fmt.Errorf("%w: Zalo refused the file as too large", bridge.ErrTooLarge)
	case "file_refused":
		return true, fmt.Errorf("%w: %s: Zalo does not take this file", bridge.ErrNotAllowed, errFileNotSendable)
	case "upload_failed":
		// The upload failed or timed out before any message was posted.
		return true, errors.New("zalo: the file could not be uploaded to Zalo; nothing was sent")
	}
	return false, fmt.Errorf("zalo: whether the message went out is not known (%s)", code)
}

// historyPage is the newest page of 1-1 messages, cut down to one person.
type historyPage struct {
	count    int       // messages in the whole page
	oldest   time.Time // of the whole page; zero when unknown
	messages []historyMessage
}

// readHistory reads the newest page through the account's sidecar.
func (a *Adapter) readHistory(ctx context.Context, side *sidecar, peer string) (historyPage, error) {
	ev, err := side.request(ctx, command{Cmd: cmdHistory, ID: a.nextRequestID(), Peer: peer}, a.timing.historyAnswer)
	if err != nil {
		return historyPage{}, err
	}
	if ev.Ev != evHistory {
		return historyPage{}, fmt.Errorf("zalo: history not read (%s)", safeCode(string(ev.Code)))
	}
	oldest, _ := zaloMillis(ev.OldestTS)
	return historyPage{count: ev.Count, oldest: oldest, messages: ev.Messages}, nil
}

// reaches reports whether the page goes back to t: an empty page, or one of
// unknown age, does not.
func (p historyPage) reaches(t time.Time) bool {
	return p.count > 0 && !p.oldest.IsZero() && !p.oldest.After(t)
}

// candidates are the owner's own text messages of the page.
func (p historyPage) candidates(conv string) []ownMessage {
	var out []ownMessage
	for _, h := range p.messages {
		at, ok := zaloMillis(h.TS)
		if !h.Self || string(h.MsgType) != msgTypeText || !ok || !zaloID.MatchString(string(h.MsgID)) {
			continue
		}
		if text, ok := parseTextHash(h.TextHash); ok {
			out = append(out, ownMessage{conv: conv, text: text, id: string(h.MsgID), date: at})
		}
	}
	return out
}

// zaloMillis reads a Zalo time in milliseconds since 1970; false when it is not one.
func zaloMillis(s looseString) (time.Time, bool) {
	n, err := strconv.ParseInt(string(s), 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(n).UTC(), true
}

// sendStateFor returns the account's sending state, creating it.
func (a *Adapter) sendStateFor(account string) *sendState {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := a.sending[account]
	if st == nil {
		st = &sendState{turn: make(chan struct{}, 1), peers: newBoundedSeenSet(maxProvenPeers), log: newSentLog(a.now)}
		a.sending[account] = st
	}
	return st
}

// sidecarOf returns the account's listening sidecar, nil when none runs.
func (a *Adapter) sidecarOf(account string) *sidecar {
	a.mu.Lock()
	defer a.mu.Unlock()
	if s := a.subs[account]; s != nil {
		return s.side
	}
	return nil
}

// nextRequestID names a command the sidecar answers.
func (a *Adapter) nextRequestID() string {
	return "r" + strconv.FormatUint(a.requests.Add(1), 10)
}

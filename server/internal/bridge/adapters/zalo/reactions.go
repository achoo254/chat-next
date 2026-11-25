package zalo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"app.local/server/internal/bridge"
)

// zaloReactions pairs each reaction code Zalo uses (the Reactions table of
// zca-js 2.3.0) with the emoji Chat shows for it. A code not listed is not
// shown. Where two codes share an emoji, the first one is what Chat sends.
var zaloReactions = []struct{ code, emoji string }{
	{"/-heart", "❤️"}, {"/-strong", "👍"}, {":>", "😆"}, {":o", "😮"}, {":-((", "😢"}, {":-h", "😡"},
	{":-*", "😘"}, {":')", "😂"}, {"/-shit", "💩"}, {"/-rose", "🌹"}, {"/-break", "💔"}, {"/-weak", "👎"},
	{";xx", "😍"}, {";-/", "😕"}, {";-)", "😉"}, {"/-fade", "🥀"}, {"/-li", "☀️"}, {"/-bd", "🎂"},
	{"/-bome", "💣"}, {"/-ok", "👌"}, {"/-v", "✌️"}, {"/-thanks", "🤝"}, {"/-punch", "👊"}, {"/-share", "🔗"},
	{"_()_", "🙏"}, {"/-no", "🙅"}, {"/-bad", "🤏"}, {"/-loveu", "🤟"}, {"--b", "😔"}, {":((", "😭"},
	{"x-)", "😎"}, {"8-)", "🤓"}, {";-d", "😁"}, {"b-)", "😎"}, {":--|", "😐"}, {"p-(", "😞"},
	{":-bye", "👋"}, {"|-)", "😴"}, {":wipe", "😅"}, {":-dig", "🤦"}, {"&-(", "😫"}, {":handclap", "👏"},
	{">-|", "😠"}, {";-x", "🤐"}, {":-o", "😲"}, {";-s", "😳"}, {";-a", "😨"}, {":-<", "😟"},
	{":))", "🤣"}, {"$-)", "🤑"}, {"/-beer", "🍺"},
}

var (
	zaloReactionEmoji = map[string]string{} // code -> emoji
	zaloReactionCode  = map[string]string{} // emoji without variation selector -> code
)

func init() {
	for _, r := range zaloReactions {
		zaloReactionEmoji[r.code] = r.emoji
		if _, taken := zaloReactionCode[bareEmoji(r.emoji)]; !taken {
			zaloReactionCode[bareEmoji(r.emoji)] = r.code
		}
	}
}

// bareEmoji drops the variation selector Chat's picker may add ("❤️" for "❤").
func bareEmoji(e string) string { return strings.ReplaceAll(e, "\uFE0F", "") }

// reactionPayload is what the listener reports when somebody reacts to
// messages: the code of the reaction ("" takes it back) and the messages.
type reactionPayload struct {
	ThreadID looseString `json:"threadId"`
	IsSelf   bool        `json:"isSelf"`
	IsGroup  bool        `json:"isGroup"`
	Data     struct {
		Content struct {
			Icon     string `json:"rIcon"`
			Messages []struct {
				GlobalMsgID looseString `json:"gMsgID"`
			} `json:"rMsg"`
		} `json:"content"`
	} `json:"data"`
}

// mapReactions turns a reaction to 1-1 messages into one bridge.Reactions per
// message. peer is the other person, owner the account's own participant.
//
// Zalo reports one person's change, not everyone's reactions, so each entry
// says only what it knows. The other person's: they are the only other person
// of a 1-1 chat, so their list is complete and the owner's reaction is left
// alone. The owner's (made on the phone): it sets theirs and leaves the other
// person's; the owner taking a reaction back is not carried over, because no
// entry can say "the owner has none" without also dropping the other person's.
func mapReactions(raw json.RawMessage, peer, owner bridge.Participant) (conv string, out []bridge.Reactions, err error) {
	var p reactionPayload
	if err := json.Unmarshal(raw, &p); err != nil || p.IsGroup {
		return "", nil, errNotPrivate
	}
	conv = string(p.ThreadID)
	if !zaloID.MatchString(conv) {
		return "", nil, errors.New("zalo: reaction without a valid conversation")
	}
	emoji, known := zaloReactionEmoji[p.Data.Content.Icon]
	if p.Data.Content.Icon != "" && !known {
		return conv, nil, errors.New("zalo: reaction code Chat has no emoji for")
	}
	for _, m := range p.Data.Content.Messages {
		id := string(m.GlobalMsgID)
		if !zaloID.MatchString(id) {
			continue
		}
		r := bridge.Reactions{Conversation: conv, ID: id}
		switch {
		case p.IsSelf && emoji == "":
			continue
		case p.IsSelf:
			r.List, r.OwnerKnown = []bridge.Reaction{{From: owner, Emoji: emoji}}, true
		case emoji == "":
			r.Complete = true
		default:
			r.List, r.Complete = []bridge.Reaction{{From: peer, Emoji: emoji}}, true
		}
		out = append(out, r)
	}
	return conv, out, nil
}

var _ bridge.ReactionReader = (*Adapter)(nil)

// MessageReactions implements bridge.ReactionReader. Zalo's listener tells each
// change as it happens and the library has no call that reads who reacted to a
// message, so there is nothing to look up: every message is left out, and the
// engine's periodic read changes nothing.
func (a *Adapter) MessageReactions(context.Context, bridge.Account, string, []string) ([]bridge.Reactions, error) {
	return nil, nil
}

var _ bridge.ReactionWriter = (*Adapter)(nil)

// messageID is the form of a Zalo message id the sidecar accepts.
var messageID = regexp.MustCompile(`^[0-9]{1,30}$`)

// SetReaction implements bridge.ReactionWriter: the owner's reaction to a
// message of a 1-1 chat, through the account's listening sidecar. Zalo takes
// only its own set of reactions (zaloReactions); any other emoji is refused for
// good. An empty emoji takes the reaction back. Zalo wants the client id of the
// message too: the one heard live, else the one in the newest history page,
// else 0 (Zalo has not been seen to refuse that; it is not proven either way).
func (a *Adapter) SetReaction(ctx context.Context, acct bridge.Account, conv, id, emoji string) error {
	code := ""
	if emoji != "" {
		var ok bool
		if code, ok = zaloReactionCode[bareEmoji(emoji)]; !ok {
			return fmt.Errorf("%w: Zalo does not take this emoji as a reaction", bridge.ErrNotAllowed)
		}
	}
	if !accountUID.MatchString(conv) || !messageID.MatchString(id) {
		return fmt.Errorf("%w: not a message of a Zalo 1-1 chat", bridge.ErrNotAllowed)
	}
	st := a.sendStateFor(acct.ID)
	select {
	case st.turn <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-st.turn }()
	side := a.sidecarOf(acct.ID)
	if side == nil {
		return errNotListening
	}
	cli := a.heardFor(acct.ID).clientID(id)
	if cli == "" {
		cli = a.clientIDFromHistory(ctx, side, conv, id)
	}
	ev, err := side.request(ctx, command{Cmd: cmdReact, ID: a.nextRequestID(), To: conv, MsgID: id, CliMsgID: cli, Icon: &code}, a.timing.sendAnswer)
	if err != nil {
		return fmt.Errorf("zalo: whether the reaction was set is not known: %w", err)
	}
	if ev.Ev == evReacted {
		return nil
	}
	errCode := safeCode(string(ev.Code))
	if ev.Ev != evSendError {
		errCode = "unclear"
	}
	_, err = sendError(errCode, safeCode(string(ev.ZaloCode)))
	a.logger.Warn("zalo reaction failed", "code", errCode, "zalo_code", safeCode(string(ev.ZaloCode)))
	return err
}

// clientIDFromHistory looks the client id of a message up in the newest history
// page; "0" when the page does not have it or cannot be read.
func (a *Adapter) clientIDFromHistory(ctx context.Context, side *sidecar, conv, id string) string {
	page, err := a.readHistory(ctx, side, conv)
	if err != nil {
		return "0"
	}
	for _, m := range page.messages {
		if string(m.MsgID) == id && messageID.MatchString(string(m.CliMsgID)) {
			return string(m.CliMsgID)
		}
	}
	return "0"
}

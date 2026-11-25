package zalo

import (
	"context"
	"encoding/json"
	"errors"

	"app.local/server/internal/bridge"
)

// zaloReactionEmoji is the emoji Chat shows for each reaction code Zalo sends
// (the Reactions table of zca-js 2.3.0). A code not listed is not shown.
var zaloReactionEmoji = map[string]string{
	"/-heart": "❤️", "/-strong": "👍", ":>": "😆", ":o": "😮", ":-((": "😢", ":-h": "😡",
	":-*": "😘", ":')": "😂", "/-shit": "💩", "/-rose": "🌹", "/-break": "💔", "/-weak": "👎",
	";xx": "😍", ";-/": "😕", ";-)": "😉", "/-fade": "🥀", "/-li": "☀️", "/-bd": "🎂",
	"/-bome": "💣", "/-ok": "👌", "/-v": "✌️", "/-thanks": "🤝", "/-punch": "👊", "/-share": "🔗",
	"_()_": "🙏", "/-no": "🙅", "/-bad": "🤏", "/-loveu": "🤟", "--b": "😔", ":((": "😭",
	"x-)": "😎", "8-)": "🤓", ";-d": "😁", "b-)": "😎", ":--|": "😐", "p-(": "😞",
	":-bye": "👋", "|-)": "😴", ":wipe": "😅", ":-dig": "🤦", "&-(": "😫", ":handclap": "👏",
	">-|": "😠", ";-x": "🤐", ":-o": "😲", ";-s": "😳", ";-a": "😨", ":-<": "😟",
	":))": "🤣", "$-)": "🤑", "/-beer": "🍺",
}

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

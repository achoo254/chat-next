package telegram

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// reactionsPageMax is how many messages one messages.getMessagesReactions names.
const reactionsPageMax = 100

var (
	_ bridge.ReactionReader = (*Adapter)(nil)
	_ bridge.ReactionWriter = (*Adapter)(nil)
)

// mapReactions turns what Telegram says of the reactions of a message into who
// reacted with what. Only standard emoji are carried: a custom or paid reaction has
// no counterpart in Chat. The owner's reaction is the one Telegram marks as chosen;
// the others are the recent reactors it lists, which is everyone in a small group
// and a few in a large one: the list is complete only when it covers every count.
// A "min" answer does not say what the owner chose, so the owner is then unknown.
func (b *peerBook) mapReactions(conv string, msgID int, mr *tg.MessageReactions, self int64) bridge.Reactions {
	out := bridge.Reactions{Conversation: conv, ID: strconv.Itoa(msgID), Complete: true, OwnerKnown: true}
	if mr == nil {
		return out
	}
	out.OwnerKnown = !mr.Min
	owner := bridge.Participant{ID: strconv.FormatInt(self, 10), IsSelf: true, Name: "me"}
	total := 0
	named := map[string]bool{}
	for _, rc := range mr.Results {
		total += rc.Count
		if _, chosen := rc.GetChosenOrder(); !chosen || mr.Min {
			continue
		}
		emoji, ok := emojiOf(rc.Reaction)
		if !ok || named[owner.ID] {
			continue
		}
		named[owner.ID] = true
		out.List = append(out.List, bridge.Reaction{From: owner, Emoji: emoji})
	}
	for _, pr := range mr.RecentReactions {
		from := b.participantOf(pr.PeerID, self)
		if pr.My {
			from = owner
		}
		if from.IsSelf && !out.OwnerKnown {
			continue
		}
		emoji, ok := emojiOf(pr.Reaction)
		if !ok || named[from.ID] {
			continue
		}
		named[from.ID] = true
		out.List = append(out.List, bridge.Reaction{From: from, Emoji: emoji})
	}
	out.Complete = total == len(out.List)
	return out
}

// emojiOf is the emoji of a standard reaction.
func emojiOf(r tg.ReactionClass) (string, bool) {
	e, ok := r.(*tg.ReactionEmoji)
	if !ok || e.Emoticon == "" {
		return "", false
	}
	return e.Emoticon, true
}

// reactionsOfUpdates picks the reactions out of the updates Telegram answers
// messages.getMessagesReactions with.
func reactionsOfUpdates(u tg.UpdatesClass, self int64) []bridge.Reactions {
	var (
		list []tg.UpdateClass
		book = newPeerBook()
	)
	switch v := u.(type) {
	case *tg.Updates:
		list = v.Updates
		book.add(v.Users, v.Chats)
	case *tg.UpdatesCombined:
		list = v.Updates
		book.add(v.Users, v.Chats)
	}
	var out []bridge.Reactions
	for _, x := range list {
		mr, ok := x.(*tg.UpdateMessageReactions)
		if !ok {
			continue
		}
		conv := convID(mr.Peer)
		if conv == "" {
			continue
		}
		out = append(out, book.mapReactions(conv, mr.MsgID, &mr.Reactions, self))
	}
	return out
}

// registerReactions makes the dispatcher turn a change of the reactions of a
// message into an event.
func registerReactions(d tg.UpdateDispatcher, self int64, emit func(context.Context, bridge.Event) error) {
	d.OnMessageReactions(func(ctx context.Context, e tg.Entities, u *tg.UpdateMessageReactions) error {
		conv := convID(u.Peer)
		if conv == "" {
			return nil
		}
		rs := fromEntities(e).mapReactions(conv, u.MsgID, &u.Reactions, self)
		return emit(ctx, bridge.Event{Reactions: &rs})
	})
}

// MessageReactions implements bridge.ReactionReader.
func (a *Adapter) MessageReactions(ctx context.Context, acct bridge.Account, conv string, ids []string) ([]bridge.Reactions, error) {
	nums := make([]int, 0, len(ids))
	for _, id := range ids {
		n, err := strconv.Atoi(id)
		if err != nil {
			return nil, fmt.Errorf("telegram: bad message id %q", id)
		}
		nums = append(nums, n)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, err
	}
	var out []bridge.Reactions
	for start := 0; start < len(nums); start += reactionsPageMax {
		page := nums[start:min(start+reactionsPageMax, len(nums))]
		u, err := c.live.api().MessagesGetMessagesReactions(ctx, &tg.MessagesGetMessagesReactionsRequest{Peer: peer, ID: page})
		if err != nil {
			return nil, translate(err)
		}
		out = append(out, reactionsOfUpdates(u, c.live.self)...)
	}
	return out, nil
}

// translateReaction is translateSend plus what only a reaction can answer: setting
// what is already set is done; a reaction the chat does not allow is a refusal.
func translateReaction(err error) error {
	if err == nil {
		return nil
	}
	if rpc, ok := tgerr.As(err); ok {
		switch rpc.Type {
		case "MESSAGE_NOT_MODIFIED":
			return nil
		case "REACTION_INVALID", "REACTION_EMPTY", "PREMIUM_ACCOUNT_REQUIRED", "REACTIONS_TOO_MANY", "MSG_ID_INVALID", "MESSAGE_ID_INVALID":
			return fmt.Errorf("%w: %s", bridge.ErrNotAllowed, rpc.Type)
		}
	}
	return translateSend(err)
}

// SetReaction implements bridge.ReactionWriter. Telegram names its emoji without the
// variation selector Chat's picker may add ("❤️" is "❤" there), so that is dropped.
func (a *Adapter) SetReaction(ctx context.Context, acct bridge.Account, conv, id, emoji string) error {
	mid, err := strconv.Atoi(id)
	if err != nil {
		return fmt.Errorf("telegram: bad message id %q", id)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	var reaction []tg.ReactionClass
	if e := strings.ReplaceAll(emoji, "️", ""); e != "" {
		reaction = []tg.ReactionClass{&tg.ReactionEmoji{Emoticon: e}}
	}
	_, err = c.live.api().MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: peer, MsgID: mid, Reaction: reaction})
	return translateReaction(err)
}

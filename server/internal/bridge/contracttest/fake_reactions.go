package contracttest

import (
	"context"
	"fmt"
	"sort"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// The fake keeps one reaction per person per message, as Chat does. The owner is
// the participant "self"; anyone else is named by their id.

func reactionKey(conv, id string) string { return conv + "/" + id }

// ReactRemotely sets (or with an empty emoji removes) the reaction of a person to a
// message in the app, as if they had reacted there. MessageReactions answers it;
// push makes the app also tell it as a live event.
func (f *Fake) ReactRemotely(conv, id string, from bridge.Participant, emoji string, push bool) {
	f.mu.Lock()
	m := f.reactions[reactionKey(conv, id)]
	if m == nil {
		m = map[string]string{}
		f.reactions[reactionKey(conv, id)] = m
	}
	if emoji == "" {
		delete(m, from.ID)
	} else {
		m[from.ID] = emoji
	}
	rs := f.reactionsOf(conv, id)
	f.mu.Unlock()
	if push {
		f.Push(bridge.Event{Reactions: &rs})
	}
}

// ReactionsOf is what the app has now for a message, by participant id.
func (f *Fake) ReactionsOf(conv, id string) map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	for k, v := range f.reactions[reactionKey(conv, id)] {
		out[k] = v
	}
	return out
}

// ReactionCalls lists the calls Chat made to react, as "<conv>/<id>:<emoji>".
func (f *Fake) ReactionCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.reactionCalls...)
}

// reactionsOf builds the answer for a message; f.mu is held.
func (f *Fake) reactionsOf(conv, id string) bridge.Reactions {
	rs := bridge.Reactions{Conversation: conv, ID: id, Complete: true, OwnerKnown: true}
	m := f.reactions[reactionKey(conv, id)]
	who := make([]string, 0, len(m))
	for p := range m {
		who = append(who, p)
	}
	sort.Strings(who)
	for _, p := range who {
		from := bridge.Participant{ID: p, Name: "Person " + p}
		if p == "self" {
			from = bridge.Participant{ID: "self", IsSelf: true}
		}
		rs.List = append(rs.List, bridge.Reaction{From: from, Emoji: m[p]})
	}
	return rs
}

// MessageReactions implements bridge.ReactionReader.
func (f *Fake) MessageReactions(_ context.Context, _ bridge.Account, conv string, ids []string) ([]bridge.Reactions, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []bridge.Reactions
	for _, id := range ids {
		if f.hasMessage(conv, id) {
			out = append(out, f.reactionsOf(conv, id))
		}
	}
	return out, nil
}

// hasMessage reports whether the conversation has the message; f.mu is held.
func (f *Fake) hasMessage(conv, id string) bool {
	for _, m := range f.history[conv] {
		if m.ID == id {
			return true
		}
	}
	return false
}

// SetReaction implements bridge.ReactionWriter. It fails like a pin (FailPin).
func (f *Fake) SetReaction(_ context.Context, _ bridge.Account, conv, id, emoji string) error {
	if !f.canWrite(feature.Reactions) {
		return fmt.Errorf("%w: this app does not take reactions from Chat", bridge.ErrNotAllowed)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	f.reactionCalls = append(f.reactionCalls, reactionKey(conv, id)+":"+emoji)
	m := f.reactions[reactionKey(conv, id)]
	if m == nil {
		m = map[string]string{}
		f.reactions[reactionKey(conv, id)] = m
	}
	if emoji == "" {
		delete(m, "self")
	} else {
		m["self"] = emoji
	}
	return nil
}

var (
	_ bridge.ReactionReader = (*Fake)(nil)
	_ bridge.ReactionWriter = (*Fake)(nil)
)

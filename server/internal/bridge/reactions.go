package bridge

import "context"

// Reaction is the reaction of one person to a message: the feature "reactions".
// Chat keeps one reaction per person, so an app that allows several keeps the
// first the adapter names.
type Reaction struct {
	From  Participant
	Emoji string
}

// Reactions is who reacted to a message of the other app, as far as it tells.
type Reactions struct {
	Conversation string
	ID           string // Message.ID
	List         []Reaction
	// Complete says List names everyone who reacted: a person not in it has no
	// reaction. Without it (a large group lists only some, or some reactions are
	// of a kind Chat has not, such as custom emoji) people not listed keep the
	// reaction Chat has for them.
	Complete bool
	// OwnerKnown says List tells the owner's reaction: the owner not in it then
	// means none. Without it the owner's reaction in Chat is left as it is.
	OwnerKnown bool
}

// ReactionReader is implemented by an adapter that supports "reactions" coming
// in. Changes arrive as events; the engine also reads the newest messages of a
// chat on a timer, for what the other app did not tell.
type ReactionReader interface {
	// MessageReactions returns the reactions of the messages of a conversation,
	// one entry per message it knows; a message that is gone is left out.
	MessageReactions(ctx context.Context, acct Account, conv string, ids []string) ([]Reactions, error)
}

// ReactionWriter is implemented by an adapter that supports "reactions" going out.
type ReactionWriter interface {
	// SetReaction makes the owner's reaction to a message emoji, or removes it
	// when emoji is empty. Setting what already is succeeds without effect; a
	// reaction the conversation does not allow returns ErrNotAllowed.
	SetReaction(ctx context.Context, acct Account, conv, id, emoji string) error
}

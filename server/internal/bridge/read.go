package bridge

import "context"

// Seen tells that the account owner read a conversation of the other app up to MaxID, on
// another device: Chat then counts those messages as read too (the feature "read"). Message
// ids of an adapter that sends it are decimal integers that grow with time, as for Read.
type Seen struct {
	Conversation string
	MaxID        string
}

// ReadWriter is implemented by an adapter that supports "read" going out: when the owner
// reads a chat in Chat, the other app marks it as read up to the message. Marking what is
// already read succeeds without effect.
type ReadWriter interface {
	MarkRead(ctx context.Context, acct Account, conv, upToID string) error
}

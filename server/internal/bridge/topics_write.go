package bridge

import "context"

// TopicEdit is a change of a topic: the fields that are nil stay as they are.
type TopicEdit struct {
	Title  *string
	Closed *bool
}

// TopicWriter is implemented by an adapter that lets Chat rename, close and
// reopen the topics of a forum (the pin of a topic is Pinner.PinTopic). Setting what
// already is succeeds without effect; without the right the call returns ErrNotAllowed.
type TopicWriter interface {
	EditTopic(ctx context.Context, acct Account, conv, topic string, edit TopicEdit) error
}

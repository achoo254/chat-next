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

// TopicCreator is implemented by an adapter that lets Chat open a topic in a forum.
type TopicCreator interface {
	// CreateTopic opens a topic and returns its id. A repeated randomID must not open
	// a second topic. Without the right the call returns ErrNotAllowed.
	CreateTopic(ctx context.Context, acct Account, conv, title string, iconColor int, randomID int64) (string, error)
}

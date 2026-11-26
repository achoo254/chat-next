package bridge

import "context"

// DialogState is how the owner has one conversation set up in the other app: the
// state of the chat in their own list. It is what the features "notify" (mute)
// and "dialog" (pinned in the list, marked unread) carry.
type DialogState struct {
	// MuteUntil is when notifications come back, as a Unix time; 0 is not muted
	// and a time far in the future (2147483647) is muted for good.
	MuteUntil int64
	// Pinned: the conversation is pinned in the list.
	Pinned bool
	// UnreadMark: the owner marked it as unread by hand.
	UnreadMark bool
	// MentionsKnown says UnreadMentions is the app's count of the messages that mention
	// the owner and that they have not seen.
	MentionsKnown  bool
	UnreadMentions int
}

// MentionReader is implemented by an adapter that keeps, as Telegram does, which
// messages mentioning the owner they have seen. It goes with "read".
type MentionReader interface {
	// UnreadMentions lists the messages of a conversation that mention the owner and
	// that they have not seen (at most 100, by Message.ID).
	UnreadMentions(ctx context.Context, acct Account, conv string) ([]string, error)
	// ReadMentions tells the app the owner saw these messages that mention them.
	ReadMentions(ctx context.Context, acct Account, conv string, ids []string) error
}

// DialogReader is implemented by an adapter that supports "notify" or "dialog"
// coming in. The state is read, not pushed: an app that does not tell when it
// changes is asked on a timer, and one that does can still be asked.
type DialogReader interface {
	// DialogStates returns the state of each of the conversations, by id. A
	// conversation the app does not know is left out. A throttle comes back as
	// *RateLimitError like any other call.
	DialogStates(ctx context.Context, acct Account, convs []string) (map[string]DialogState, error)
}

// DialogWriter is implemented by an adapter that supports "notify" or "dialog"
// going out. Each call sets the state wanted and succeeds when it already is so.
type DialogWriter interface {
	SetMute(ctx context.Context, acct Account, conv string, until int64) error
	SetDialogPinned(ctx context.Context, acct Account, conv string, pinned bool) error
	SetUnreadMark(ctx context.Context, acct Account, conv string, unread bool) error
}

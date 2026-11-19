package bridge

import "context"

// GroupInfo is what a group or channel says about itself: the feature "info".
// The photo is not part of it yet.
type GroupInfo struct {
	Title string
	About string
	// PhotoID names the group's photo, and changes when it is changed; empty when
	// the group has none. PhotoRef is the FetchMedia ref of its bytes.
	PhotoID  string
	PhotoRef string
}

// InfoReader is implemented by an adapter that supports "info" coming in. The
// info is read on a timer, as for DialogReader.
type InfoReader interface {
	// GroupInfos returns the info of each of the conversations, by id; a
	// conversation that is not a group, or not known, is left out.
	GroupInfos(ctx context.Context, acct Account, convs []string) (map[string]GroupInfo, error)
}

// InfoWriter is implemented by an adapter that supports "info" going out.
type InfoWriter interface {
	// SetGroupInfo makes the title and the description of a group what is given.
	// Setting what already is succeeds without effect. Without the right to change
	// the info the call returns ErrNotAllowed.
	SetGroupInfo(ctx context.Context, acct Account, conv string, info GroupInfo) error
}

// PhotoWriter is implemented by an adapter that lets Chat change the photo of a group.
type PhotoWriter interface {
	// SetGroupPhoto makes photo the group's photo, or removes it when photo is nil,
	// and returns the PhotoID the group has then. Without the right the call returns
	// ErrNotAllowed.
	SetGroupPhoto(ctx context.Context, acct Account, conv string, photo *OutMedia) (string, error)
}

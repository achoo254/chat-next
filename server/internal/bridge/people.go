package bridge

import "context"

// Perms is what a member of a group may do, when the group restricts them (the
// feature "members"). Every field true is a member with no restriction.
type Perms struct {
	Send, Media, AddMembers, Pin, ChangeInfo, ManageTopics bool
}

// FullPerms is a member with no restriction.
var FullPerms = Perms{Send: true, Media: true, AddMembers: true, Pin: true, ChangeInfo: true, ManageTopics: true}

// MemberAdder is implemented by an adapter that lets Chat add a person it knows to a
// group (the feature "members" going out). The person must be one the app has already
// shown to the account. A person who does not allow being added returns ErrNotAllowed.
type MemberAdder interface {
	AddMember(ctx context.Context, acct Account, conv, participant string) error
}

// PermWriter is implemented by an adapter that lets Chat restrict one member of a
// group. Perms is the whole set the member should have; FullPerms lifts the
// restriction. A group that has no per-member rights returns ErrNotAllowed.
type PermWriter interface {
	SetMemberPerms(ctx context.Context, acct Account, conv, participant string, perms Perms) error
}

// InviteLink is an invite link of a group in the other app (not a Chat invite link).
type InviteLink struct {
	Link    string
	Title   string
	Revoked bool
	// Usage is how many people joined with it.
	Usage int
}

// InviteManager is implemented by an adapter that supports "invites": the links the
// account made for a group, and making and revoking them.
type InviteManager interface {
	ListInvites(ctx context.Context, acct Account, conv string) ([]InviteLink, error)
	// CreateInvite makes a new link and returns it.
	CreateInvite(ctx context.Context, acct Account, conv, title string) (InviteLink, error)
	// RevokeInvite stops a link from working; revoking a revoked link succeeds.
	RevokeInvite(ctx context.Context, acct Account, conv, link string) error
}

// GroupLifecycle is implemented by an adapter that supports "lifecycle". Both calls
// are final: the engine sends them only after the user confirmed by typing the name
// of the group, and DeleteGroup also after a second confirmation.
type GroupLifecycle interface {
	// LeaveGroup makes the account leave the group (it can join again if invited).
	LeaveGroup(ctx context.Context, acct Account, conv string) error
	// DeleteGroup deletes the group for everybody in it, history included. Without
	// being the owner of the group the call returns ErrNotAllowed.
	DeleteGroup(ctx context.Context, acct Account, conv string) error
}

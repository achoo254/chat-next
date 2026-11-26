package bridge

import "context"

// Member is a person in a group of the other app, and whether they are an admin there.
type Member struct {
	Participant Participant
	Admin       bool
	// Perms is the restriction the group put on them; nil when it did not.
	Perms *Perms
	// Rank is the tag the group shows beside their name (a custom title); "" for none.
	Rank string
}

// MemberReader is implemented by an adapter that supports "members" coming in. It
// is read on a timer, as for the info of a group.
type MemberReader interface {
	// ListMembers returns who is in the group. complete is false when the group is
	// too big to list in full (the engine then adds and re-roles but never removes).
	// The account owner may be listed (Participant.IsSelf), for their own rank.
	ListMembers(ctx context.Context, acct Account, conv string) (members []Member, complete bool, err error)
}

// MemberWriter is implemented by an adapter that supports "members" going out. It
// acts on real people, so every call must be one the user asked for: the engine
// sends it only when the user turned the feature on for that chat, and counts it
// against a limit per hour. Doing what is already so succeeds without effect; without
// the right the call returns ErrNotAllowed.
type MemberWriter interface {
	// RemoveMember takes the person out of the group (they can join again).
	RemoveMember(ctx context.Context, acct Account, conv, participant string) error
	// SetMemberAdmin makes the person an admin of the group, or takes it away.
	SetMemberAdmin(ctx context.Context, acct Account, conv, participant string, admin bool) error
}

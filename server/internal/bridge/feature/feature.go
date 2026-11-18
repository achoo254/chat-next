// Package feature names what a bridge can sync between Chat and another app, in
// which direction, and how risky each thing is. It has no dependencies so both the
// chat core and the bridge can use it.
//
// A feature is the unit the owner switches on or off for a synced chat and the
// unit an adapter says it supports. The risk of a feature is fixed in code and
// decides its default (ADR 0023).
package feature

// Feature is a thing that can be synced, by a stable name.
type Feature string

const (
	// Messages: sending, editing and deleting messages, with their replies and files.
	Messages Feature = "messages"
	// Pins: pinned messages.
	Pins Feature = "pins"
	// Topics: the topics of a forum, and pinning one from Chat.
	Topics Feature = "topics"
	// Reactions on messages.
	Reactions Feature = "reactions"
	// Read: what is read, on both sides.
	Read Feature = "read"
	// Notify: mute and notification settings of the chat.
	Notify Feature = "notify"
	// Dialog: state of the chat in the list (pinned, marked unread, archived).
	Dialog Feature = "dialog"
	// Info: title, description and photo of a group.
	Info Feature = "info"
	// Members: who is in a group and their roles.
	Members Feature = "members"
	// Invites: invite links of a group.
	Invites Feature = "invites"
	// Typing: "is typing" and presence.
	Typing Feature = "typing"
)

var all = []Feature{Messages, Pins, Topics, Reactions, Read, Notify, Dialog, Info, Members, Invites, Typing}

// All lists every feature, in the order they are shown.
func All() []Feature { return append([]Feature(nil), all...) }

// Valid reports whether f is a known feature.
func Valid(f Feature) bool {
	for _, x := range all {
		if x == f {
			return true
		}
	}
	return false
}

// Risk says what a feature can do to other people.
type Risk int

const (
	// R1 changes only the owner's own state, and can be undone: read, mute,
	// reactions, pins, the state of the chat in the list.
	R1 Risk = iota + 1
	// R2 changes what other people see: messages, group info, topics.
	R2
	// R3 acts on people and groups: members, roles, invite links.
	R3
	// RE is ephemeral and visible to others without being kept: typing.
	RE
)

// RiskOf returns the risk of f.
func RiskOf(f Feature) Risk {
	switch f {
	case Messages, Topics, Info:
		return R2
	case Members, Invites:
		return R3
	case Typing:
		return RE
	}
	return R1
}

// Direction is where a feature flows for one synced chat.
type Direction string

const (
	// Off: nothing flows.
	Off Direction = "off"
	// In: the other app changes Chat.
	In Direction = "in"
	// Out: Chat changes the other app.
	Out Direction = "out"
	// Both ways.
	Both Direction = "both"
)

// Valid reports whether d is a known direction.
func (d Direction) Valid() bool { return d == Off || d == In || d == Out || d == Both }

// Receives is whether changes in the other app reach Chat.
func (d Direction) Receives() bool { return d == In || d == Both }

// Sends is whether changes in Chat reach the other app.
func (d Direction) Sends() bool { return d == Out || d == Both }

// Default is the direction of f for a chat that has none set, given the
// direction of its messages (In for a chat that only reads, Both for one that
// sends on what the owner writes):
//
//   - the owner's own state and pins (R1) and the structure of a group (R2) follow
//     the messages, so a chat that sends on also carries these;
//   - acting on people and groups (R3) is Off until it is switched on for the chat;
//   - typing only comes in, and is Off until switched on.
func Default(f Feature, messages Direction) Direction {
	if f == Messages {
		return messages
	}
	switch RiskOf(f) {
	case R3:
		return Off
	case RE:
		return Off
	}
	if messages == Both {
		return Both
	}
	return In
}

// Support is what an adapter can do for a feature.
type Support struct {
	// In: the other app's changes can be read.
	In bool
	// Out: Chat can make the change in the other app.
	Out bool
}

// Allows reports whether the adapter supports d for a feature: every flow d
// asks for must be one the adapter has.
func (s Support) Allows(d Direction) bool {
	switch d {
	case Off:
		return true
	case In:
		return s.In
	case Out:
		return s.Out
	case Both:
		return s.In && s.Out
	}
	return false
}

// Package bridge brings the conversations of another app into Chat. An
// Adapter speaks one app's protocol and emits normalised events; the sync
// engine (a later file in this package) owns state, ordering and writing into
// Chat. The contract is a Go interface, not protobuf: it never crosses a
// process boundary (ADR 0022).
package bridge

import (
	"context"
	"time"
)

// Capability is a feature an adapter can offer. The engine asks before using
// one, so an app without it degrades instead of failing.
type Capability string

const (
	CapHistory Capability = "history"
	CapLive    Capability = "live"
	CapEdits   Capability = "edits"
	CapDeletes Capability = "deletes"
	CapMedia   Capability = "media"
)

// Capabilities is the set an adapter declares.
type Capabilities map[Capability]bool

// Has reports whether c is offered.
func (cs Capabilities) Has(c Capability) bool { return cs[c] }

// StepKind is how a login step asks the user for something.
type StepKind string

const (
	// StepInput asks for text fields (phone number, one-time code, 2FA password).
	StepInput StepKind = "input"
	// StepQR shows a code to scan with the other app. Declared for the next
	// adapter; no adapter implements it yet.
	StepQR StepKind = "qr"
	// StepConfirm waits for the user to approve on another device.
	StepConfirm StepKind = "confirm"
	// StepDone ends the login; Session carries the opaque state to store.
	StepDone StepKind = "done"
)

// Field is one input of a StepInput step.
type Field struct {
	Name   string
	Label  string
	Secret bool // never logged, never echoed back
}

// LoginStep is what an adapter shows next. The state it needs between calls
// is in Token, an opaque string the caller hands back unchanged.
type LoginStep struct {
	Kind   StepKind
	Token  string
	Fields []Field // StepInput
	Prompt string  // StepQR: payload to render; StepConfirm: instruction
	// Session is set on StepDone: the adapter's own login state, sealed by
	// the engine and given back to every later call. Opaque to the core.
	Session []byte
	// Account identifies the signed-in account in the other app.
	Account string
}

// Account is a signed-in session handed to adapter calls.
type Account struct {
	// ID is the engine's id of this external account.
	ID string
	// Session is what StepDone returned, opened by the engine.
	Session []byte
	// State is the adapter-owned blob of update state (for example a
	// Telegram pts/qts/date), opaque to the core, persisted by the engine.
	State []byte
}

// ConvKind is the normalised type of a conversation.
type ConvKind string

const (
	ConvPrivate ConvKind = "private" // one other person
	ConvBot     ConvKind = "bot"     // one other participant that is a bot
	ConvGroup   ConvKind = "group"
	ConvChannel ConvKind = "channel"
)

// Conversation is a chat of the other app. ID is an opaque string the core
// never parses (ADR 0022).
type Conversation struct {
	ID    string
	Kind  ConvKind
	Title string
	// PhotoRef is an opaque handle for FetchMedia; empty when there is none.
	PhotoRef string
}

// Participant is a person in the other app, mapped to a puppet user.
type Participant struct {
	ID       string
	Name     string
	Username string
	IsBot    bool
	// IsSelf marks the account owner, whose messages are attributed to the
	// real Chat user.
	IsSelf   bool
	PhotoRef string
}

// Entity is a normalised text span. Kinds the engine does not know are
// dropped rather than guessed.
type Entity struct {
	Kind   string // bold, italic, code, pre, link, mention ...
	Offset int    // UTF-16 code units, as Chat entities
	Length int
	URL    string
	// Mention is the Participant.ID a mention points at.
	Mention string
}

// Media is a file attached to a message.
type Media struct {
	Ref      string // opaque handle for FetchMedia
	Kind     string // photo, video, audio, voice, document ...
	MimeType string
	Name     string
	Size     int64
	Width    int
	Height   int
	Duration time.Duration
}

// Message is a message in a conversation. Version orders edits of the same
// message: an event with a version not above the stored one is dropped.
type Message struct {
	Conversation string
	ID           string
	From         Participant
	Date         time.Time // original send time
	Text         string
	Entities     []Entity
	Media        []Media
	ReplyTo      string // Message.ID in the same conversation
	Version      int64
}

// Edit replaces the content of an already-seen message.
type Edit struct {
	Message Message
}

// Delete removes messages. Conversation may be empty when the other app
// reports a delete without a chat; the engine then looks the id up across
// the account's conversations.
type Delete struct {
	Conversation string
	IDs          []string
}

// Event is one normalised update. Exactly one of Message, Edit, Delete or
// Conversation is set. State is the account state after this event; the
// engine stores it in the same transaction as the write, so a crash between
// the two is replayed, not lost.
type Event struct {
	Message      *Message
	Edit         *Edit
	Delete       *Delete
	Conversation *Conversation
	Participant  *Participant
	State        []byte
}

// Cursor says where Backfill resumes. The zero value starts from the newest
// message of the conversation.
type Cursor struct {
	// Before is the Message.ID to read older than; empty on the first call.
	Before string
}

// Page is a batch of history, newest first within the page.
type Page struct {
	Messages []Message
	Next     Cursor
	Done     bool
}

// Adapter is the contract of one app. Calls are made for a single account at
// a time, from one goroutine at a time per account (the engine holds a lease).
type Adapter interface {
	// Name is the stable id of the app ("telegram"); it keys external rows.
	Name() string
	Capabilities() Capabilities
	// Login advances a login. The first call has an empty prior token and
	// an empty input.
	Login(ctx context.Context, prior string, input map[string]string) (LoginStep, error)
	// Logout ends the session in the other app (Telegram: auth.logOut).
	Logout(ctx context.Context, acct Account) error
	ListConversations(ctx context.Context, acct Account) ([]Conversation, error)
	// Backfill reads history older than the cursor, newest page first.
	Backfill(ctx context.Context, acct Account, conv string, cur Cursor, limit int) (Page, error)
	// Subscribe delivers live events of the whole account until ctx ends,
	// resuming from acct.State so events missed while offline are replayed.
	Subscribe(ctx context.Context, acct Account, out chan<- Event) error
	// FetchMedia streams the bytes behind a Media or photo ref.
	FetchMedia(ctx context.Context, acct Account, ref string) (MediaStream, error)
}

// MediaStream is a downloadable file.
type MediaStream interface {
	Read(p []byte) (int, error)
	Close() error
	MimeType() string
	Size() int64
}

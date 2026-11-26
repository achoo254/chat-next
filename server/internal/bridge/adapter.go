// Package bridge brings the conversations of another app into Chat. An
// Adapter speaks one app's protocol and emits normalised events; the sync
// engine (a later file in this package) owns state, ordering and writing into
// Chat. The contract is a Go interface, not protobuf: it never crosses a
// process boundary (ADR 0022).
package bridge

import (
	"context"
	"errors"
	"fmt"
	"io"
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
	// CapSend means the adapter also implements Sender: Chat can send,
	// edit and delete messages in the other app.
	CapSend Capability = "send"
	// CapTopics means the adapter also implements TopicReader and tells the
	// topic of each message of a conversation that has topics (a forum).
	CapTopics Capability = "topics"
	// CapPins means the adapter also implements PinReader: it lists the
	// pinned messages of a conversation and tells when one is pinned or
	// unpinned. Pinned topics need no capability of their own: Topic.Pinned
	// and TopicChange carry them. With CapSend it may also implement Pinner.
	CapPins Capability = "pins"
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
	// StepQR shows a code to scan with the other app. Prompt is what to
	// show: the Zalo adapter gives a data: URL of the PNG image. The caller
	// continues with no input to wait for the scan; the step repeats (with a
	// new code when the old one expired) until it moves on.
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
	Prompt string  // StepQR: image to show (data: URL); StepConfirm: instruction
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
	// Peer is the other side of a private or bot conversation (nil for a
	// group or channel): its puppet user is the chat's other member.
	Peer *Participant
	// PhotoRef is an opaque handle for FetchMedia; empty when there is none.
	PhotoRef string
	// Forum is true for a group split into topics (a Telegram forum). Its
	// messages carry Message.Topic and the list of topics is ListTopics.
	Forum bool
	// Ref is an opaque handle Chat keeps to ask about the conversation once it is no
	// longer listed (GoneChecker); empty when the id alone is enough.
	Ref string
}

// GoneChecker tells, for a conversation that dropped out of ListConversations, whether
// the account is really out of it: the conversation was deleted, or the account was
// removed or left. Missing from the list alone is not enough (an archived chat, a list
// cut short); gone is true only when the other app says so. ref is the Conversation.Ref
// last listed.
type GoneChecker interface {
	ConversationGone(ctx context.Context, acct Account, conv, ref string) (bool, error)
}

// Participant is a person in the other app, mapped to a puppet user.
type Participant struct {
	ID       string
	Name     string
	Username string
	IsBot    bool
	// IsSelf marks the account owner, whose messages are attributed to the
	// real Chat user.
	IsSelf bool
	// PhotoKnown says the adapter read the person's profile photo, so the
	// puppet's photo follows it: PhotoID names the current photo ("" when
	// they have none or hide it) and changes whenever the photo does, and
	// PhotoRef is the FetchMedia ref of its bytes. When false the puppet's
	// photo is left as it is.
	PhotoKnown bool
	PhotoID    string
	PhotoRef   string
	// NameUnknown marks a Name that is only a stand-in (the app named the
	// person by id alone). The engine uses it to create a missing puppet but
	// never to rename one that already has a real name.
	NameUnknown bool
	// PhoneKnown says the app stated the person's phone number, so the engine
	// records it: Phone is the number as the app gave it ("" when they have
	// none or hide it, which clears the one recorded). When false the recorded
	// number is left as it is. The engine keeps only a keyed hash of the number
	// in E.164 form; a number it cannot read is treated as unknown. Adapters
	// never log it.
	PhoneKnown bool
	Phone      string
	// SeenKnown says the app stated when the person was last online, so the engine
	// records Seen as the puppet's last-seen time. An app that shows only a band
	// ("recently", "within a week") gives a time inside that band. When false the
	// recorded time is left as it is; a person the app says is online now is Seen = now.
	SeenKnown bool
	Seen      time.Time
	// SeenBand is how the app states the time: exactly, or only as a band when the
	// person hides it. Clients show the band, not the time inside it.
	SeenBand SeenBand
	// OnlineUntil is set while the app says the person is online now: when that
	// lapses without a new status.
	OnlineUntil time.Time
}

// SeenBand is how precisely the other app states when a person was last online.
type SeenBand int16

const (
	SeenExact SeenBand = iota
	SeenRecently
	SeenLastWeek
	SeenLastMonth
)

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

// Button is a link button of a message (an inline keyboard button that opens
// a URL). Buttons that do something else, such as a bot callback, have no
// counterpart and are not carried.
type Button struct {
	Text string
	URL  string
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
	// Buttons are the link buttons under the message, one slice per row.
	Buttons [][]Button
	ReplyTo string // Message.ID in the same conversation
	// Topic is the topic the message is in, an opaque id; empty outside a
	// forum. A message of a forum that belongs to no topic is in the general
	// topic, which the adapter names like any other.
	Topic   string
	Version int64
	// Service is set for a system line of the other app instead of content: Text,
	// Entities and Media are then empty.
	Service *ServiceAction
	// Forward is set for a message forwarded from elsewhere.
	Forward *ForwardInfo
	// Peer is the other side of a 1-1 conversation when the message is the owner's
	// own: it lets the engine rename a chat whose other side was first met without a
	// name. Nil otherwise.
	Peer *Participant
}

// ForwardInfo says where a forwarded message came from.
type ForwardInfo struct {
	// From is the original author when the app names them; nil when hidden.
	From *Participant
	// Name is the author's or channel's name as the app shows it.
	Name string
	// Date is when the original was sent.
	Date time.Time
}

// Forwarder is implemented by an adapter that can forward messages it has from one
// conversation to another natively, keeping the "forwarded from" mark.
type Forwarder interface {
	// ForwardMessages forwards the messages ids of fromConv (an album as one call)
	// into toConv, in topic when toConv is a forum. Item i takes randomID+i, the
	// same on every retry, so a repeat forwards nothing twice.
	ForwardMessages(ctx context.Context, acct Account, fromConv string, ids []string, toConv, topic string, randomID int64) (SentRef, error)
}

// ServiceAction is a system line of a conversation: who did what, From being the
// actor. Kinds the engine does not know are dropped.
type ServiceAction struct {
	Kind ServiceKind
	// Title is the new name (ServiceTitleChanged) or the name it was created with
	// (ServiceChatCreated).
	Title string
	// People are who joined (ServiceMembersAdded) or who was removed (ServiceMemberRemoved).
	People []Participant
	// MessageID is the message pinned (ServiceMessagePinned).
	MessageID string
}

// ServiceKind is what a system line says.
type ServiceKind string

const (
	ServiceChatCreated   ServiceKind = "chat_created"
	ServiceMembersAdded  ServiceKind = "members_added"
	ServiceMemberLeft    ServiceKind = "member_left"
	ServiceMemberRemoved ServiceKind = "member_removed"
	ServiceJoinedByLink  ServiceKind = "joined_by_link"
	ServiceTitleChanged  ServiceKind = "title_changed"
	ServicePhotoChanged  ServiceKind = "photo_changed"
	ServicePhotoRemoved  ServiceKind = "photo_removed"
	ServiceMessagePinned ServiceKind = "message_pinned"
)

// Topic is a topic of a forum conversation.
type Topic struct {
	ID        string
	Title     string
	IconColor int // 0xRRGGBB, 0 for none
	Closed    bool
	Pinned    bool
	Hidden    bool
	// General marks the conversation's default topic (the one messages
	// outside any other topic belong to). Chat already has it, so the engine
	// maps it to Chat's General topic instead of opening a new one.
	General bool
	// Created is when the topic was opened; zero when unknown.
	Created time.Time
}

// TopicChange tells that a topic of a conversation was opened or changed
// (renamed, closed, reopened, pinned). The engine creates the topic if it does
// not know it yet.
type TopicChange struct {
	Conversation string
	Topic        Topic
}

// PinChange tells that messages of a conversation were pinned or unpinned in
// the other app. A message the engine has not imported (it is older than the
// history window) is skipped.
type PinChange struct {
	Conversation string
	IDs          []string // Message.ID
	Pinned       bool
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

// Read tells that the other side of a conversation read the owner's
// messages up to MaxID. Message ids of an adapter that sends it are decimal
// integers that grow with time, so the engine can tell which messages that
// covers without having imported MaxID itself.
type Read struct {
	Conversation string
	MaxID        string
}

// Event is one normalised update. Exactly one of Message, Edit, Delete,
// Conversation, Topic, Pin, Seen, Read, Reactions or Participant is set.
// Participant alone tells that a person's online status changed (SeenKnown). State is the account state after this event; the
// engine stores it in the same transaction as the write, so a crash between
// the two is replayed, not lost.
type Event struct {
	Message      *Message
	Edit         *Edit
	Delete       *Delete
	Conversation *Conversation
	Topic        *TopicChange
	Pin          *PinChange
	Seen         *Seen
	Read         *Read
	Reactions    *Reactions
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

// RateLimitError is returned by an adapter call the other app throttled
// (Telegram FloodWait). The engine waits RetryAfter and tries again from the
// same state instead of treating it as a failure.
type RateLimitError struct{ RetryAfter time.Duration }

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("bridge: rate limited, retry after %v", e.RetryAfter)
}

// ErrSessionRevoked is returned when the other app no longer accepts the
// stored login (the user ended the session there). The account needs a new
// login; retrying cannot help.
var ErrSessionRevoked = errors.New("bridge: session revoked in the other app")

// ErrGapTooLarge is returned by Subscribe when the other app cannot replay
// what was missed since acct.State. The engine then reconciles the window
// of every synced chat again.
var ErrGapTooLarge = errors.New("bridge: update gap too large to replay")

// InputError is returned by Login when the user's answer is wrong (a bad
// code or password): the step stays open and the message may be shown to
// the user. Any other error from Login is a failure of the call itself.
type InputError struct{ Message string }

func (e *InputError) Error() string { return e.Message }

// OutMessage is a message Chat sends into a conversation of the other app.
type OutMessage struct {
	Conversation string
	Text         string
	Entities     []Entity
	// ReplyTo is the Message.ID of the message answered, in the same
	// conversation; empty for a plain message.
	ReplyTo string
	// Topic is the topic to post in (a Topic.ID of a forum conversation);
	// empty for a conversation without topics.
	Topic string
	// Media is empty for a text message, one item for a photo or file, and
	// several for an album. Text then is the caption of the first item.
	Media []OutMedia
	// RandomID makes the send idempotent: the engine stores it before the
	// call and repeats it when a retry follows a crash, so the other app can
	// answer with the message it already took instead of creating a second.
	// An album takes one RandomID; the adapter derives the id of item i as
	// RandomID+i, the same way on every retry.
	RandomID int64
	// RetrySince is zero unless an earlier call with this RandomID may have
	// created the message: the send went 'unknown' (cut off by a stop, in
	// flight too long, or failed without saying nothing went out) and the
	// owner retried it, possibly in another process. Then it is when the send
	// was queued, so no earlier call was made before it. An adapter that
	// recognises a repeat only within limits (RetryUnsafe) looks for the
	// earlier copy only when this is set or the RandomID is one it tried
	// itself; any other RandomID is new and goes out at once.
	RetrySince time.Time
}

// OutMedia is a file attached to an OutMessage. Open returns the bytes anew
// on each call so a retry can read them again; the caller closes the reader.
type OutMedia struct {
	Kind     string // photo, video, audio, voice, document ...
	MimeType string
	Name     string
	Size     int64
	Width    int
	Height   int
	Duration time.Duration
	Open     func() (io.ReadCloser, error)
}

// SentRef says what the other app created for one OutMessage: one id for a
// message, one per item for an album.
type SentRef struct {
	IDs  []string
	Date time.Time
}

// EditRequest replaces the text of a message sent by the account owner.
type EditRequest struct {
	Conversation string
	ID           string
	Text         string
	Entities     []Entity
}

// TopicReader is implemented by an adapter that declares CapTopics.
type TopicReader interface {
	// ListTopics returns the topics of a forum conversation, in any order.
	// A large forum is read page by page inside the call; a throttle comes
	// back as *RateLimitError like any other call.
	ListTopics(ctx context.Context, acct Account, conv string) ([]Topic, error)
}

// PinReader is implemented by an adapter that declares CapPins.
type PinReader interface {
	// ListPinned returns the ids of the pinned messages of a conversation,
	// newest first. The list belongs to the whole conversation, a forum
	// included. A long list is read page by page inside the call.
	ListPinned(ctx context.Context, acct Account, conv string) ([]string, error)
}

// Pinner is implemented by an adapter that declares both CapSend and CapPins.
// Without the right to pin the call returns ErrNotAllowed; pinning what is
// already pinned, or unpinning what is not, succeeds without effect.
type Pinner interface {
	// PinMessage pins or unpins one message, without notifying the members.
	PinMessage(ctx context.Context, acct Account, conv, id string, pinned bool) error
	// PinTopic pins or unpins a topic of a forum conversation.
	PinTopic(ctx context.Context, acct Account, conv, topic string, pinned bool) error
}

// Sender is implemented by an adapter that declares CapSend. Calls follow
// the Adapter rules: one account at a time, from one goroutine at a time.
type Sender interface {
	// SendMessage creates the message and returns its ids. A repeated
	// RandomID must not create a second message; if the app cannot promise
	// that, the adapter must not declare CapSend, unless it recognises a
	// repeat within limits of its own and implements RetryUnsafe.
	SendMessage(ctx context.Context, acct Account, m OutMessage) (SentRef, error)
	// EditMessage changes the text of a message the account owner sent.
	EditMessage(ctx context.Context, acct Account, e EditRequest) error
	// DeleteMessages removes messages for everyone in the conversation.
	DeleteMessages(ctx context.Context, acct Account, d Delete) error
}

// RetryUnsafe marks a Sender whose calls are not safe to repeat blindly: it
// recognises a repeated RandomID only within limits (not after every restart),
// so a call that may have gone out could post twice if sent again. The engine
// never repeats such a call on its own: a row left in flight by a stop, and a
// call that failed for a reason that does not say nothing went out, become
// 'unknown' for the owner to retry or dismiss. Other Senders are retried.
type RetryUnsafe interface {
	RetryUnsafe()
}

// ErrNotAllowed is returned when the other app refuses the action for
// this account (no right to post in a channel, blocked by the user, not a
// member). Retrying cannot help; the message is shown as failed with the
// reason (wrap the error to carry it).
var ErrNotAllowed = errors.New("bridge: not allowed in the other app")

// ErrEditExpired is returned when a message can no longer be edited or
// deleted in the other app (a time limit passed). Retrying cannot help.
var ErrEditExpired = errors.New("bridge: message can no longer be changed in the other app")

// ErrTooLarge is returned when a file is over the other app's size limit.
var ErrTooLarge = errors.New("bridge: file too large for the other app")

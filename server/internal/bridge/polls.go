package bridge

import "context"

// Poll is a poll a message of the other app carries (Message.Poll).
type Poll struct {
	Question string
	// Options are the answers, in order; an answer is named by its index.
	Options  []string
	Multiple bool
	// Public: members of the other app see who chose what.
	Public bool
	Quiz   bool
	// Results are the poll's state when the message was read (their Conversation
	// and ID may be empty there: the message names them).
	Results PollResults
}

// PollResults is the state of a poll: what an Event.Poll reports when the votes or the
// closing changed, and what PollReader returns.
type PollResults struct {
	Conversation string
	ID           string // Message.ID of the poll
	Closed       bool
	// Counts are the votes of each answer, everyone counted; nil when the app did not
	// tell them (they are then left as they are). Voters goes with them.
	Counts []int
	Voters int
	// OwnerKnown says Chosen is the owner's answers (empty: the owner did not vote).
	OwnerKnown bool
	Chosen     []int
	// Correct and Explanation are a quiz's answer, once the app tells it.
	Correct     []int
	Explanation string
	// VotesKnown says Votes names who chose what (a public poll whose voters the app
	// lists); VotesComplete that it names everyone who voted. The owner may be among them.
	VotesKnown    bool
	VotesComplete bool
	Votes         []PollVote
}

// PollVote is the answers of one person to a public poll.
type PollVote struct {
	From    Participant
	Options []int
}

// OutPoll is a poll Chat sends (OutMessage.Poll).
type OutPoll struct {
	Question    string
	Options     []string
	Multiple    bool
	Public      bool
	Quiz        bool
	Correct     []int
	Explanation string
}

// PollReader is implemented by an adapter that tells the results of polls. Changes
// may also arrive as events; the engine reads the open polls of a chat on a timer for
// what the other app did not tell.
type PollReader interface {
	// PollResults returns the state of the polls among ids of a conversation, one entry
	// per poll it knows; an id that is gone or not a poll is left out.
	PollResults(ctx context.Context, acct Account, conv string, ids []string) ([]PollResults, error)
}

// PollWriter is implemented by an adapter that takes the owner's votes and closings.
type PollWriter interface {
	// VotePoll makes the owner's answers to a poll options (indexes), or takes the vote
	// back when options is empty. A closed poll, or one the owner may not vote in,
	// returns ErrNotAllowed.
	VotePoll(ctx context.Context, acct Account, conv, id string, options []int) error
	// ClosePoll closes a poll the owner sent; closing a closed poll succeeds.
	ClosePoll(ctx context.Context, acct Account, conv, id string) error
}

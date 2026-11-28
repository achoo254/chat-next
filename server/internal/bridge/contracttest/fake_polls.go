package contracttest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// The fake keeps the state of each poll by its message, starting from the
// Poll.Results of the message in the history. The owner's answers are in Chosen.

// SetPollRemotely makes the state of a poll what results says, as if people had voted
// (or the poll closed) in the app. PollResults answers it; push also tells it as a
// live event.
func (f *Fake) SetPollRemotely(conv, id string, results bridge.PollResults, push bool) {
	f.mu.Lock()
	results.Conversation, results.ID = conv, id
	f.polls[reactionKey(conv, id)] = &results
	f.mu.Unlock()
	if push {
		f.Push(bridge.Event{Poll: &results})
	}
}

// PollCalls lists the calls Chat made to polls, as "<conv>/<id>:vote:<answers>" or
// "<conv>/<id>:close".
func (f *Fake) PollCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.pollCalls...)
}

// pollOf is the state of a poll of the history, or nil when the message is not a
// poll; f.mu is held.
func (f *Fake) pollOf(conv, id string) *bridge.PollResults {
	if p := f.polls[reactionKey(conv, id)]; p != nil {
		return p
	}
	for _, m := range f.history[conv] {
		if m.ID == id && m.Poll != nil {
			r := m.Poll.Results
			r.Conversation, r.ID = conv, id
			r.Counts = slices.Clone(r.Counts)
			f.polls[reactionKey(conv, id)] = &r
			return &r
		}
	}
	return nil
}

// PollResults implements bridge.PollReader.
func (f *Fake) PollResults(_ context.Context, _ bridge.Account, conv string, ids []string) ([]bridge.PollResults, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []bridge.PollResults
	for _, id := range ids {
		if p := f.pollOf(conv, id); p != nil {
			out = append(out, *p)
		}
	}
	return out, nil
}

// VotePoll implements bridge.PollWriter: the counts follow the owner's change.
func (f *Fake) VotePoll(_ context.Context, _ bridge.Account, conv, id string, options []int) error {
	if !f.canWrite(feature.Messages) {
		return fmt.Errorf("%w: this app does not take votes from Chat", bridge.ErrNotAllowed)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	names := make([]string, len(options))
	for i, o := range options {
		names[i] = fmt.Sprint(o)
	}
	f.pollCalls = append(f.pollCalls, reactionKey(conv, id)+":vote:"+strings.Join(names, ","))
	p := f.pollOf(conv, id)
	if p == nil || p.Closed {
		return fmt.Errorf("%w: no open poll", bridge.ErrNotAllowed)
	}
	if p.Counts != nil {
		for _, o := range p.Chosen {
			p.Counts[o]--
		}
		for _, o := range options {
			p.Counts[o]++
		}
		if len(p.Chosen) == 0 && len(options) > 0 {
			p.Voters++
		} else if len(p.Chosen) > 0 && len(options) == 0 {
			p.Voters--
		}
	}
	p.Chosen, p.OwnerKnown = slices.Clone(options), true
	return nil
}

// ClosePoll implements bridge.PollWriter.
func (f *Fake) ClosePoll(_ context.Context, _ bridge.Account, conv, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pollCalls = append(f.pollCalls, reactionKey(conv, id)+":close")
	if p := f.pollOf(conv, id); p != nil {
		p.Closed = true
	}
	return nil
}

var (
	_ bridge.PollReader = (*Fake)(nil)
	_ bridge.PollWriter = (*Fake)(nil)
)

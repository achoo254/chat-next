package chat

import (
	"context"
	"fmt"
	"slices"

	appv1 "app.local/server/gen/app/v1"
)

// ImportedPoll is the state of a poll of another app, as that app tells it.
type ImportedPoll struct {
	Closed bool
	// Counts are the votes of each answer, everyone in the other app counted (the
	// owner too); nil when the app did not say, which leaves the results as they are.
	Counts []int32
	Voters int32
	// OwnerKnown says Chosen is the owner's answers there (empty: no vote).
	OwnerKnown bool
	Chosen     []int32
	// Correct and Explanation are the answer of a quiz, once the app tells it; empty
	// leaves what Chat knows.
	Correct     []int32
	Explanation string
}

// pollDefinition is the part of a poll that is content: what was asked and how. The
// results are kept apart (message_polls, poll_votes).
func pollDefinition(p *appv1.Poll) *appv1.Poll {
	if p == nil {
		return nil
	}
	return &appv1.Poll{Question: p.GetQuestion(), Options: p.GetOptions(), Multiple: p.GetMultiple(),
		PublicVoters: p.GetPublicVoters(), Quiz: p.GetQuiz()}
}

// SetPoll makes the poll at seq what the other app says. With keepOwner (Chat has a
// vote of the owner waiting to go out) the owner's answers and the counts stay as
// Chat has them, until the other app has the vote. It reports whether anything
// changed: false when the message is gone, is not a poll, or is already so.
func (it *ImportTx) SetPoll(ctx context.Context, seq int64, p ImportedPoll, keepOwner bool) (bool, error) {
	m, err := it.t.s.liveMessage(ctx, it.t.tx, it.c.ID, seq)
	if isNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	poll, err := pollOf(m)
	if err != nil || poll == nil {
		return false, err
	}
	st, err := lockPoll(ctx, it.t.tx, it.c.ID, seq)
	if err != nil {
		return false, err
	}
	want := *st
	want.closed = st.closed || p.Closed // a poll closed stays closed
	if len(p.Correct) > 0 {
		want.correct = p.Correct
	}
	if p.Explanation != "" {
		want.explanation = p.Explanation
	}
	if p.Counts != nil && !keepOwner {
		counts := make([]int32, len(poll.GetOptions()))
		copy(counts, p.Counts)
		want.extCounts, want.extVoters = counts, p.Voters
	}
	changed := want.closed != st.closed || !slices.Equal(want.correct, st.correct) || want.explanation != st.explanation ||
		(want.extCounts != nil && (st.extCounts == nil || !slices.Equal(want.extCounts, st.extCounts) || want.extVoters != st.extVoters))
	if changed {
		var voters *int32
		if want.extCounts != nil {
			voters = &want.extVoters
		}
		if _, err := it.t.tx.Exec(ctx, `
			UPDATE message_polls SET closed = $3, correct = $4, explanation = $5, external_counts = $6, external_voters = $7
			WHERE chat_id = $1 AND seq = $2`,
			it.c.ID, seq, want.closed, narrow(nonNil(want.correct)), want.explanation, want.extCounts, voters); err != nil {
			return false, fmt.Errorf("chat: import poll: %w", err)
		}
	}
	if p.OwnerKnown && !keepOwner {
		chosen, err := checkAnswers(&appv1.Poll{Options: poll.GetOptions(), Multiple: true}, p.Chosen)
		if err != nil {
			chosen = nil // an answer Chat cannot name: the owner's vote is left out, not the poll
		}
		moved, err := storeVote(ctx, it.t.tx, it.c.ID, seq, it.owner, chosen)
		if err != nil {
			return false, err
		}
		changed = changed || moved
	}
	if !changed {
		return false, nil
	}
	return true, it.t.tellPoll(ctx, it.c, seq, it.owner)
}

func nonNil(xs []int32) []int32 {
	if xs == nil {
		return []int32{}
	}
	return xs
}

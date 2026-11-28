package telegram

import (
	"slices"
	"testing"

	"github.com/gotd/td/tg"
)

func lunchPoll(results tg.PollResults) *tg.MessageMediaPoll {
	return &tg.MessageMediaPoll{
		Poll: tg.Poll{ID: 7, Question: tg.TextWithEntities{Text: "Ăn gì?"}, MultipleChoice: true, Answers: []tg.PollAnswerClass{
			&tg.PollAnswer{Text: tg.TextWithEntities{Text: "Phở"}, Option: []byte("a")},
			&tg.PollAnswer{Text: tg.TextWithEntities{Text: "Bún"}, Option: []byte("b")},
			&tg.PollAnswer{Text: tg.TextWithEntities{Text: "Cơm"}, Option: []byte("c")},
		}},
		Results: results,
	}
}

func TestAPollIsReadWithItsAnswersCountsAndTheOwnersChoice(t *testing.T) {
	// Telegram lists results by answer id, in any order.
	p := mapPoll(lunchPoll(tg.PollResults{TotalVoters: 4, Results: []tg.PollAnswerVoters{
		{Option: []byte("c"), Voters: 1, Chosen: true},
		{Option: []byte("a"), Voters: 3},
	}}))
	if p.Question != "Ăn gì?" || !slices.Equal(p.Options, []string{"Phở", "Bún", "Cơm"}) || !p.Multiple || p.Quiz {
		t.Fatalf("poll = %+v", p)
	}
	r := p.Results
	if !slices.Equal(r.Counts, []int{3, 0, 1}) || r.Voters != 4 || !r.OwnerKnown || !slices.Equal(r.Chosen, []int{2}) {
		t.Fatalf("results = %+v", r)
	}
}

func TestResultsTelegramHidesOrGivesInShortLeaveWhatIsUnknown(t *testing.T) {
	// Results shown only to voters: no counts, and nothing said of the owner.
	r := mapPoll(lunchPoll(tg.PollResults{})).Results
	if r.Counts != nil || r.OwnerKnown {
		t.Fatalf("hidden results = %+v", r)
	}
	// A "min" answer has the counts but not the owner's choice.
	r = mapPoll(lunchPoll(tg.PollResults{Min: true, TotalVoters: 1, Results: []tg.PollAnswerVoters{{Option: []byte("b"), Voters: 1, Chosen: true}}})).Results
	if !slices.Equal(r.Counts, []int{0, 1, 0}) || r.OwnerKnown || len(r.Chosen) != 0 {
		t.Fatalf("min results = %+v", r)
	}
}

func TestAQuizTellsItsAnswerOnceTelegramDoes(t *testing.T) {
	m := lunchPoll(tg.PollResults{TotalVoters: 1, Solution: "vì ngon", Results: []tg.PollAnswerVoters{
		{Option: []byte("b"), Voters: 1, Chosen: true, Correct: true},
	}})
	m.Poll.Quiz, m.Poll.MultipleChoice, m.Poll.Closed = true, false, true
	p := mapPoll(m)
	if !p.Quiz || !p.Results.Closed || !slices.Equal(p.Results.Correct, []int{1}) || p.Results.Explanation != "vì ngon" {
		t.Fatalf("quiz = %+v", p)
	}
}

func TestAMessageWithAPollCarriesItInsteadOfAFile(t *testing.T) {
	m, ok := newPeerBook().mapMessage(&tg.Message{ID: 5, PeerID: &tg.PeerChat{ChatID: 9}, FromID: &tg.PeerUser{UserID: 3},
		Media: lunchPoll(tg.PollResults{})}, 1)
	if !ok || m.Poll == nil || len(m.Media) != 0 || m.Poll.Question != "Ăn gì?" {
		t.Fatalf("message = %+v", m)
	}
}

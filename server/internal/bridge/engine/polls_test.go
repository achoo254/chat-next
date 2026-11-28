package engine_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// pollIn is the poll of a message of Chat as the owner sees it.
func (e *env) pollIn(chatID, seq int64) *appv1.Poll {
	e.t.Helper()
	resp, err := e.chat.GetHistory(context.Background(), e.owner, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil {
		e.t.Fatal(err)
	}
	for _, m := range resp.GetMessages() {
		if m.GetSeq() == seq {
			return m.GetPoll()
		}
	}
	return nil
}

// pollShape is what a test compares of a poll: counts, voters, the owner's answers, closed.
func pollShape(p *appv1.Poll) string {
	if p == nil {
		return "no poll"
	}
	return fmt.Sprintf("%v/%d chosen=%v closed=%v", p.GetCounts(), p.GetVoters(), p.GetChosen(), p.GetClosed())
}

func (e *env) waitPoll(chatID, seq int64, want string) {
	e.t.Helper()
	e.eventually(func() bool { return pollShape(e.pollIn(chatID, seq)) == want },
		func() string { return fmt.Sprintf("poll = %s, want %s", pollShape(e.pollIn(chatID, seq)), want) })
}

// twoWayWithPoll syncs both ways a group whose history holds a poll "p1" of Lan,
// which the owner answered with "Bún".
func (e *env) twoWayWithPoll() (int64, int64) {
	e.t.Helper()
	conv := e.group("g1")
	poll := e.msg("p1", lan, "", 1)
	poll.Poll = &bridge.Poll{Question: "Ăn gì?", Options: []string{"Phở", "Bún"}, Results: bridge.PollResults{
		Counts: []int{2, 1}, Voters: 3, OwnerKnown: true, Chosen: []int{1},
	}}
	e.fake.AddHistory("g1", poll, e.msg("m2", lan, "tin 2", 2))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 2"}) // the poll has no text
	if err := e.chat.SetImportedDirection(context.Background(), e.owner, chatID, chat.DirectionBoth); err != nil {
		e.t.Fatal(err)
	}
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	return chatID, e.seqOf(chatID, "p1")
}

func (e *env) vote(chatID, seq int64, options ...int32) {
	e.t.Helper()
	if _, err := e.chat.VotePoll(context.Background(), e.owner, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: options}); err != nil {
		e.t.Fatal(err)
	}
}

func TestAPollOfTheOtherAppComesInWithItsResultsAndFollowsThem(t *testing.T) {
	e := newEnv(t)
	chatID, seq := e.twoWayWithPoll()
	p := e.pollIn(chatID, seq)
	if p.GetQuestion() != "Ăn gì?" || !slices.Equal(p.GetOptions(), []string{"Phở", "Bún"}) {
		t.Fatalf("poll = %v", p)
	}
	e.waitPoll(chatID, seq, "[2 1]/3 chosen=[1] closed=false")

	// A vote there, told as an event.
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{Counts: []int{3, 1}, Voters: 4, OwnerKnown: true, Chosen: []int{1}}, true)
	e.waitPoll(chatID, seq, "[3 1]/4 chosen=[1] closed=false")
	// One that comes with no event is read on a look; so is the closing.
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{Counts: []int{3, 2}, Voters: 5, OwnerKnown: true, Chosen: []int{1}, Closed: true}, false)
	e.waitPoll(chatID, seq, "[3 2]/5 chosen=[1] closed=true")
	// A poll Chat has not imported is skipped without harm.
	e.fake.Push(bridge.Event{Poll: &bridge.PollResults{Conversation: "g1", ID: "404", Counts: []int{1}}})
}

func TestTheOwnersVoteInChatGoesOutAndTheResultsCountIt(t *testing.T) {
	e := newEnv(t)
	chatID, seq := e.twoWayWithPoll()
	e.waitPoll(chatID, seq, "[2 1]/3 chosen=[1] closed=false")

	e.vote(chatID, seq, 0)
	// Chat counts the change at once.
	e.waitPoll(chatID, seq, "[3 0]/3 chosen=[0] closed=false")
	e.eventually(func() bool { return fmt.Sprint(e.fake.PollCalls()) == "[g1/p1:vote:0]" }, func() string { return fmt.Sprint(e.fake.PollCalls()) })
	// Several looks later Chat still agrees with the other app.
	time.Sleep(300 * time.Millisecond)
	e.waitPoll(chatID, seq, "[3 0]/3 chosen=[0] closed=false")

	e.vote(chatID, seq)
	e.eventually(func() bool { return len(e.fake.PollCalls()) == 2 }, func() string { return fmt.Sprint(e.fake.PollCalls()) })
	e.waitPoll(chatID, seq, "[2 0]/2 chosen=[] closed=false")
}

func TestWhileTheOwnersVoteWaitsToGoOutTheOtherAppDoesNotUndoIt(t *testing.T) {
	e := newEnv(t)
	chatID, seq := e.twoWayWithPoll()
	e.waitPoll(chatID, seq, "[2 1]/3 chosen=[1] closed=false")
	e.stop()
	e.vote(chatID, seq, 0)
	// The other app still has the owner on "Bún" and tells it.
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{Counts: []int{2, 1}, Voters: 3, OwnerKnown: true, Chosen: []int{1}}, true)
	e.start()
	e.eventually(func() bool { return len(e.fake.PollCalls()) == 1 }, func() string { return fmt.Sprint(e.fake.PollCalls()) })
	e.waitPoll(chatID, seq, "[3 0]/3 chosen=[0] closed=false")
}

func TestAPollTheOwnerSendsFromChatGoesOutAndClosesThere(t *testing.T) {
	e := newEnv(t)
	chatID, _ := e.twoWayWithPoll()
	resp, err := e.chat.SendPoll(context.Background(), e.owner, &appv1.SendPollRequest{
		ChatId: chatID, Question: "2+2?", Options: []string{"3", "4"}, Quiz: true, Correct: 1, Explanation: "dễ",
	})
	if err != nil {
		t.Fatal(err)
	}
	seq := resp.GetMessage().GetSeq()
	var sent bridge.OutMessage
	e.eventually(func() bool {
		for _, m := range e.fake.Sent() {
			if m.Poll != nil {
				sent = m
				return true
			}
		}
		return false
	}, func() string { return fmt.Sprint(e.fake.Sent()) })
	if p := sent.Poll; p.Question != "2+2?" || !slices.Equal(p.Options, []string{"3", "4"}) || !p.Quiz ||
		!slices.Equal(p.Correct, []int{1}) || p.Explanation != "dễ" || sent.Text != "" {
		t.Fatalf("sent poll = %+v", sent)
	}
	if _, err := e.chat.ClosePoll(context.Background(), e.owner, &appv1.ClosePollRequest{ChatId: chatID, Seq: seq}); err != nil {
		t.Fatal(err)
	}
	var ext string
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT external_msg_id FROM external_messages WHERE chat_id = $1 AND seq = $2`, chatID, seq).Scan(&ext); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool {
		calls := e.fake.PollCalls()
		return len(calls) == 1 && calls[0] == "g1/"+ext+":close"
	}, func() string { return fmt.Sprint(e.fake.PollCalls()) })
}

func TestAPollTheOtherAppRefusesAVoteInIsPutBack(t *testing.T) {
	e := newEnv(t)
	chatID, seq := e.twoWayWithPoll()
	e.waitPoll(chatID, seq, "[2 1]/3 chosen=[1] closed=false")
	e.fake.FailPin(fmt.Errorf("%w: POLL_VOTE_REQUIRED", bridge.ErrNotAllowed))
	e.vote(chatID, seq, 0)
	e.waitOutbox(chatID, seq, "poll_vote", "failed")
	e.waitPoll(chatID, seq, "[2 1]/3 chosen=[1] closed=false")
}

func TestAClosingTheOtherAppRefusesOpensThePollAgain(t *testing.T) {
	e := newEnv(t)
	chatID, _ := e.twoWayWithPoll()
	resp, err := e.chat.SendPoll(context.Background(), e.owner, &appv1.SendPollRequest{ChatId: chatID, Question: "q", Options: []string{"a", "b"}})
	if err != nil {
		t.Fatal(err)
	}
	seq := resp.GetMessage().GetSeq()
	e.eventually(func() bool { return len(e.fake.Sent()) > 0 }, func() string { return "the poll was not sent" })
	e.waitOutbox(chatID, seq, "send", "sent")
	e.fake.FailPin(fmt.Errorf("%w: MESSAGE_EDIT_TIME_EXPIRED", bridge.ErrNotAllowed))
	if _, err := e.chat.ClosePoll(context.Background(), e.owner, &appv1.ClosePollRequest{ChatId: chatID, Seq: seq}); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, seq, "poll_close", "failed")
	e.eventually(func() bool { p := e.pollIn(chatID, seq); return p != nil && !p.GetClosed() },
		func() string { return "still closed: " + pollShape(e.pollIn(chatID, seq)) })
}

func TestResultsTheOtherAppHidesAreShownAsHiddenNotCountedInChat(t *testing.T) {
	e := newEnv(t)
	chatID, seq := e.twoWayWithPoll()
	e.waitPoll(chatID, seq, "[2 1]/3 chosen=[1] closed=false")
	// A poll that hides its results until it closes: Telegram stops telling the counts.
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{}, true)
	time.Sleep(200 * time.Millisecond)
	// Counts already known stay; a poll first seen without them is hidden.
	conv := e.group("g2")
	poll := e.msg("p2", lan, "", 1)
	poll.Poll = &bridge.Poll{Question: "Bí mật?", Options: []string{"Có", "Không"}}
	e.fake.AddHistory("g2", poll, e.msg("m3", lan, "tin 3", 2))
	other := e.enable(conv, 100)
	e.waitTexts(other, []string{"tin 3"})
	e.eventually(func() bool { p := e.pollIn(other, e.seqOf(other, "p2")); return p != nil && p.GetResultsHidden() },
		func() string { return "not hidden: " + fmt.Sprint(e.pollIn(other, e.seqOf(other, "p2"))) })
	if p := e.pollIn(chatID, seq); p.GetResultsHidden() || !slices.Equal(p.GetCounts(), []int32{2, 1}) {
		t.Fatalf("known results changed: %v", p)
	}
}

func TestWhoVotedInAPublicPollOfTheOtherAppIsListedInChat(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	poll := e.msg("p1", lan, "", 1)
	poll.Poll = &bridge.Poll{Question: "Ai đi?", Options: []string{"Đi", "Không"}, Public: true, Results: bridge.PollResults{Counts: []int{0, 0}}}
	e.fake.AddHistory("g1", poll, e.msg("m2", lan, "tin 2", 2))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 2"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	seq := e.seqOf(chatID, "p1")
	minh := bridge.Participant{ID: "u-minh", Name: "Minh"}
	voters := func() string {
		resp, err := e.chat.GetPollVoters(context.Background(), e.owner, &appv1.GetPollVotersRequest{ChatId: chatID, Seq: seq})
		if err != nil {
			return err.Error()
		}
		var out []string
		for _, a := range resp.GetAnswers() {
			out = append(out, fmt.Sprintf("%d:%d", a.GetCount(), len(a.GetUserIds())))
		}
		return fmt.Sprint(out)
	}
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{Counts: []int{2, 1}, Voters: 3, OwnerKnown: true,
		VotesKnown: true, VotesComplete: true, Votes: []bridge.PollVote{{From: lan, Options: []int{0}}, {From: minh, Options: []int{0}}, {From: self, Options: []int{1}}}}, true)
	e.eventually(func() bool { return voters() == "[2:2 1:0]" }, func() string { return voters() })
	// Minh takes the vote back there: Chat drops it.
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{Counts: []int{1, 1}, Voters: 2, OwnerKnown: true,
		VotesKnown: true, VotesComplete: true, Votes: []bridge.PollVote{{From: lan, Options: []int{0}}}}, true)
	e.eventually(func() bool { return voters() == "[1:1 1:0]" }, func() string { return voters() })
}

func TestResultsOlderThanTheOwnersVoteJustSentDoNotUndoIt(t *testing.T) {
	e := newEnv(t)
	chatID, seq := e.twoWayWithPoll()
	e.waitPoll(chatID, seq, "[2 1]/3 chosen=[1] closed=false")
	e.vote(chatID, seq, 0)
	e.waitOutbox(chatID, seq, "poll_vote", "sent")
	// Telegram, a moment after the vote, still tells the results from before it.
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{Counts: []int{2, 1}, Voters: 3, OwnerKnown: true, Chosen: []int{1}}, true)
	time.Sleep(300 * time.Millisecond)
	e.waitPoll(chatID, seq, "[3 0]/3 chosen=[0] closed=false")
	// Once they carry the vote, they count (here with one more voter).
	e.fake.SetPollRemotely("g1", "p1", bridge.PollResults{Counts: []int{4, 0}, Voters: 4, OwnerKnown: true, Chosen: []int{0}}, true)
	e.waitPoll(chatID, seq, "[4 0]/4 chosen=[0] closed=false")
}

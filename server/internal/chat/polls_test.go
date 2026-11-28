package chat

import (
	"context"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

func (h *harness) poll(from, chatID int64, req *appv1.SendPollRequest) int64 {
	h.t.Helper()
	req.ChatId = chatID
	resp, err := h.svc.SendPoll(context.Background(), from, req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp.GetMessage().GetSeq()
}

func (h *harness) pollSeenBy(viewer, chatID, seq int64) *appv1.Poll {
	h.t.Helper()
	resp, err := h.svc.GetHistory(context.Background(), viewer, &appv1.GetHistoryRequest{ChatId: chatID})
	if err != nil {
		h.t.Fatal(err)
	}
	for _, m := range resp.GetMessages() {
		if m.GetSeq() == seq {
			return m.GetPoll()
		}
	}
	h.t.Fatalf("message %d not in history", seq)
	return nil
}

func TestAPollCountsVotesAndShowsEachVoterTheirOwn(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b, c)
	seq := h.poll(a, chatID, &appv1.SendPollRequest{Question: " Ăn gì? ", Options: []string{"Phở", "Bún", "Cơm"}, Multiple: true})

	for _, v := range []struct {
		user int64
		opts []int32
	}{{a, []int32{0}}, {b, []int32{2, 0}}, {c, []int32{1}}} {
		if _, err := h.svc.VotePoll(ctx, v.user, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: v.opts}); err != nil {
			t.Fatal(err)
		}
	}
	p := h.pollSeenBy(b, chatID, seq)
	if p.GetQuestion() != "Ăn gì?" || !slices.Equal(p.GetCounts(), []int32{2, 1, 1}) || p.GetVoters() != 3 {
		t.Fatalf("poll = %v", p)
	}
	if !slices.Equal(p.GetChosen(), []int32{0, 2}) {
		t.Fatalf("b chose %v, want [0 2]", p.GetChosen())
	}

	// Taking a vote back.
	resp, err := h.svc.VotePoll(ctx, c, &appv1.VotePollRequest{ChatId: chatID, Seq: seq})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetPoll(); !slices.Equal(got.GetCounts(), []int32{2, 0, 1}) || got.GetVoters() != 2 || len(got.GetChosen()) != 0 {
		t.Fatalf("after taking back: %v", got)
	}

	// Members get the change as an update carrying the poll as they see it.
	h.drain()
	var seen *appv1.Poll
	for _, u := range h.sink.updatesOf(b) {
		if up := u.GetPoll(); up != nil && up.GetSeq() == seq {
			seen = up.GetPoll()
		}
	}
	if seen == nil || !slices.Equal(seen.GetChosen(), []int32{0, 2}) || seen.GetVoters() != 2 {
		t.Fatalf("realtime poll for b = %v", seen)
	}
	// The stored log renders it again on catch-up.
	var logged *appv1.Poll
	for _, u := range h.logOf(b) {
		if up := u.GetPoll(); up != nil && up.GetSeq() == seq {
			logged = up.GetPoll()
		}
	}
	if logged == nil || logged.GetVoters() != 2 {
		t.Fatalf("logged poll for b = %v", logged)
	}
}

func TestAPollRefusesWhatItDoesNotTake(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	for name, req := range map[string]*appv1.SendPollRequest{
		"no question":     {Options: []string{"x", "y"}},
		"one answer":      {Question: "q", Options: []string{"x"}},
		"same answers":    {Question: "q", Options: []string{"x", "x"}},
		"eleven answers":  {Question: "q", Options: []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"}},
		"quiz, multiple":  {Question: "q", Options: []string{"x", "y"}, Quiz: true, Multiple: true},
		"quiz, no answer": {Question: "q", Options: []string{"x", "y"}, Quiz: true, Correct: 2},
	} {
		req.ChatId = chatID
		if _, err := h.svc.SendPoll(ctx, a, req); codeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	seq := h.poll(a, chatID, &appv1.SendPollRequest{Question: "q", Options: []string{"x", "y"}})
	for name, opts := range map[string][]int32{"two on single": {0, 1}, "out of range": {2}, "twice": {0, 0}} {
		if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: opts}); codeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	text := h.send(a, chatID, "not a poll").GetMessage().GetSeq()
	if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: chatID, Seq: text, Options: []int32{0}}); codeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("vote on text: err = %v", err)
	}
	if _, err := h.svc.EditMessage(ctx, a, &appv1.EditMessageRequest{ChatId: chatID, Seq: seq, Text: "changed"}); codeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("edit a poll: err = %v", err)
	}
}

func TestOnlyTheSenderClosesAPollAndThenNobodyVotes(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	seq := h.poll(a, chatID, &appv1.SendPollRequest{Question: "q", Options: []string{"x", "y"}})
	if _, err := h.svc.ClosePoll(ctx, b, &appv1.ClosePollRequest{ChatId: chatID, Seq: seq}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("b closes: err = %v", err)
	}
	resp, err := h.svc.ClosePoll(ctx, a, &appv1.ClosePollRequest{ChatId: chatID, Seq: seq})
	if err != nil || !resp.GetPoll().GetClosed() {
		t.Fatalf("a closes: %v, %v", resp, err)
	}
	if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: []int32{0}}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("vote on closed: err = %v", err)
	}
}

func TestAQuizShowsItsAnswerOnlyAfterAVoteAndTakesOneVote(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	seq := h.poll(a, chatID, &appv1.SendPollRequest{Question: "2+2?", Options: []string{"3", "4"}, Quiz: true, Correct: 1, Explanation: "dễ"})
	if p := h.pollSeenBy(b, chatID, seq); len(p.GetCorrect()) != 0 || p.GetExplanation() != "" {
		t.Fatalf("b sees the answer before voting: %v", p)
	}
	if p := h.pollSeenBy(a, chatID, seq); !slices.Equal(p.GetCorrect(), []int32{1}) || p.GetExplanation() != "dễ" {
		t.Fatalf("the sender does not see the answer: %v", p)
	}
	resp, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: []int32{0}})
	if err != nil || !slices.Equal(resp.GetPoll().GetCorrect(), []int32{1}) {
		t.Fatalf("after voting: %v, %v", resp, err)
	}
	if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: []int32{1}}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("second answer to a quiz: err = %v", err)
	}
}

func TestAForwardedPollIsANewPollWithoutVotes(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	from, to := h.group(a, b), h.group(a, b)
	seq := h.poll(a, from, &appv1.SendPollRequest{Question: "q", Options: []string{"x", "y"}, Quiz: true, Correct: 0})
	if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: from, Seq: seq, Options: []int32{0}}); err != nil {
		t.Fatal(err)
	}
	resp, err := h.svc.ForwardMessages(ctx, a, &appv1.ForwardMessagesRequest{FromChatId: from, Seqs: []int64{seq}, ToChatId: to})
	if err != nil {
		t.Fatal(err)
	}
	fwd := resp.GetMessages()[0].GetSeq()
	p := h.pollSeenBy(b, to, fwd)
	if p.GetVoters() != 0 || len(p.GetChosen()) != 0 {
		t.Fatalf("forwarded poll = %v", p)
	}
	if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: to, Seq: fwd, Options: []int32{1}}); err != nil {
		t.Fatal(err)
	}
	if p := h.pollSeenBy(b, to, fwd); !slices.Equal(p.GetCorrect(), []int32{0}) {
		t.Fatalf("the quiz answer was not kept: %v", p)
	}
}

func TestDeletingAPollDropsItsVotes(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	seq := h.poll(a, chatID, &appv1.SendPollRequest{Question: "q", Options: []string{"x", "y"}})
	if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: []int32{0}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.DeleteMessages(ctx, a, chatID, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := h.st.Pool().QueryRow(ctx, `SELECT (SELECT count(*) FROM poll_votes WHERE chat_id = $1) + (SELECT count(*) FROM message_polls WHERE chat_id = $1)`, chatID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d poll rows left", n)
	}
}

func TestAQuizIsPassedOnOnlyByWhoMayKnowItsAnswer(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	from, to := h.group(a, b), h.group(a, b)
	seq := h.poll(a, from, &appv1.SendPollRequest{Question: "q", Options: []string{"x", "y"}, Quiz: true, Correct: 1})
	req := &appv1.ForwardMessagesRequest{FromChatId: from, Seqs: []int64{seq}, ToChatId: to}
	if _, err := h.svc.ForwardMessages(ctx, b, req); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("b forwards before answering: err = %v", err)
	}
	if _, err := h.svc.VotePoll(ctx, b, &appv1.VotePollRequest{ChatId: from, Seq: seq, Options: []int32{0}}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.ForwardMessages(ctx, b, req); err != nil {
		t.Fatalf("b forwards after answering: %v", err)
	}
}

func TestSendPollAnswersWithThePollAsTheSenderSeesIt(t *testing.T) {
	h := newHarness(t, nil)
	a, b := h.user("a"), h.user("b")
	chatID := h.group(a, b)
	resp, err := h.svc.SendPoll(context.Background(), a, &appv1.SendPollRequest{ChatId: chatID, Question: "q", Options: []string{"x", "y"}, Quiz: true, Correct: 1})
	if err != nil {
		t.Fatal(err)
	}
	if p := resp.GetMessage().GetPoll(); !slices.Equal(p.GetCounts(), []int32{0, 0}) || !slices.Equal(p.GetCorrect(), []int32{1}) {
		t.Fatalf("poll = %v", p)
	}
}

func TestAPublicPollListsWhoChoseEachAnswerAndAnAnonymousOneRefuses(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c := h.user("a"), h.user("b"), h.user("c")
	chatID := h.group(a, b, c)
	seq := h.poll(a, chatID, &appv1.SendPollRequest{Question: "q", Options: []string{"x", "y"}, Multiple: true, PublicVoters: true})
	for _, v := range []struct {
		user int64
		opts []int32
	}{{b, []int32{0}}, {c, []int32{0, 1}}} {
		if _, err := h.svc.VotePoll(ctx, v.user, &appv1.VotePollRequest{ChatId: chatID, Seq: seq, Options: v.opts}); err != nil {
			t.Fatal(err)
		}
	}
	resp, err := h.svc.GetPollVoters(ctx, a, &appv1.GetPollVotersRequest{ChatId: chatID, Seq: seq})
	if err != nil {
		t.Fatal(err)
	}
	got := resp.GetAnswers()
	if len(got) != 2 || got[0].GetCount() != 2 || !slices.Equal(got[0].GetUserIds(), []int64{c, b}) ||
		got[1].GetCount() != 1 || !slices.Equal(got[1].GetUserIds(), []int64{c}) {
		t.Fatalf("answers = %v", got)
	}
	if ids := usersIn(resp.GetUsers()); !slices.Contains(ids, b) || !slices.Contains(ids, c) {
		t.Fatalf("users = %v", ids)
	}
	anon := h.poll(a, chatID, &appv1.SendPollRequest{Question: "q", Options: []string{"x", "y"}})
	if _, err := h.svc.GetPollVoters(ctx, a, &appv1.GetPollVotersRequest{ChatId: chatID, Seq: anon}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("anonymous poll: err = %v", err)
	}
}

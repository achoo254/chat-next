package telegram

import (
	"bytes"
	"context"
	"fmt"
	"strconv"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

var (
	_ bridge.PollReader = (*Adapter)(nil)
	_ bridge.PollWriter = (*Adapter)(nil)
)

// mapPoll turns the poll a message carries into the bridge's, results included.
func mapPoll(m *tg.MessageMediaPoll) *bridge.Poll {
	p := &bridge.Poll{
		Question: m.Poll.Question.Text, Multiple: m.Poll.MultipleChoice, Public: m.Poll.PublicVoters, Quiz: m.Poll.Quiz,
	}
	for _, a := range m.Poll.Answers {
		p.Options = append(p.Options, answerText(a))
	}
	p.Results = pollResults(&m.Poll, &m.Results)
	return p
}

// answerText is the text of an answer of a poll.
func answerText(a tg.PollAnswerClass) string {
	switch v := a.(type) {
	case *tg.PollAnswer:
		return v.Text.Text
	case *tg.InputPollAnswer:
		return v.Text.Text
	}
	return ""
}

// answerOption is the id Telegram names an answer by (nil when it has none).
func answerOption(a tg.PollAnswerClass) []byte {
	if v, ok := a.(*tg.PollAnswer); ok {
		return v.Option
	}
	return nil
}

// optionIndex is the index of the answer named option, or -1.
func optionIndex(poll *tg.Poll, option []byte) int {
	for i, a := range poll.Answers {
		if bytes.Equal(answerOption(a), option) {
			return i
		}
	}
	return -1
}

// pollResults reads the results of a poll. Telegram hides the counts from who has
// not voted in some polls (they come with no results then): the counts are unknown.
// A "min" answer does not say what the owner chose.
func pollResults(poll *tg.Poll, r *tg.PollResults) bridge.PollResults {
	out := bridge.PollResults{Closed: poll.Closed, OwnerKnown: !r.Min, Explanation: r.Solution}
	if len(r.Results) > 0 {
		out.Counts = make([]int, len(poll.Answers))
		out.Voters = r.TotalVoters
	}
	for _, v := range r.Results {
		i := optionIndex(poll, v.Option)
		if i < 0 {
			continue
		}
		out.Counts[i] = v.Voters
		if v.Chosen && !r.Min {
			out.Chosen = append(out.Chosen, i)
		}
		if v.Correct {
			out.Correct = append(out.Correct, i)
		}
	}
	if len(r.Results) == 0 && !r.Min {
		// Without results Telegram does not say what the owner chose either.
		out.OwnerKnown = false
	}
	return out
}

// registerPolls makes the dispatcher turn a change of the results of a poll into an
// event. An update without the poll itself is read again, to name the answers.
func registerPolls(d tg.UpdateDispatcher, c *conn, emit func(context.Context, bridge.Event) error) {
	d.OnMessagePoll(func(ctx context.Context, _ tg.Entities, u *tg.UpdateMessagePoll) error {
		peer, ok := u.GetPeer()
		if !ok {
			return nil // no message named: the engine reads open polls on its timer
		}
		conv := convID(peer)
		msgID, ok := u.GetMsgID()
		if conv == "" || !ok {
			return nil
		}
		poll, has := u.GetPoll()
		if !has {
			msg, err := c.pollMessage(ctx, conv, msgID)
			if err != nil || msg == nil {
				return nil // read again on the timer
			}
			poll = msg.Poll
		}
		pr := pollResults(&poll, &u.Results)
		pr.Conversation, pr.ID = conv, strconv.Itoa(msgID)
		return emit(ctx, bridge.Event{Poll: &pr})
	})
}

// messagesByID reads messages of a conversation by id; ids that are gone are left out.
func (c *conn) messagesByID(ctx context.Context, peer tg.InputPeerClass, ids []int) ([]*tg.Message, error) {
	in := make([]tg.InputMessageClass, len(ids))
	for i, id := range ids {
		in[i] = &tg.InputMessageID{ID: id}
	}
	var res tg.MessagesMessagesClass
	var err error
	if ch, ok := peer.(*tg.InputPeerChannel); ok {
		res, err = c.live.api().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{
			Channel: &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash}, ID: in})
	} else {
		res, err = c.live.api().MessagesGetMessages(ctx, in)
	}
	if err != nil {
		return nil, translate(err)
	}
	var raw []tg.MessageClass
	switch v := res.(type) {
	case *tg.MessagesMessages:
		raw = v.Messages
	case *tg.MessagesMessagesSlice:
		raw = v.Messages
	case *tg.MessagesChannelMessages:
		raw = v.Messages
	}
	var out []*tg.Message
	for _, m := range raw {
		if msg, ok := m.(*tg.Message); ok {
			out = append(out, msg)
		}
	}
	return out, nil
}

// pollMessage reads the poll of one message; nil when the message is gone or no poll.
func (c *conn) pollMessage(ctx context.Context, conv string, id int) (*tg.MessageMediaPoll, error) {
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, err
	}
	msgs, err := c.messagesByID(ctx, peer, []int{id})
	if err != nil {
		return nil, err
	}
	for _, m := range msgs {
		if p, ok := m.Media.(*tg.MessageMediaPoll); ok && m.ID == id {
			return p, nil
		}
	}
	return nil, nil
}

// PollResults implements bridge.PollReader.
func (a *Adapter) PollResults(ctx context.Context, acct bridge.Account, conv string, ids []string) ([]bridge.PollResults, error) {
	nums := make([]int, 0, len(ids))
	for _, id := range ids {
		n, err := strconv.Atoi(id)
		if err != nil {
			return nil, fmt.Errorf("telegram: bad message id %q", id)
		}
		nums = append(nums, n)
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, err
	}
	var out []bridge.PollResults
	for start := 0; start < len(nums); start += reactionsPageMax {
		msgs, err := c.messagesByID(ctx, peer, nums[start:min(start+reactionsPageMax, len(nums))])
		if err != nil {
			return nil, err
		}
		for _, m := range msgs {
			p, ok := m.Media.(*tg.MessageMediaPoll)
			if !ok {
				continue
			}
			pr := pollResults(&p.Poll, &p.Results)
			pr.Conversation, pr.ID = conv, strconv.Itoa(m.ID)
			out = append(out, pr)
		}
	}
	return out, nil
}

// translatePoll is translateSend plus what only a poll can answer.
func translatePoll(err error) error {
	if err == nil {
		return nil
	}
	if rpc, ok := tgerr.As(err); ok {
		switch rpc.Type {
		case "MESSAGE_NOT_MODIFIED":
			return nil
		case "MESSAGE_POLL_CLOSED", "POLL_VOTE_REQUIRED", "REVOTE_NOT_ALLOWED", "OPTION_INVALID", "OPTIONS_TOO_MUCH",
			"MSG_ID_INVALID", "MESSAGE_ID_INVALID", "MESSAGE_AUTHOR_REQUIRED", "MESSAGE_EDIT_TIME_EXPIRED",
			"BROADCAST_PUBLIC_VOTERS_FORBIDDEN", "POLL_ANSWERS_INVALID", "POLL_QUESTION_INVALID", "POLL_OPTION_INVALID",
			"QUIZ_CORRECT_ANSWERS_EMPTY", "QUIZ_CORRECT_ANSWER_INVALID", "QUIZ_MULTIPLE_INVALID", "POLL_ANSWER_INVALID":
			return fmt.Errorf("%w: %s", bridge.ErrNotAllowed, rpc.Type)
		}
	}
	return translateSend(err)
}

// pollFor reads the poll of a message for a write on it.
func (c *conn) pollFor(ctx context.Context, conv, id string) (tg.InputPeerClass, int, *tg.MessageMediaPoll, error) {
	n, err := strconv.Atoi(id)
	if err != nil {
		return nil, 0, nil, fmt.Errorf("telegram: bad message id %q", id)
	}
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, 0, nil, err
	}
	p, err := c.pollMessage(ctx, conv, n)
	if err != nil {
		return nil, 0, nil, err
	}
	if p == nil {
		return nil, 0, nil, fmt.Errorf("%w: the message is not a poll", bridge.ErrNotAllowed)
	}
	return peer, n, p, nil
}

// VotePoll implements bridge.PollWriter.
func (a *Adapter) VotePoll(ctx context.Context, acct bridge.Account, conv, id string, options []int) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, n, p, err := c.pollFor(ctx, conv, id)
	if err != nil {
		return err
	}
	chosen := make([][]byte, 0, len(options))
	for _, o := range options {
		if o < 0 || o >= len(p.Poll.Answers) {
			return fmt.Errorf("%w: no answer %d", bridge.ErrNotAllowed, o)
		}
		chosen = append(chosen, answerOption(p.Poll.Answers[o]))
	}
	u, err := c.live.api().MessagesSendVote(ctx, &tg.MessagesSendVoteRequest{Peer: peer, MsgID: n, Options: chosen})
	if err != nil {
		return translatePoll(err)
	}
	c.apply(ctx, u)
	return nil
}

// ClosePoll implements bridge.PollWriter: the poll is edited into a closed one.
func (a *Adapter) ClosePoll(ctx context.Context, acct bridge.Account, conv, id string) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, n, p, err := c.pollFor(ctx, conv, id)
	if err != nil {
		return err
	}
	if p.Poll.Closed {
		return nil
	}
	closed := p.Poll
	closed.Closed = true
	u, err := c.live.api().MessagesEditMessage(ctx, &tg.MessagesEditMessageRequest{
		Peer: peer, ID: n, Media: &tg.InputMediaPoll{Poll: closed}})
	if err != nil {
		return translatePoll(err)
	}
	c.apply(ctx, u)
	return nil
}

// sendPoll posts a poll of Chat.
func (c *conn) sendPoll(ctx context.Context, peer tg.InputPeerClass, m bridge.OutMessage, reply tg.InputReplyToClass) (tg.UpdatesClass, error) {
	p := m.Poll
	poll := tg.Poll{Question: tg.TextWithEntities{Text: p.Question}, MultipleChoice: p.Multiple, PublicVoters: p.Public, Quiz: p.Quiz}
	for _, o := range p.Options {
		poll.Answers = append(poll.Answers, &tg.InputPollAnswer{Text: tg.TextWithEntities{Text: o}})
	}
	media := &tg.InputMediaPoll{Poll: poll}
	if p.Quiz {
		media.CorrectAnswers = p.Correct
		media.Solution = p.Explanation
	}
	return c.live.api().MessagesSendMedia(ctx, &tg.MessagesSendMediaRequest{
		Peer: peer, Media: media, RandomID: m.RandomID, ReplyTo: reply})
}

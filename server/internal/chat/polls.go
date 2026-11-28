package chat

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge/feature"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// pollRecentMax is how many latest voters of each answer a public poll carries.
const pollRecentMax = 3

// Limits of a poll, those of Telegram, so a poll of Chat can go there and one
// from there fits here.
const (
	pollQuestionMax    = 300
	pollOptionMax      = 100
	pollOptionsMin     = 2
	pollOptionsMax     = 10
	pollExplanationMax = 200
)

// pollState is what changes of a poll after it is posted (message_polls).
type pollState struct {
	closed      bool
	correct     []int32
	explanation string
	// extCounts are the results the other app of a synced chat tells (nil for a
	// poll of Chat, counted from poll_votes); extVoters goes with them.
	extCounts []int32
	extVoters int32
}

// pollsOf holds the polls of a set of messages: their state, the votes counted
// in Chat, and the answers of each viewer.
type pollsOf struct {
	state  map[msgKey]*pollState
	counts map[msgKey]map[int32]int32
	voters map[msgKey]int32
	mine   map[memberKey]map[int64][]int32 // (chat, viewer) -> seq -> answers
	// recent: the latest voters of each answer, newest first (pollRecentMax).
	recent map[msgKey]map[int32][]int64
}

// loadPolls reads the polls among the messages of keys. A message that is not a
// poll has no rows and costs nothing but the lookups.
func loadPolls(ctx context.Context, q querier, keys map[int64][]int64, viewers []int64) (*pollsOf, error) {
	p := &pollsOf{state: map[msgKey]*pollState{}, counts: map[msgKey]map[int32]int32{}, voters: map[msgKey]int32{},
		mine: map[memberKey]map[int64][]int32{}, recent: map[msgKey]map[int32][]int64{}}
	chats, seqs := flattenKeys(keys)
	if len(chats) == 0 {
		return p, nil
	}
	rows, err := q.Query(ctx, `
		SELECT p.chat_id, p.seq, p.closed, p.correct, p.explanation, p.external_counts, coalesce(p.external_voters, 0)
		FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
		JOIN message_polls p ON p.chat_id = x.chat_id AND p.seq = x.seq`, chats, seqs)
	if err != nil {
		return nil, fmt.Errorf("chat: load polls: %w", err)
	}
	for rows.Next() {
		var k msgKey
		st := &pollState{}
		var correct []int16
		var ext []int32
		if err := rows.Scan(&k.chatID, &k.seq, &st.closed, &correct, &st.explanation, &ext, &st.extVoters); err != nil {
			rows.Close()
			return nil, fmt.Errorf("chat: load polls: %w", err)
		}
		st.correct = widen(correct)
		st.extCounts = ext
		p.state[k] = st
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: load polls: %w", err)
	}
	if len(p.state) == 0 {
		return p, nil
	}
	// Polls of Chat are counted here; those of another app carry their counts.
	native := map[int64][]int64{}
	for k, st := range p.state {
		if st.extCounts == nil {
			native[k.chatID] = append(native[k.chatID], k.seq)
		}
	}
	if len(native) > 0 {
		nc, ns := flattenKeys(native)
		rows, err = q.Query(ctx, `
			SELECT v.chat_id, v.seq, o.option, count(*)
			FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
			JOIN poll_votes v ON v.chat_id = x.chat_id AND v.seq = x.seq
			CROSS JOIN LATERAL unnest(v.options) AS o(option)
			GROUP BY v.chat_id, v.seq, o.option`, nc, ns)
		if err != nil {
			return nil, fmt.Errorf("chat: count poll votes: %w", err)
		}
		for rows.Next() {
			var k msgKey
			var option int16
			var n int32
			if err := rows.Scan(&k.chatID, &k.seq, &option, &n); err != nil {
				rows.Close()
				return nil, fmt.Errorf("chat: count poll votes: %w", err)
			}
			if p.counts[k] == nil {
				p.counts[k] = map[int32]int32{}
			}
			p.counts[k][int32(option)] = n
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("chat: count poll votes: %w", err)
		}
		rows, err = q.Query(ctx, `
			SELECT v.chat_id, v.seq, count(*)
			FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
			JOIN poll_votes v ON v.chat_id = x.chat_id AND v.seq = x.seq
			GROUP BY v.chat_id, v.seq`, nc, ns)
		if err != nil {
			return nil, fmt.Errorf("chat: count poll voters: %w", err)
		}
		for rows.Next() {
			var k msgKey
			var n int32
			if err := rows.Scan(&k.chatID, &k.seq, &n); err != nil {
				rows.Close()
				return nil, fmt.Errorf("chat: count poll voters: %w", err)
			}
			p.voters[k] = n
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("chat: count poll voters: %w", err)
		}
	}
	pc, ps := flattenKeys(pollKeys(p.state))
	// The latest voters of each answer, whatever the poll: fill shows them for a public one.
	rows, err = q.Query(ctx, `
		SELECT chat_id, seq, option, user_id FROM (
			SELECT v.chat_id, v.seq, o.option, v.user_id,
				row_number() OVER (PARTITION BY v.chat_id, v.seq, o.option ORDER BY v.created_at DESC, v.user_id DESC) AS n
			FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
			JOIN poll_votes v ON v.chat_id = x.chat_id AND v.seq = x.seq
			CROSS JOIN LATERAL unnest(v.options) AS o(option)) r
		WHERE n <= $3 ORDER BY chat_id, seq, option, n`, pc, ps, pollRecentMax)
	if err != nil {
		return nil, fmt.Errorf("chat: recent poll voters: %w", err)
	}
	for rows.Next() {
		var k msgKey
		var option int16
		var user int64
		if err := rows.Scan(&k.chatID, &k.seq, &option, &user); err != nil {
			rows.Close()
			return nil, fmt.Errorf("chat: recent poll voters: %w", err)
		}
		if p.recent[k] == nil {
			p.recent[k] = map[int32][]int64{}
		}
		p.recent[k][int32(option)] = append(p.recent[k][int32(option)], user)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: recent poll voters: %w", err)
	}
	if len(viewers) == 0 {
		return p, nil
	}
	rows, err = q.Query(ctx, `
		SELECT v.chat_id, v.seq, v.user_id, v.options
		FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
		JOIN poll_votes v ON v.chat_id = x.chat_id AND v.seq = x.seq
		WHERE v.user_id = ANY($3)`, pc, ps, viewers)
	if err != nil {
		return nil, fmt.Errorf("chat: load own poll votes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var k msgKey
		var user int64
		var options []int16
		if err := rows.Scan(&k.chatID, &k.seq, &user, &options); err != nil {
			return nil, fmt.Errorf("chat: load own poll votes: %w", err)
		}
		mk := memberKey{k.chatID, user}
		if p.mine[mk] == nil {
			p.mine[mk] = map[int64][]int32{}
		}
		p.mine[mk][k.seq] = widen(options)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: load own poll votes: %w", err)
	}
	return p, nil
}

func pollKeys(state map[msgKey]*pollState) map[int64][]int64 {
	keys := map[int64][]int64{}
	for k := range state {
		keys[k.chatID] = append(keys[k.chatID], k.seq)
	}
	return keys
}

func widen(xs []int16) []int32 {
	out := make([]int32, len(xs))
	for i, x := range xs {
		out[i] = int32(x)
	}
	return out
}

func narrow(xs []int32) []int16 {
	out := make([]int16, len(xs))
	for i, x := range xs {
		out[i] = int16(x)
	}
	return out
}

// fill completes the poll of a rendered message (if it is one) for viewer: its
// results, the viewer's answers, and the answer of a quiz when the viewer may know it.
func (p *pollsOf) fill(m *appv1.Message, viewer int64) {
	poll := m.GetPoll()
	if poll == nil || p == nil {
		return
	}
	k := msgKey{m.GetChatId(), m.GetSeq()}
	st := p.state[k]
	if st == nil {
		st = &pollState{}
	}
	n := len(poll.GetOptions())
	poll.Counts = make([]int32, n)
	if st.extCounts != nil {
		copy(poll.Counts, st.extCounts)
		poll.Voters = st.extVoters
		poll.ResultsHidden = len(st.extCounts) == 0
	} else {
		for i := range poll.Counts {
			poll.Counts[i] = p.counts[k][int32(i)]
		}
		poll.Voters = p.voters[k]
	}
	poll.Closed = st.closed
	poll.Chosen = p.mine[memberKey{k.chatID, viewer}][k.seq]
	poll.RecentVoters = nil
	if poll.GetPublicVoters() {
		for i := range n {
			poll.RecentVoters = append(poll.RecentVoters, &appv1.PollVoterIds{UserIds: p.recent[k][int32(i)]})
		}
	}
	poll.Correct, poll.Explanation = nil, ""
	if poll.GetQuiz() && (len(poll.Chosen) > 0 || st.closed || (viewer != 0 && viewer == m.GetFromId())) {
		poll.Correct, poll.Explanation = st.correct, st.explanation
	}
}

// validatePoll checks a poll as a sender posts it and returns its content.
func validatePoll(req *appv1.SendPollRequest) (*appv1.Poll, error) {
	question := strings.TrimSpace(req.GetQuestion())
	if question == "" || !utf8.ValidString(question) || utf8.RuneCountInString(question) > pollQuestionMax {
		return nil, errInvalid("a poll needs a question of 1 to %d characters", pollQuestionMax)
	}
	opts := make([]string, 0, len(req.GetOptions()))
	for _, o := range req.GetOptions() {
		o = strings.TrimSpace(o)
		if o == "" || !utf8.ValidString(o) || utf8.RuneCountInString(o) > pollOptionMax {
			return nil, errInvalid("each answer of a poll is 1 to %d characters", pollOptionMax)
		}
		if slices.Contains(opts, o) {
			return nil, errInvalid("the answers of a poll differ")
		}
		opts = append(opts, o)
	}
	if len(opts) < pollOptionsMin || len(opts) > pollOptionsMax {
		return nil, errInvalid("a poll has %d to %d answers", pollOptionsMin, pollOptionsMax)
	}
	if req.GetQuiz() {
		if req.GetMultiple() {
			return nil, errInvalid("a quiz has one right answer")
		}
		if req.GetCorrect() < 0 || int(req.GetCorrect()) >= len(opts) {
			return nil, errInvalid("the right answer of a quiz is one of its answers")
		}
	}
	if utf8.RuneCountInString(req.GetExplanation()) > pollExplanationMax || !utf8.ValidString(req.GetExplanation()) {
		return nil, errInvalid("the explanation of a quiz is at most %d characters", pollExplanationMax)
	}
	return &appv1.Poll{Question: question, Options: opts, Multiple: req.GetMultiple(), PublicVoters: req.GetPublicVoters(),
		Quiz: req.GetQuiz()}, nil
}

// SendPoll posts a poll as me under the rules of SendMessage.
func (s *Service) SendPoll(ctx context.Context, me int64, req *appv1.SendPollRequest) (*appv1.SendPollResponse, error) {
	poll, err := validatePoll(req)
	if err != nil {
		return nil, err
	}
	if req.GetRandomId() < 0 {
		return nil, errInvalid("random_id must not be negative")
	}
	if err := s.allow(ctx, limitSend, "send", me); err != nil {
		return nil, err
	}
	state := pollState{}
	if poll.GetQuiz() {
		state.correct = []int32{req.GetCorrect()}
		state.explanation = strings.TrimSpace(req.GetExplanation())
	}
	resp, err := s.postText(ctx, me, textPost{
		chatID: req.GetChatId(), topicID: req.GetTopicId(), randomID: req.GetRandomId(), replyTo: req.GetReplyToSeq(),
		noPreview: true, poll: poll, pollState: &state,
	})
	if err != nil {
		return nil, err
	}
	return &appv1.SendPollResponse{Message: resp.GetMessage(), Ack: resp.GetAck()}, nil
}

// insertPoll records the state of a poll just posted at seq.
func insertPoll(ctx context.Context, q querier, chatID, seq int64, st *pollState) error {
	var ext []int32
	var voters *int32
	if st.extCounts != nil {
		ext, voters = st.extCounts, &st.extVoters
	}
	correct := st.correct
	if correct == nil {
		correct = []int32{}
	}
	if _, err := q.Exec(ctx, `
		INSERT INTO message_polls (chat_id, seq, closed, correct, explanation, external_counts, external_voters)
		VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (chat_id, seq) DO NOTHING`,
		chatID, seq, st.closed, narrow(correct), st.explanation, ext, voters); err != nil {
		return fmt.Errorf("chat: insert poll: %w", err)
	}
	return nil
}

// pollOf decodes the poll a message carries; nil when it carries none.
func pollOf(m *messageRow) (*appv1.Poll, error) {
	if len(m.Content) == 0 || m.Deleted {
		return nil, nil
	}
	var c appv1.Message
	if err := proto.Unmarshal(m.Content, &c); err != nil {
		return nil, fmt.Errorf("chat: decode message: %w", err)
	}
	return c.GetPoll(), nil
}

// lockPoll returns the state of the poll at seq, holding its row for the rest of
// the transaction (a poll posted before its row existed gets one).
func lockPoll(ctx context.Context, q querier, chatID, seq int64) (*pollState, error) {
	if _, err := q.Exec(ctx, `INSERT INTO message_polls (chat_id, seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, chatID, seq); err != nil {
		return nil, fmt.Errorf("chat: poll row: %w", err)
	}
	return readPoll(ctx, q, chatID, seq, " FOR UPDATE")
}

// readPoll returns the state of the poll at seq; the zero state when it has no row.
// lock is appended to the query.
func readPoll(ctx context.Context, q querier, chatID, seq int64, lock string) (*pollState, error) {
	st := &pollState{}
	var correct []int16
	var ext []int32
	err := q.QueryRow(ctx, `
		SELECT closed, correct, explanation, external_counts, coalesce(external_voters, 0)
		FROM message_polls WHERE chat_id = $1 AND seq = $2`+lock, chatID, seq).Scan(
		&st.closed, &correct, &st.explanation, &ext, &st.extVoters)
	if isNoRows(err) {
		return st, nil
	}
	if err != nil {
		return nil, fmt.Errorf("chat: read poll: %w", err)
	}
	st.correct, st.extCounts = widen(correct), ext
	return st, nil
}

// voteOf is the answers of user to the poll at seq (nil without a vote).
func voteOf(ctx context.Context, q querier, chatID, seq, user int64) ([]int32, error) {
	var options []int16
	err := q.QueryRow(ctx, `SELECT options FROM poll_votes WHERE chat_id = $1 AND seq = $2 AND user_id = $3`, chatID, seq, user).Scan(&options)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("chat: poll vote: %w", err)
	}
	return widen(options), nil
}

// setVote stores the answers of user (none removes the vote) and, for a poll whose
// results the other app tells, moves those results by the change so they are right
// before the other app tells them again. It reports whether anything changed.
func setVote(ctx context.Context, q querier, chatID, seq, user int64, st *pollState, options []int32) (bool, error) {
	old, err := voteOf(ctx, q, chatID, seq, user)
	if err != nil {
		return false, err
	}
	if changed, err := storeVote(ctx, q, chatID, seq, user, options); err != nil || !changed {
		return false, err
	}
	if st.extCounts == nil {
		return true, nil
	}
	counts := slices.Clone(st.extCounts)
	for _, o := range old {
		if int(o) < len(counts) && counts[o] > 0 {
			counts[o]--
		}
	}
	for _, o := range options {
		if int(o) < len(counts) {
			counts[o]++
		}
	}
	voters := st.extVoters
	if len(old) == 0 && len(options) > 0 {
		voters++
	} else if len(old) > 0 && len(options) == 0 && voters > 0 {
		voters--
	}
	if _, err := q.Exec(ctx, `UPDATE message_polls SET external_counts = $3, external_voters = $4 WHERE chat_id = $1 AND seq = $2`,
		chatID, seq, counts, voters); err != nil {
		return false, fmt.Errorf("chat: move poll results: %w", err)
	}
	st.extCounts, st.extVoters = counts, voters
	return true, nil
}

// storeVote stores the answers of user (none removes the vote) as they are, and
// reports whether they changed.
func storeVote(ctx context.Context, q querier, chatID, seq, user int64, options []int32) (bool, error) {
	old, err := voteOf(ctx, q, chatID, seq, user)
	if err != nil {
		return false, err
	}
	if slices.Equal(old, options) {
		return false, nil
	}
	if len(options) == 0 {
		_, err = q.Exec(ctx, `DELETE FROM poll_votes WHERE chat_id = $1 AND seq = $2 AND user_id = $3`, chatID, seq, user)
	} else {
		_, err = q.Exec(ctx, `
			INSERT INTO poll_votes (chat_id, seq, user_id, options) VALUES ($1, $2, $3, $4)
			ON CONFLICT (chat_id, seq, user_id) DO UPDATE SET options = excluded.options, created_at = now()`,
			chatID, seq, user, narrow(options))
	}
	if err != nil {
		return false, fmt.Errorf("chat: set poll vote: %w", err)
	}
	return true, nil
}

// checkAnswers validates the answers of a vote against the poll.
func checkAnswers(poll *appv1.Poll, options []int32) ([]int32, error) {
	out := slices.Clone(options)
	slices.Sort(out)
	out = slices.Compact(out)
	if len(out) != len(options) {
		return nil, errInvalid("an answer is chosen once")
	}
	for _, o := range out {
		if o < 0 || int(o) >= len(poll.GetOptions()) {
			return nil, errInvalid("no such answer")
		}
	}
	if len(out) > 1 && !poll.GetMultiple() {
		return nil, errInvalid("this poll takes one answer")
	}
	return out, nil
}

// pollTarget loads the poll message at seq for me inside t, refusing what me may
// not see or what is not a poll.
func (s *Service) pollTarget(ctx context.Context, t *txn, chatID, seq, me int64) (*chatRow, *messageRow, *appv1.Poll, error) {
	c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
	if err != nil {
		return nil, nil, nil, err
	}
	target, err := s.liveMessage(ctx, t.tx, chatID, seq)
	if err != nil {
		return nil, nil, nil, err
	}
	if target.Seq < m.VisibleFrom || isService(target) {
		return nil, nil, nil, errNotFound("message")
	}
	poll, err := pollOf(target)
	if err != nil {
		return nil, nil, nil, err
	}
	if poll == nil {
		return nil, nil, nil, errInvalid("the message is not a poll")
	}
	return c, target, poll, nil
}

// VotePoll sets (or with no options takes back) my answer to a poll.
func (s *Service) VotePoll(ctx context.Context, me int64, req *appv1.VotePollRequest) (*appv1.VotePollResponse, error) {
	chatID, seq := req.GetChatId(), req.GetSeq()
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, _, poll, err := s.pollTarget(ctx, t, chatID, seq, me)
		if err != nil {
			return err
		}
		options, err := checkAnswers(poll, req.GetOptions())
		if err != nil {
			return err
		}
		st, err := lockPoll(ctx, t.tx, chatID, seq)
		if err != nil {
			return err
		}
		if st.closed {
			return errPrecondition("poll_closed: the poll is closed")
		}
		out, err := t.outboundLink(ctx, chatID, me, feature.Messages)
		if err != nil {
			return err
		}
		if st.extCounts != nil && out == nil {
			return errPrecondition("poll_external: this poll belongs to the other app of the chat; only its owner, sending there, votes")
		}
		if poll.GetQuiz() {
			old, err := voteOf(ctx, t.tx, chatID, seq, me)
			if err != nil {
				return err
			}
			if len(old) > 0 {
				return errPrecondition("quiz_answered: a quiz is answered once")
			}
		}
		changed, err := setVote(ctx, t.tx, chatID, seq, me, st, options)
		if err != nil || !changed {
			return err
		}
		if err := t.queueState(ctx, chatID, me, feature.Messages, "poll_vote", map[string]any{"options": options}, seq); err != nil {
			return err
		}
		return t.tellPoll(ctx, c, seq, me)
	})
	if err != nil {
		return nil, err
	}
	poll, err := s.pollFor(ctx, me, chatID, seq)
	if err != nil {
		return nil, err
	}
	return &appv1.VotePollResponse{Poll: poll, Ack: t.ack(me, chatID)}, nil
}

// ClosePoll closes a poll me sent.
func (s *Service) ClosePoll(ctx context.Context, me int64, req *appv1.ClosePollRequest) (*appv1.ClosePollResponse, error) {
	chatID, seq := req.GetChatId(), req.GetSeq()
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, target, _, err := s.pollTarget(ctx, t, chatID, seq, me)
		if err != nil {
			return err
		}
		if target.FromID != me {
			return errDenied("only the sender of a poll closes it")
		}
		st, err := lockPoll(ctx, t.tx, chatID, seq)
		if err != nil {
			return err
		}
		if st.closed {
			return nil
		}
		if st.extCounts != nil {
			out, err := t.outboundLink(ctx, chatID, me, feature.Messages)
			if err != nil {
				return err
			}
			if out == nil {
				return errPrecondition("poll_external: this poll belongs to the other app of the chat; it closes there while Chat sends to it")
			}
		}
		if _, err := t.tx.Exec(ctx, `UPDATE message_polls SET closed = true WHERE chat_id = $1 AND seq = $2`, chatID, seq); err != nil {
			return fmt.Errorf("chat: close poll: %w", err)
		}
		if err := t.queueState(ctx, chatID, me, feature.Messages, "poll_close", map[string]any{}, seq); err != nil {
			return err
		}
		return t.tellPoll(ctx, c, seq, me)
	})
	if err != nil {
		return nil, err
	}
	poll, err := s.pollFor(ctx, me, chatID, seq)
	if err != nil {
		return nil, err
	}
	return &appv1.ClosePollResponse{Poll: poll, Ack: t.ack(me, chatID)}, nil
}

// tellPoll tells the members who see the message at seq that its poll changed; each
// gets the poll as they see it when the update is rendered.
func (t *txn) tellPoll(ctx context.Context, c *chatRow, seq, actor int64) error {
	members, err := t.fanoutSeeing(ctx, c, seq)
	if err != nil {
		return err
	}
	ev := t.event(kindPoll, c.ID, actor)
	return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_Poll{Poll: &appv1.UpdatePoll{ChatId: c.ID, Seq: seq}}})
}

// pollFor renders the poll of the message at seq for me.
func (s *Service) pollFor(ctx context.Context, me, chatID, seq int64) (*appv1.Poll, error) {
	m, err := s.liveMessage(ctx, s.pool, chatID, seq)
	if err != nil {
		return nil, err
	}
	msgs, _, err := s.renderMessages(ctx, s.pool, me, []*messageRow{m})
	if err != nil {
		return nil, err
	}
	return msgs[0].GetPoll(), nil
}

// repostedPoll is the state a poll forwarded or copied by me starts with. A quiz
// carries its answer to the copy, whose sender (me) sees it there: me must already
// see it here (answered, sent it, or it closed), and the answer must be known (a quiz
// of another app tells it only to who answered).
func (s *Service) repostedPoll(ctx context.Context, q querier, src *messageRow, poll *appv1.Poll, me int64) (*pollState, error) {
	if !poll.GetQuiz() {
		return &pollState{}, nil
	}
	st, err := readPoll(ctx, q, src.ChatID, src.Seq, "")
	if err != nil {
		return nil, err
	}
	if len(st.correct) == 0 {
		return nil, errPrecondition("quiz_unknown: the answer of this quiz is not known here, so it cannot be posted again")
	}
	mine, err := voteOf(ctx, q, src.ChatID, src.Seq, me)
	if err != nil {
		return nil, err
	}
	if len(mine) == 0 && !st.closed && src.FromID != me {
		return nil, errPrecondition("quiz_unanswered: answer the quiz before passing it on")
	}
	return &pollState{correct: st.correct, explanation: st.explanation}, nil
}

// deletePolls removes what polls among seqs of a chat keep beside the message.
func deletePolls(ctx context.Context, tx pgx.Tx, chatID int64, seqs []int64) error {
	if _, err := tx.Exec(ctx, `DELETE FROM poll_votes WHERE chat_id = $1 AND seq = ANY($2)`, chatID, seqs); err != nil {
		return fmt.Errorf("chat: delete poll votes: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM message_polls WHERE chat_id = $1 AND seq = ANY($2)`, chatID, seqs); err != nil {
		return fmt.Errorf("chat: delete polls: %w", err)
	}
	return nil
}

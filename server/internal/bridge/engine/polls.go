package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
)

const (
	// pollsEvery: results mostly arrive as events; the open polls of each chat are also
	// read once in this many looks at the state of the chats, for what the other app
	// did not tell (an app that sends no event, a poll not seen since a restart).
	pollsEvery = 5
	// pollsRecent is how many of the newest open polls of a chat that read covers.
	pollsRecent = 20
	// pollsMaxAge: polls older than this are no longer read on the timer.
	pollsMaxAge = 30 * 24 * time.Hour
)

// pollContent is the content of an imported poll: what was asked and how.
func pollContent(p *bridge.Poll) *appv1.Poll {
	return &appv1.Poll{Question: p.Question, Options: p.Options, Multiple: p.Multiple, PublicVoters: p.Public, Quiz: p.Quiz}
}

// importedPoll is the state of a poll as Chat takes it.
func importedPoll(r bridge.PollResults) chat.ImportedPoll {
	out := chat.ImportedPoll{Closed: r.Closed, OwnerKnown: r.OwnerKnown, Chosen: ints32(r.Chosen),
		Correct: ints32(r.Correct), Explanation: r.Explanation}
	if r.Counts != nil {
		out.Counts, out.Voters = ints32(r.Counts), int32(r.Voters)
	}
	return out
}

func intsOf(xs []int32) []int {
	out := make([]int, len(xs))
	for i, x := range xs {
		out[i] = int(x)
	}
	return out
}

func ints32(xs []int) []int32 {
	if xs == nil {
		return nil
	}
	out := make([]int32, len(xs))
	for i, x := range xs {
		out[i] = int32(x)
	}
	return out
}

// onPoll applies the results of a poll reported live.
func (r *runner) onPoll(ctx context.Context, ev bridge.Event, pr bridge.PollResults) (bool, error) {
	l := r.links[pr.Conversation]
	if l == nil || !l.BackfillDone {
		return false, nil
	}
	err := r.applyPolls(ctx, l, []bridge.PollResults{pr}, func(it *chat.ImportTx) error {
		return saveState(ctx, it.Tx(), r.account.ID, ev.State)
	})
	return true, err
}

// applyPolls makes the polls of messages in Chat what the other app says. A message not
// imported is skipped; while Chat has a vote of the owner waiting to go out, the owner's
// answers and the counts are left as Chat has them. after runs in the same transaction.
func (r *runner) applyPolls(ctx context.Context, l *chatLink, list []bridge.PollResults, after func(*chat.ImportTx) error) error {
	type item struct {
		seq int64
		pr  bridge.PollResults
	}
	var items []item
	for _, pr := range list {
		have, err := lookupMessage(ctx, r.e.db.pool, r.account.ID, l.ExternalChat, pr.ID)
		if err != nil {
			return err
		}
		if have != nil {
			items = append(items, item{have.Seq, pr})
		}
	}
	if len(items) == 0 && after == nil {
		return nil
	}
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		for _, x := range items {
			if err := r.setPoll(ctx, it, x.seq, x.pr); err != nil {
				return err
			}
		}
		if after != nil {
			return after(it)
		}
		return nil
	})
}

// setPoll writes one poll's results inside the chat's import transaction.
func (r *runner) setPoll(ctx context.Context, it *chat.ImportTx, seq int64, pr bridge.PollResults) error {
	voting, err := pendingOpAt(ctx, it.Tx(), it.ChatID(), seq, "poll_vote")
	if err != nil {
		return err
	}
	closing, err := pendingOpAt(ctx, it.Tx(), it.ChatID(), seq, "poll_close")
	if err != nil {
		return err
	}
	_, err = it.SetPoll(ctx, seq, importedPoll(pr), voting, closing)
	return err
}

// pollPolls reads the open polls of the chats where messages come in, once in pollsEvery looks.
func (r *runner) pollPolls(ctx context.Context) error {
	reader, ok := r.adapter.(bridge.PollReader)
	if !ok {
		return nil
	}
	r.pollsTick++
	if (r.pollsTick-1)%pollsEvery != 0 {
		return nil
	}
	for _, conv := range r.inTurn("polls") {
		l := r.links[conv]
		if !l.BackfillDone {
			continue
		}
		dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Messages)
		if err != nil {
			return err
		}
		if !dir.Receives() {
			continue
		}
		if err := r.readPolls(ctx, reader, l, conv, ""); err != nil {
			return err
		}
	}
	return nil
}

// readPolls asks the other app for the results of the newest open polls of a chat (or of
// the one message id when it is set) and applies them.
func (r *runner) readPolls(ctx context.Context, reader bridge.PollReader, l *chatLink, conv, id string) error {
	if r.stillRefused("polls", conv) {
		return nil
	}
	ids := []string{id}
	if id == "" {
		var err error
		if ids, err = openPolls(ctx, r.e.db.pool, r.account.ID, l.ChatID, conv); err != nil {
			return err
		}
	}
	if len(ids) == 0 {
		return nil
	}
	list, err := retryRateLimit(ctx, func() ([]bridge.PollResults, error) { return reader.PollResults(ctx, r.acct, conv, ids) })
	if err != nil {
		return r.skipRefused(err, "polls", conv)
	}
	return r.applyPolls(ctx, l, list, nil)
}

// openPolls lists the external ids of the newest imported polls of a chat still open,
// posted within pollsMaxAge.
func openPolls(ctx context.Context, q querier, account, chatID int64, conv string) ([]string, error) {
	rows, err := q.Query(ctx, `
		SELECT x.external_msg_id FROM message_polls p
		JOIN external_messages x ON x.chat_id = p.chat_id AND x.seq = p.seq AND x.account_id = $1 AND x.external_chat_id = $3
		JOIN messages m ON m.chat_id = p.chat_id AND m.seq = p.seq AND m.deleted_at IS NULL
		WHERE p.chat_id = $2 AND NOT p.closed AND m.date > now() - make_interval(secs => $4)
		ORDER BY p.seq DESC LIMIT $5`, account, chatID, conv, pollsMaxAge.Seconds(), pollsRecent)
	if err != nil {
		return nil, fmt.Errorf("bridge: open polls: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("bridge: open polls: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// doPollOp sends the owner's vote (poll_vote) or the closing of the owner's poll
// (poll_close) a row asks for. One the other app refuses for good is put back: Chat
// reads the poll from the other app again, so it never shows a vote the app has not.
func (r *runner) doPollOp(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	writer, ok := r.adapter.(bridge.PollWriter)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "polls_unsupported: this app cannot take votes from Chat", time.Time{})
	}
	k, err := externalOf(ctx, db.pool, h.ChatID, h.Seq)
	if err != nil {
		return err
	}
	if k == nil {
		if waiting, err := r.waitForSend(ctx, h); err != nil || waiting {
			return err
		}
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	if err := db.startSendingState(ctx, h); err != nil {
		return err
	}
	if h.Op == "poll_close" {
		err = writer.ClosePoll(ctx, r.acct, k.chat, k.msg)
	} else {
		var p struct {
			Options []int `json:"options"`
		}
		if jerr := json.Unmarshal(h.Payload, &p); jerr != nil {
			return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
		}
		err = writer.VotePoll(ctx, r.acct, k.chat, k.msg, p.Options)
	}
	if err != nil {
		if serr := r.settleCall(ctx, []*outboxRow{h}, err); serr != nil {
			return serr
		}
		var status string
		if qerr := db.pool.QueryRow(ctx, `SELECT status FROM external_outbox WHERE id = $1`, h.ID).Scan(&status); qerr != nil {
			return qerr
		}
		reader, ok := r.adapter.(bridge.PollReader)
		l := r.links[k.chat]
		if status != "failed" || !ok || l == nil {
			return nil
		}
		return r.readPolls(ctx, reader, l, k.chat, k.msg)
	}
	if err := db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{}); err != nil {
		return err
	}
	// The vote is in the other app: read the poll back for results that count it. The
	// timer reads it again when this fails, so the row stays sent.
	if reader, ok := r.adapter.(bridge.PollReader); ok {
		if l := r.links[k.chat]; l != nil {
			if err := r.readPolls(ctx, reader, l, k.chat, k.msg); err != nil {
				loggerFrom(ctx).Warn("bridge: read poll after vote", "err", err)
			}
		}
	}
	return nil
}

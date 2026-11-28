package chat

import (
	"context"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
)

// pollVotersMax is how many voters of one answer GetPollVoters lists.
const pollVotersMax = 100

// GetPollVoters lists who chose each answer of a public poll, newest first. Voters
// of a poll of another app are its people as the bridge read them (their puppets) and
// the owner; the counts are the poll's own, so they may say more than the list.
func (s *Service) GetPollVoters(ctx context.Context, me int64, req *appv1.GetPollVotersRequest) (*appv1.GetPollVotersResponse, error) {
	chatID, seq := req.GetChatId(), req.GetSeq()
	c, mem, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	m, err := s.liveMessage(ctx, s.pool, chatID, seq)
	if err != nil {
		return nil, err
	}
	hidden, err := loadHidden(ctx, s.pool, []int64{me}, map[int64][]int64{chatID: {seq}})
	if err != nil {
		return nil, err
	}
	if !mem.sees(m) || hidden[hiddenKey{me, msgKey{chatID, seq}}] {
		return nil, errNotFound("message")
	}
	poll, err := pollOf(m)
	if err != nil {
		return nil, err
	}
	if poll == nil {
		return nil, errInvalid("the message is not a poll")
	}
	if !poll.GetPublicVoters() {
		return nil, errPrecondition("poll_anonymous: nobody sees who chose what in an anonymous poll")
	}
	if c.Type == typeChannel && !mem.isAdmin() {
		return nil, errDenied("only admins see who voted in a channel")
	}
	rows, err := s.pool.Query(ctx, `
		SELECT user_id, options FROM poll_votes WHERE chat_id = $1 AND seq = $2
		ORDER BY created_at DESC, user_id DESC`, chatID, seq)
	if err != nil {
		return nil, fmt.Errorf("chat: poll voters: %w", err)
	}
	n := len(poll.GetOptions())
	byOption := make([][]int64, n)
	for rows.Next() {
		var user int64
		var options []int16
		if err := rows.Scan(&user, &options); err != nil {
			rows.Close()
			return nil, fmt.Errorf("chat: poll voters: %w", err)
		}
		for _, o := range options {
			if int(o) < n && len(byOption[o]) < pollVotersMax {
				byOption[o] = append(byOption[o], user)
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: poll voters: %w", err)
	}
	shown, err := s.pollFor(ctx, me, chatID, seq)
	if err != nil {
		return nil, err
	}
	ents := newEntitySet()
	out := &appv1.GetPollVotersResponse{}
	for i, users := range byOption {
		count := int32(len(users))
		if i < len(shown.GetCounts()) {
			count = max(count, shown.GetCounts()[i])
		}
		out.Answers = append(out.Answers, &appv1.PollAnswerVoters{Option: int32(i), Count: count, UserIds: users})
		ents.addUsers(me, users...)
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	out.Users = rendered.users[me]
	return out, nil
}

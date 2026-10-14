package chat

import (
	"context"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

const (
	differenceLimitMax = 1000
	// largeActivitySlack widens the "activity since pts" window of large
	// chats so clock and commit-order differences never hide one.
	largeActivitySlack = 5 * time.Second
)

// State returns my log position.
func (s *Service) State(ctx context.Context, me int64) (*appv1.State, error) {
	pts, err := userPts(ctx, s.pool, me)
	if err != nil {
		return nil, err
	}
	return &appv1.State{Pts: pts, ServerEpoch: s.Epoch(), Date: time.Now().Unix()}, nil
}

func userPts(ctx context.Context, q querier, userID int64) (int64, error) {
	var pts int64
	err := q.QueryRow(ctx, `SELECT pts FROM user_state WHERE user_id = $1`, userID).Scan(&pts)
	if isNoRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("chat: user pts: %w", err)
	}
	return pts, nil
}

func clampLimit(limit int32) int {
	if limit <= 0 || limit > differenceLimitMax {
		return differenceLimitMax
	}
	return int(limit)
}

// GetDifference returns my log since pts (ADR 0002). too_long when the epoch
// differs, pts is ahead of the log, or retention dropped part of the range.
func (s *Service) GetDifference(ctx context.Context, me int64, req *appv1.GetDifferenceRequest) (*appv1.GetDifferenceResponse, error) {
	state, err := s.State(ctx, me)
	if err != nil {
		return nil, err
	}
	from := req.GetPts()
	resp := &appv1.GetDifferenceResponse{State: state}
	if req.GetServerEpoch() != state.GetServerEpoch() || from < 0 || from > state.GetPts() {
		resp.Result = &appv1.GetDifferenceResponse_TooLong{TooLong: &appv1.DifferenceTooLong{}}
		return resp, nil
	}
	limit := clampLimit(req.GetLimit())
	updates, err := readLog(ctx, s.pool, `
		SELECT pts, created_at, "update" FROM user_updates WHERE user_id = $1 AND pts > $2 ORDER BY pts LIMIT $3`, me, from, limit+1)
	if err != nil {
		return nil, err
	}
	if len(updates) > 0 && updates[0].pos != from+1 {
		resp.Result = &appv1.GetDifferenceResponse_TooLong{TooLong: &appv1.DifferenceTooLong{}}
		return resp, nil
	}
	if from < state.GetPts() && len(updates) == 0 {
		resp.Result = &appv1.GetDifferenceResponse_TooLong{TooLong: &appv1.DifferenceTooLong{}}
		return resp, nil
	}
	large, err := s.largeChatsSince(ctx, me, from)
	if err != nil {
		return nil, err
	}
	if len(updates) == 0 && len(large) == 0 {
		resp.Result = &appv1.GetDifferenceResponse_Empty{Empty: &appv1.DifferenceEmpty{}}
		return resp, nil
	}
	slice := len(updates) > limit
	if slice {
		updates = updates[:limit]
		state.Pts = updates[len(updates)-1].pos
	}
	list := make([]*appv1.Update, len(updates))
	for i, e := range updates {
		e.update.Pts, e.update.PtsCount, e.update.ServerEpoch, e.update.Date = e.pos, 1, state.GetServerEpoch(), e.at.Unix()
		list[i] = e.update
	}
	diff, err := s.differenceBody(ctx, me, list)
	if err != nil {
		return nil, err
	}
	diff.LargeChats = large
	if slice {
		resp.Result = &appv1.GetDifferenceResponse_Slice{Slice: diff}
	} else {
		resp.Result = &appv1.GetDifferenceResponse_Full{Full: diff}
	}
	return resp, nil
}

type logEntry struct {
	pos    int64
	at     time.Time
	update *appv1.Update
}

func readLog(ctx context.Context, q querier, sql string, args ...any) ([]logEntry, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("chat: read log: %w", err)
	}
	defer rows.Close()
	var out []logEntry
	for rows.Next() {
		var e logEntry
		var payload []byte
		if err := rows.Scan(&e.pos, &e.at, &payload); err != nil {
			return nil, fmt.Errorf("chat: read log: %w", err)
		}
		u, err := decodeStored(payload)
		if err != nil {
			return nil, err
		}
		e.update = u
		out = append(out, e)
	}
	return out, rows.Err()
}

// differenceBody renders log updates for me with the users and chats they
// reference.
func (s *Service) differenceBody(ctx context.Context, me int64, updates []*appv1.Update) (*appv1.DifferenceUpdates, error) {
	frames, err := s.renderFrames(ctx, s.pool, []int64{me}, map[int64][]*appv1.Update{me: updates})
	if err != nil {
		return nil, err
	}
	f := frames[me]
	return &appv1.DifferenceUpdates{Updates: f.GetUpdates(), Users: f.GetUsers(), Chats: f.GetChats()}, nil
}

// largeChatsSince lists my large chats with log activity after my log was
// at pts (all of them when that point is unknown).
func (s *Service) largeChatsSince(ctx context.Context, me, pts int64) ([]*appv1.LargeChatState, error) {
	since := time.Time{}
	if pts > 0 {
		err := s.pool.QueryRow(ctx, `SELECT created_at FROM user_updates WHERE user_id = $1 AND pts = $2`, me, pts).Scan(&since)
		if err != nil && !isNoRows(err) {
			return nil, fmt.Errorf("chat: log time: %w", err)
		}
		if !since.IsZero() {
			since = since.Add(-largeActivitySlack)
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.chat_pts, c.last_seq FROM chat_members m JOIN chats c ON c.id = m.chat_id
		WHERE m.user_id = $1 AND m.left_at IS NULL AND c.sync_mode = 'large' AND c.chat_pts_at > $2
		ORDER BY c.id`, me, since)
	if err != nil {
		return nil, fmt.Errorf("chat: large chats: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.LargeChatState, error) {
		l := &appv1.LargeChatState{}
		err := r.Scan(&l.ChatId, &l.ChatPts, &l.TopSeq)
		return l, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: large chats: %w", err)
	}
	return list, nil
}

// GetChatDifference returns a large chat's own log since chat_pts.
func (s *Service) GetChatDifference(ctx context.Context, me int64, req *appv1.GetChatDifferenceRequest) (*appv1.GetChatDifferenceResponse, error) {
	c, _, err := s.activeChatFor(ctx, s.pool, req.GetChatId(), me, false)
	if err != nil {
		return nil, err
	}
	epoch := s.Epoch()
	state := &appv1.ChatState{ChatId: c.ID, ChatPts: c.ChatPts, ServerEpoch: epoch}
	resp := &appv1.GetChatDifferenceResponse{State: state}
	from := req.GetChatPts()
	if req.GetServerEpoch() != epoch || from < 0 || from > c.ChatPts {
		resp.Result = &appv1.GetChatDifferenceResponse_TooLong{TooLong: &appv1.DifferenceTooLong{}}
		return resp, nil
	}
	if from == c.ChatPts {
		resp.Result = &appv1.GetChatDifferenceResponse_Empty{Empty: &appv1.DifferenceEmpty{}}
		return resp, nil
	}
	limit := clampLimit(req.GetLimit())
	entries, err := readLog(ctx, s.pool, `
		SELECT chat_pts, created_at, "update" FROM chat_updates WHERE chat_id = $1 AND chat_pts > $2 ORDER BY chat_pts LIMIT $3`,
		c.ID, from, limit+1)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 || entries[0].pos != from+1 {
		resp.Result = &appv1.GetChatDifferenceResponse_TooLong{TooLong: &appv1.DifferenceTooLong{}}
		return resp, nil
	}
	slice := len(entries) > limit
	if slice {
		entries = entries[:limit]
		state.ChatPts = entries[len(entries)-1].pos
	}
	list := make([]*appv1.Update, len(entries))
	for i, e := range entries {
		e.update.ChatPts, e.update.ChatPtsCount, e.update.ChatId, e.update.ServerEpoch, e.update.Date = e.pos, 1, c.ID, epoch, e.at.Unix()
		list[i] = e.update
	}
	diff, err := s.differenceBody(ctx, me, list)
	if err != nil {
		return nil, err
	}
	if slice {
		resp.Result = &appv1.GetChatDifferenceResponse_Slice{Slice: diff}
	} else {
		resp.Result = &appv1.GetChatDifferenceResponse_Full{Full: diff}
	}
	return resp, nil
}

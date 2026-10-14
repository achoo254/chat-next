package chat

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// Page sizes of the newest-first lists.
const (
	reactorsPageDef = 50
	reactorsPageMax = 100
	blockedPageDef  = 50
	blockedPageMax  = 200
)

// timeCursor is the opaque cursor of a list ordered by (time, id)
// descending: the last row returned.
type timeCursor struct {
	at time.Time
	id int64
}

// first is the position before every row.
func firstTimeCursor() timeCursor {
	return timeCursor{at: time.Unix(1<<40, 0), id: 1<<62 - 1}
}

func (c timeCursor) encode() string {
	b := make([]byte, 16)
	binary.BigEndian.PutUint64(b[:8], uint64(c.at.UnixMicro()))
	binary.BigEndian.PutUint64(b[8:], uint64(c.id))
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeTimeCursor(s string) (timeCursor, error) {
	if s == "" {
		return firstTimeCursor(), nil
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != 16 {
		return timeCursor{}, errInvalid("invalid cursor")
	}
	return timeCursor{at: time.UnixMicro(int64(binary.BigEndian.Uint64(b[:8]))), id: int64(binary.BigEndian.Uint64(b[8:]))}, nil
}

func pageLimit(limit int32, def, most int) int {
	if limit <= 0 {
		return def
	}
	return min(int(limit), most)
}

// GetMessageReactions lists who reacted to a message, newest first,
// optionally for one emoji. Only a current member who can see the message
// (history visibility, not hidden for them) may ask; in channels only
// admins, since channel members are private.
func (s *Service) GetMessageReactions(ctx context.Context, me int64, req *appv1.GetMessageReactionsRequest) (*appv1.GetMessageReactionsResponse, error) {
	emoji := req.GetEmoji()
	if emoji != "" && !validEmoji(emoji) {
		return nil, errInvalid("emoji must be one emoji")
	}
	cur, err := decodeTimeCursor(req.GetCursor())
	if err != nil {
		return nil, err
	}
	limit := pageLimit(req.GetLimit(), reactorsPageDef, reactorsPageMax)
	chatID, seq := req.GetChatId(), req.GetSeq()
	c, mem, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if c.Type == typeChannel && !mem.isAdmin() {
		return nil, errDenied("only admins see who reacted in a channel")
	}
	msg, err := s.liveMessage(ctx, s.pool, chatID, seq)
	if err != nil {
		return nil, err
	}
	hidden, err := loadHidden(ctx, s.pool, []int64{me}, map[int64][]int64{chatID: {seq}})
	if err != nil {
		return nil, err
	}
	if !mem.sees(msg) || hidden[hiddenKey{me, msgKey{chatID, seq}}] || isService(msg) {
		return nil, errNotFound("message")
	}
	rows, err := s.pool.Query(ctx, `
		SELECT user_id, emoji, created_at FROM message_reactions
		WHERE chat_id = $1 AND seq = $2 AND ($3 = '' OR emoji = $3) AND (created_at, user_id) < ($4, $5)
		ORDER BY created_at DESC, user_id DESC LIMIT $6`, chatID, seq, emoji, cur.at, cur.id, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list reactions: %w", err)
	}
	type row struct {
		reactor *appv1.MessageReactor
		at      time.Time
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		x := row{reactor: &appv1.MessageReactor{}}
		err := r.Scan(&x.reactor.UserId, &x.reactor.Emoji, &x.at)
		x.reactor.Date = x.at.Unix()
		return x, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: list reactions: %w", err)
	}
	resp := &appv1.GetMessageReactionsResponse{}
	if len(list) > limit {
		list = list[:limit]
		last := list[len(list)-1]
		resp.NextCursor = timeCursor{at: last.at, id: last.reactor.GetUserId()}.encode()
	}
	ents := newEntitySet()
	for _, x := range list {
		resp.Reactors = append(resp.Reactors, x.reactor)
		ents.addUsers(me, x.reactor.GetUserId())
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Users = rendered.users[me]
	return resp, nil
}

// GetBlockedUsers lists the users I blocked, most recently blocked first.
func (s *Service) GetBlockedUsers(ctx context.Context, me int64, cursor string, limit int32) (*appv1.GetBlockedUsersResponse, error) {
	cur, err := decodeTimeCursor(cursor)
	if err != nil {
		return nil, err
	}
	n := pageLimit(limit, blockedPageDef, blockedPageMax)
	rows, err := s.pool.Query(ctx, `
		SELECT b.blocked_id, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked_id AND u.tenant_id = $2
		WHERE b.blocker_id = $1 AND (b.created_at, b.blocked_id) < ($3, $4)
		ORDER BY b.created_at DESC, b.blocked_id DESC LIMIT $5`, me, s.cfg.TenantID, cur.at, cur.id, n+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list blocked users: %w", err)
	}
	type row struct {
		id int64
		at time.Time
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		err := r.Scan(&x.id, &x.at)
		return x, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: list blocked users: %w", err)
	}
	resp := &appv1.GetBlockedUsersResponse{}
	if len(list) > n {
		list = list[:n]
		last := list[len(list)-1]
		resp.NextCursor = timeCursor{at: last.at, id: last.id}.encode()
	}
	ents := newEntitySet()
	for _, x := range list {
		resp.Blocked = append(resp.Blocked, &appv1.BlockedUser{UserId: x.id, BlockedAt: x.at.Unix()})
		ents.addUsers(me, x.id)
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Users = rendered.users[me]
	return resp, nil
}

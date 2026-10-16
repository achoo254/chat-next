package chat

import (
	"context"
	"errors"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// AbuseLimits are the anti-spam thresholds of cold outreach; 0 turns a rule
// off. A stranger is someone who has not added the caller as a contact and
// shares no group or channel with them.
type AbuseLimits struct {
	// StrangerChatsNew caps the private chats a young account starts with
	// strangers in 24 hours; StrangerChats is the cap of older accounts.
	StrangerChatsNew int
	StrangerChats    int
	// NewAccountAge is the age below which an account is young.
	NewAccountAge time.Duration
	// Reporters is how many distinct people with open reports against the
	// caller in reportWindow stop their new chats with strangers, until a
	// moderator resolves or dismisses the reports.
	Reporters int
}

const (
	reportWindow   = 30 * 24 * time.Hour
	youngSearchAge = 24 * time.Hour
)

// Error prefixes the web client tells apart (private-chat-failure.ts).
const (
	msgStrangerLimit  = "stranger_chat_limit: too many new chats with people you do not know today"
	msgStrangerPaused = "stranger_chat_paused: new chats with people you do not know wait for a moderator review"
)

// checkStrangerChat refuses a new private chat of me with peer when peer
// is a stranger and me has used up their allowance, or several people
// reported me. Bots are never strangers: a user starting a bot is not
// cold outreach, and bots cannot message users who did not start them.
func (s *Service) checkStrangerChat(ctx context.Context, q querier, me, peer int64) error {
	a := s.cfg.Abuse
	if a.StrangerChatsNew == 0 && a.StrangerChats == 0 && a.Reporters == 0 {
		return nil
	}
	var stranger bool
	if err := q.QueryRow(ctx, `
		SELECT NOT u.is_bot AND NOT `+knowsSQL("u.id")+`
		FROM users u WHERE u.id = $2`, me, peer).Scan(&stranger); err != nil {
		return fmt.Errorf("chat: stranger check: %w", err)
	}
	if !stranger {
		return nil
	}
	var age time.Duration
	var reporters, started int
	if err := q.QueryRow(ctx, `
		SELECT now() - u.created_at,
			(SELECT count(DISTINCT r.reporter_id) FROM reports r
			WHERE r.tenant_id = $2 AND r.status = 'open' AND r.created_at > now() - make_interval(secs => $3) AND r.reporter_id <> $1
				AND (r.target_user_id = $1
					OR r.evidence @> jsonb_build_array(jsonb_build_object('from_id', $1::bigint))
					OR r.target_chat_id IN (SELECT pc.chat_id FROM private_chats pc
						WHERE pc.tenant_id = $2 AND (pc.user_low = $1 OR pc.user_high = $1) AND pc.user_low <> pc.user_high))),
			`+strangerChats24hSQL+`
		FROM users u WHERE u.id = $1`,
		me, s.cfg.TenantID, reportWindow.Seconds()).Scan(&age, &reporters, &started); err != nil {
		return fmt.Errorf("chat: stranger allowance: %w", err)
	}
	if a.Reporters > 0 && reporters >= a.Reporters {
		return &strangerRefusal{err: connect.NewError(connect.CodeResourceExhausted, errors.New(msgStrangerPaused)),
			note: fmt.Sprintf("%d người đang báo cáo tài khoản này", reporters)}
	}
	limit := a.StrangerChats
	if age < a.NewAccountAge {
		limit = a.StrangerChatsNew
	}
	if limit > 0 && started >= limit {
		return &strangerRefusal{err: connect.NewError(connect.CodeResourceExhausted, errors.New(msgStrangerLimit)),
			note: fmt.Sprintf("Tài khoản %s tuổi, %d chat với người chưa quen trong 24 giờ", ageText(age), started)}
	}
	return nil
}

// strangerRefusal is checkStrangerChat's refusal; note says why, for the
// moderation log.
type strangerRefusal struct {
	err  error
	note string
}

func (e *strangerRefusal) Error() string { return e.err.Error() }
func (e *strangerRefusal) Unwrap() error { return e.err }

// logStrangerRefusal records in the moderation log, once a day per user,
// that the automatic rule stopped me's new chats with strangers.
func (s *Service) logStrangerRefusal(ctx context.Context, me int64, refusal *strangerRefusal) {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO moderation_log (tenant_id, operator_id, action, target_user_id, note)
		SELECT $1, 0, $2, $3, $4 WHERE NOT EXISTS (
			SELECT 1 FROM moderation_log WHERE tenant_id = $1 AND target_user_id = $3 AND action = $2
				AND created_at > now() - interval '24 hours')`,
		s.cfg.TenantID, actionNames[appv1.ModerationAction_MODERATION_ACTION_LIMIT_STRANGER_CHATS], me, refusal.note); err != nil {
		s.logger.Warn("logging the stranger chat limit failed", "user_id", me, "err", err)
	}
}

// ageText is an account age in days ("2 ngày"), or hours under a day.
func ageText(age time.Duration) string {
	if age < 24*time.Hour {
		return fmt.Sprintf("%d giờ", int(age.Hours()))
	}
	return fmt.Sprintf("%d ngày", int(age.Hours()/24))
}

// strangerChats24hSQL counts the private chats user $1 started in the last
// 24 hours with people (not bots) who still do not know them.
var strangerChats24hSQL = `(SELECT count(*) FROM chats c JOIN private_chats pc ON pc.chat_id = c.id
	WHERE c.creator_id = $1 AND c.type = 'private' AND c.created_at > now() - interval '24 hours'
		AND pc.user_low <> pc.user_high
		AND NOT EXISTS (SELECT 1 FROM users b WHERE b.id = pc.user_low + pc.user_high - $1 AND b.is_bot)
		AND NOT ` + knowsSQL("pc.user_low + pc.user_high - $1") + `)`

// knowsSQL is an SQL condition, true when the user other (an SQL
// expression) knows $1: they added $1 as a contact, or both are current
// members of a group or channel.
func knowsSQL(other string) string {
	return `(EXISTS (SELECT 1 FROM contacts k WHERE k.owner_id = ` + other + ` AND k.contact_id = $1)
		OR EXISTS (SELECT 1 FROM chat_members a JOIN chat_members b ON b.chat_id = a.chat_id JOIN chats g ON g.id = a.chat_id
			WHERE a.user_id = $1 AND b.user_id = ` + other + ` AND a.left_at IS NULL AND b.left_at IS NULL
				AND g.type IN ('group', 'channel')))`
}

// allowSearch takes a user search token of me: from the stricter bucket
// while me's account is younger than youngSearchAge.
func (s *Service) allowSearch(ctx context.Context, me int64) error {
	var young bool
	if err := s.pool.QueryRow(ctx, `SELECT created_at > now() - make_interval(secs => $2) FROM users WHERE id = $1`,
		me, youngSearchAge.Seconds()).Scan(&young); err != nil && !isNoRows(err) {
		return fmt.Errorf("chat: account age: %w", err)
	}
	if young {
		return s.allow(ctx, limitSearchYoung, "search-young", me)
	}
	return s.allow(ctx, limitSearch, "search", me)
}

package chat

import (
	"context"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"github.com/jackc/pgx/v5"
)

// Bots under moderation: the automatic rule moves a bot that many of its
// users block, or whose new users jump, to the restricted tier; operators
// review it (keep or restore) and grant or revoke the verified badge.

// Thresholds of the automatic bot rule.
const (
	// A bot that wrote to at least botBlockMinRecipients users in 24 hours
	// is restricted when botBlockPermille of them or more, and at least
	// botBlockMinBlocks people, blocked it.
	botBlockMinRecipients = 20
	botBlockPermille      = 50
	botBlockMinBlocks     = 5
	// A bot older than botSpikeMinAge is restricted when it got at least
	// botSpikeMinUsers new users in 24 hours, botSpikeFactor times its daily
	// average of the week before (a younger bot has no week to compare with:
	// a successful launch is not a spike).
	botSpikeMinUsers = 50
	botSpikeFactor   = 10
	botSpikeMinAge   = 8 * 24 * time.Hour
	// After an operator restores a bot, the rule leaves it alone this long.
	botReviewGrace = 24 * time.Hour
)

// botStatsSQL are the usage counts of bot b over its users (bot_user_consent):
// users it wrote with in 24 hours, users who blocked it in 24 hours, new
// users in 24 hours and in the 7 days before.
const botStatsSQL = `
	(SELECT count(*) FROM bot_user_consent c
		JOIN private_chats pc ON pc.tenant_id = b.tenant_id AND pc.user_low = least(c.bot_id, c.user_id)
			AND pc.user_high = greatest(c.bot_id, c.user_id)
		JOIN chats ch ON ch.id = pc.chat_id
		WHERE c.bot_id = b.user_id AND ch.last_message_at > now() - interval '24 hours') AS recipients,
	(SELECT count(*) FROM blocks k JOIN bot_user_consent c ON c.bot_id = k.blocked_id AND c.user_id = k.blocker_id
		WHERE k.blocked_id = b.user_id AND k.created_at > now() - interval '24 hours') AS blocked,
	(SELECT count(*) FROM bot_user_consent c WHERE c.bot_id = b.user_id AND c.created_at > now() - interval '24 hours') AS new_users,
	(SELECT count(*) FROM bot_user_consent c WHERE c.bot_id = b.user_id
		AND c.created_at > now() - interval '8 days' AND c.created_at <= now() - interval '24 hours') AS week_users`

// ApplyBotAbuseRule restricts the bots of the tenant that cross the
// thresholds above and logs it (operator 0). Internal and system bots, bots
// already restricted and bots an operator restored lately are left alone.
func (s *Service) ApplyBotAbuseRule(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT b.user_id, now() - b.created_at, `+botStatsSQL+` FROM bots b
		WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND NOT b.internal AND NOT b.is_system AND b.restricted_at IS NULL
			AND (b.restriction_reviewed_at IS NULL OR b.restriction_reviewed_at < now() - make_interval(secs => $2))`,
		s.cfg.TenantID, botReviewGrace.Seconds())
	if err != nil {
		return fmt.Errorf("chat: bot abuse stats: %w", err)
	}
	type stats struct {
		id                                     int64
		age                                    time.Duration
		recipients, blocked, newUsers, weekNew int64
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (stats, error) {
		var st stats
		return st, r.Scan(&st.id, &st.age, &st.recipients, &st.blocked, &st.newUsers, &st.weekNew)
	})
	if err != nil {
		return fmt.Errorf("chat: bot abuse stats: %w", err)
	}
	for _, st := range list {
		var reason string
		switch {
		case st.recipients >= botBlockMinRecipients && st.blocked >= botBlockMinBlocks && st.blocked*1000 >= botBlockPermille*st.recipients:
			reason = fmt.Sprintf("%d%% người nhận đã chặn bot trong 24 giờ (ngưỡng %d%%)",
				st.blocked*100/st.recipients, botBlockPermille/10)
		case st.age >= botSpikeMinAge && st.newUsers >= botSpikeMinUsers && st.newUsers*7 >= botSpikeFactor*max(st.weekNew, 1):
			reason = fmt.Sprintf("%d người dùng mới trong 24 giờ, gấp %d lần trung bình tuần trước",
				st.newUsers, st.newUsers*7/max(st.weekNew, 1))
		default:
			continue
		}
		if err := s.restrictBot(ctx, st.id, reason); err != nil {
			return err
		}
		s.logger.Warn("bot restricted by the anti-abuse rule", "bot_id", st.id, "recipients", st.recipients,
			"blocked", st.blocked, "new_users", st.newUsers)
	}
	return nil
}

func (s *Service) restrictBot(ctx context.Context, botID int64, reason string) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		tag, err := t.tx.Exec(ctx, `
			UPDATE bots SET restricted_at = now(), restricted_by = 0, restricted_reason = $3, restriction_reviewed_at = NULL
			WHERE user_id = $1 AND tenant_id = $2 AND restricted_at IS NULL`, botID, s.cfg.TenantID, reason)
		if err != nil {
			return fmt.Errorf("chat: restrict bot: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		return insertLog(ctx, t.tx, s.cfg.TenantID, moderationEntry{
			action: appv1.ModerationAction_MODERATION_ACTION_RESTRICT_BOT, userID: botID, note: reason,
		})
	})
	return err
}

// botReviewRow is a bot with its moderation state.
type botReviewRow struct {
	id, ownerID, restrictedBy              int64
	createdAt                              time.Time
	verified, internal                     bool
	restrictedAt, reviewedAt               *time.Time
	reason                                 string
	recipients, blocked, newUsers, weekNew int64
	users, messages7d, openReports         int64
}

const botReviewSQL = `
	SELECT b.user_id, b.owner_id, b.restricted_by, b.created_at, b.verified, b.internal, b.restricted_at,
		b.restriction_reviewed_at, b.restricted_reason, ` + botStatsSQL + `,
		(SELECT count(*) FROM bot_user_consent c WHERE c.bot_id = b.user_id),
		(SELECT count(*) FROM messages m WHERE m.from_id = b.user_id AND m.date > now() - interval '7 days'
			AND m.chat_id IN (SELECT cm.chat_id FROM chat_members cm WHERE cm.user_id = b.user_id)),
		(SELECT count(*) FROM reports r WHERE r.tenant_id = b.tenant_id AND r.status = 'open'
			AND (r.target_user_id = b.user_id OR r.evidence @> jsonb_build_array(jsonb_build_object('from_id', b.user_id))))
	FROM bots b WHERE b.tenant_id = $1 AND b.deleted_at IS NULL`

func scanBotReview(r pgx.CollectableRow) (*botReviewRow, error) {
	b := &botReviewRow{}
	err := r.Scan(&b.id, &b.ownerID, &b.restrictedBy, &b.createdAt, &b.verified, &b.internal, &b.restrictedAt, &b.reviewedAt,
		&b.reason, &b.recipients, &b.blocked, &b.newUsers, &b.weekNew, &b.users, &b.messages7d, &b.openReports)
	return b, err
}

func (b *botReviewRow) render() *appv1.BotReview {
	tier := (&botadmin.Bot{CreatedAt: b.createdAt, Verified: b.verified, Internal: b.internal, RestrictedAt: b.restrictedAt}).Tier()
	out := &appv1.BotReview{
		BotId: b.id, OwnerId: b.ownerID, CreatedAt: b.createdAt.Unix(), Tier: botadmin.TierOf(tier), Verified: b.verified,
		RestrictedReason: b.reason, Users: int32(b.users), Messages_7D: int32(b.messages7d), OpenReports: int32(b.openReports),
	}
	if b.restrictedAt != nil {
		out.RestrictedAt = b.restrictedAt.Unix()
		out.RestrictedAutomatically = b.restrictedBy == 0
		out.RestrictionReviewed = b.reviewedAt != nil
	}
	if b.recipients > 0 {
		out.BlockedPermille_24H = int32(min(b.blocked*1000/b.recipients, 1000))
	}
	return out
}

func (s *Service) loadBotReview(ctx context.Context, q querier, botID int64) (*botReviewRow, error) {
	if botID <= 0 {
		return nil, errInvalid("bot_id is required")
	}
	rows, err := q.Query(ctx, botReviewSQL+` AND b.user_id = $2`, s.cfg.TenantID, botID)
	if err != nil {
		return nil, fmt.Errorf("chat: bot review: %w", err)
	}
	list, err := pgx.CollectRows(rows, scanBotReview)
	if err != nil {
		return nil, fmt.Errorf("chat: bot review: %w", err)
	}
	if len(list) == 0 {
		return nil, errNotFound("bot")
	}
	return list[0], nil
}

// renderBotReviews renders reviews with their bots and owners for me.
func (s *Service) renderBotReviews(ctx context.Context, me int64, list []*botReviewRow) ([]*appv1.BotReview, []*appv1.User, error) {
	ents := newEntitySet()
	out := make([]*appv1.BotReview, 0, len(list))
	for _, b := range list {
		out = append(out, b.render())
		ents.addUsers(me, b.id, b.ownerID)
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, nil, err
	}
	return out, rendered.users[me], nil
}

// GetBotReview returns one bot as the operators review it.
func (s *Service) GetBotReview(ctx context.Context, me, botID int64) (*appv1.GetBotReviewResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	b, err := s.loadBotReview(ctx, s.pool, botID)
	if err != nil {
		return nil, err
	}
	reviews, users, err := s.renderBotReviews(ctx, me, []*botReviewRow{b})
	if err != nil {
		return nil, err
	}
	return &appv1.GetBotReviewResponse{Review: reviews[0], Users: users}, nil
}

// GetBotReviews lists the bots the automatic rule restricted that no
// operator reviewed yet, newest restriction first.
func (s *Service) GetBotReviews(ctx context.Context, me int64) (*appv1.GetBotReviewsResponse, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, botReviewSQL+`
		AND b.restricted_at IS NOT NULL AND b.restricted_by = 0 AND b.restriction_reviewed_at IS NULL
		ORDER BY b.restricted_at DESC LIMIT 100`, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: bot reviews: %w", err)
	}
	list, err := pgx.CollectRows(rows, scanBotReview)
	if err != nil {
		return nil, fmt.Errorf("chat: bot reviews: %w", err)
	}
	reviews, users, err := s.renderBotReviews(ctx, me, list)
	if err != nil {
		return nil, err
	}
	return &appv1.GetBotReviewsResponse{Reviews: reviews, Users: users}, nil
}

// SetBotVerified grants or revokes a bot's verified badge. The tenant's
// system bots are not changed.
func (s *Service) SetBotVerified(ctx context.Context, me int64, req *appv1.SetBotVerifiedRequest) (*appv1.BotReview, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	note, err := cleanNote(req.GetNote())
	if err != nil {
		return nil, err
	}
	action := appv1.ModerationAction_MODERATION_ACTION_UNVERIFY_BOT
	if req.GetVerified() {
		action = appv1.ModerationAction_MODERATION_ACTION_VERIFY_BOT
	}
	return s.reviewBot(ctx, me, req.GetBotId(), func(t *txn) (bool, error) {
		tag, err := t.tx.Exec(ctx, `
			UPDATE bots SET verified = $3, updated_at = now()
			WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND NOT is_system AND verified <> $3`,
			req.GetBotId(), s.cfg.TenantID, req.GetVerified())
		if err != nil {
			return false, fmt.Errorf("chat: set bot verified: %w", err)
		}
		return tag.RowsAffected() > 0, nil
	}, action, note)
}

// ReviewBotRestriction keeps a restricted bot restricted, or restores its
// tier (the automatic rule then leaves it alone for botReviewGrace).
func (s *Service) ReviewBotRestriction(ctx context.Context, me int64, req *appv1.ReviewBotRestrictionRequest) (*appv1.BotReview, error) {
	if err := s.requireOperator(me); err != nil {
		return nil, err
	}
	note, err := cleanNote(req.GetNote())
	if err != nil {
		return nil, err
	}
	sql, action := `UPDATE bots SET restriction_reviewed_at = now()`, appv1.ModerationAction_MODERATION_ACTION_KEEP_BOT_RESTRICTED
	if req.GetRestore() {
		sql = `UPDATE bots SET restricted_at = NULL, restricted_by = 0, restricted_reason = '', restriction_reviewed_at = now()`
		action = appv1.ModerationAction_MODERATION_ACTION_RESTORE_BOT_TIER
	}
	return s.reviewBot(ctx, me, req.GetBotId(), func(t *txn) (bool, error) {
		tag, err := t.tx.Exec(ctx, sql+`
			WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND restricted_at IS NOT NULL`, req.GetBotId(), s.cfg.TenantID)
		if err != nil {
			return false, fmt.Errorf("chat: review bot restriction: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return false, errPrecondition("not_restricted: this bot is not restricted")
		}
		return true, nil
	}, action, note)
}

// reviewBot runs change on a bot of the tenant and logs action when it
// changed something; it returns the bot's review afterwards.
func (s *Service) reviewBot(ctx context.Context, me, botID int64, change func(t *txn) (bool, error),
	action appv1.ModerationAction, note string,
) (*appv1.BotReview, error) {
	if _, err := s.loadBotReview(ctx, s.pool, botID); err != nil {
		return nil, err
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	_, err := s.inTx(ctx, func(t *txn) error {
		changed, err := change(t)
		if err != nil || !changed {
			return err
		}
		return insertLog(ctx, t.tx, s.cfg.TenantID, moderationEntry{operator: me, action: action, userID: botID, note: note})
	})
	if err != nil {
		return nil, err
	}
	b, err := s.loadBotReview(ctx, s.pool, botID)
	if err != nil {
		return nil, err
	}
	return b.render(), nil
}

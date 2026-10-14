package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/profile"
	"github.com/jackc/pgx/v5"
)

// Privacy audiences as stored (app.v1.PrivacyAudience). "Contacts" means
// people who share a chat with the user: the app has no address book.
const (
	audEveryone = int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE)
	audContacts = int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_CONTACTS)
	audNobody   = int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY)
)

const (
	getUsersMax      = 200
	searchMax        = 50
	reportCommentMax = 1000
	onlineFor        = 5 * time.Minute
)

type privacyRow struct {
	LastSeen, ProfilePhoto, FindByEmail, FindByUsername, AddToGroups, SendMessages int16
	NotificationPreview                                                            bool
}

func defaultPrivacy() privacyRow {
	return privacyRow{LastSeen: audContacts, ProfilePhoto: audEveryone, FindByEmail: audNobody,
		FindByUsername: audEveryone, AddToGroups: audContacts, SendMessages: audEveryone, NotificationPreview: true}
}

func (p privacyRow) render() *appv1.PrivacySettings {
	return &appv1.PrivacySettings{
		LastSeen: appv1.PrivacyAudience(p.LastSeen), ProfilePhoto: appv1.PrivacyAudience(p.ProfilePhoto),
		FindByEmail: appv1.PrivacyAudience(p.FindByEmail), FindByUsername: appv1.PrivacyAudience(p.FindByUsername),
		AddToGroups: appv1.PrivacyAudience(p.AddToGroups), SendMessages: appv1.PrivacyAudience(p.SendMessages),
		NotificationPreview: p.NotificationPreview,
	}
}

func loadPrivacy(ctx context.Context, q querier, users []int64) (map[int64]privacyRow, error) {
	out := make(map[int64]privacyRow, len(users))
	for _, u := range users {
		out[u] = defaultPrivacy()
	}
	if len(users) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT user_id, last_seen, profile_photo, find_by_email, find_by_username, add_to_groups, send_messages,
			notification_preview FROM privacy_settings WHERE user_id = ANY($1)`, users)
	if err != nil {
		return nil, fmt.Errorf("chat: load privacy: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var p privacyRow
		if err := rows.Scan(&id, &p.LastSeen, &p.ProfilePhoto, &p.FindByEmail, &p.FindByUsername, &p.AddToGroups,
			&p.SendMessages, &p.NotificationPreview); err != nil {
			return nil, fmt.Errorf("chat: load privacy: %w", err)
		}
		out[id] = p
	}
	return out, rows.Err()
}

// contactsOf returns which of others share at least one chat with me.
func contactsOf(ctx context.Context, q querier, me int64, others []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(others) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT DISTINCT y.user_id FROM chat_members x JOIN chat_members y ON y.chat_id = x.chat_id
		WHERE x.user_id = $1 AND x.left_at IS NULL AND y.user_id = ANY($2) AND y.left_at IS NULL`, me, others)
	if err != nil {
		return nil, fmt.Errorf("chat: shared chats: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: shared chats: %w", err)
	}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

func allowedBy(audience int16, contact bool) bool {
	return audience == audEveryone || (audience == audContacts && contact)
}

// checkCanMessage applies blocks and the peer's send_messages audience to
// starting a private chat.
func (s *Service) checkCanMessage(ctx context.Context, q querier, me, peer int64) error {
	users, err := loadUsers(ctx, q, s.cfg.TenantID, []int64{peer})
	if err != nil {
		return err
	}
	if users[peer] == nil {
		return errNotFound("user")
	}
	blocks, err := loadBlocks(ctx, q, []int64{peer}, []int64{me})
	if err != nil {
		return err
	}
	if blocks[blockKey{peer, me}] {
		return errDenied("this user does not accept your messages")
	}
	privacy, err := loadPrivacy(ctx, q, []int64{peer})
	if err != nil {
		return err
	}
	contacts, err := contactsOf(ctx, q, me, []int64{peer})
	if err != nil {
		return err
	}
	if !allowedBy(privacy[peer].SendMessages, contacts[peer]) {
		return errDenied("this user does not accept messages from you")
	}
	return nil
}

// filterAddable splits users into those me may add to a chat and those
// refused (unknown, blocking me, or not allowing it in add_to_groups).
func (s *Service) filterAddable(ctx context.Context, q querier, me int64, userIDs []int64) (allowed, failed []int64, err error) {
	ids := slices.DeleteFunc(uniqueSorted(userIDs), func(id int64) bool { return id == me })
	if len(ids) == 0 {
		return nil, nil, nil
	}
	users, err := loadUsers(ctx, q, s.cfg.TenantID, ids)
	if err != nil {
		return nil, nil, err
	}
	blocks, err := loadBlocks(ctx, q, ids, []int64{me})
	if err != nil {
		return nil, nil, err
	}
	privacy, err := loadPrivacy(ctx, q, ids)
	if err != nil {
		return nil, nil, err
	}
	contacts, err := contactsOf(ctx, q, me, ids)
	if err != nil {
		return nil, nil, err
	}
	for _, id := range ids {
		if users[id] == nil || blocks[blockKey{id, me}] || !allowedBy(privacy[id].AddToGroups, contacts[id]) {
			failed = append(failed, id)
			continue
		}
		allowed = append(allowed, id)
	}
	return allowed, failed, nil
}

// statusOf renders a user's presence for viewer after privacy rules.
func statusOf(u *userRow, viewer int64, p privacyRow, contact, online bool, now time.Time) *appv1.UserStatus {
	exact := u.ID == viewer || allowedBy(p.LastSeen, contact)
	if online && exact {
		return &appv1.UserStatus{Kind: appv1.UserStatusKind_USER_STATUS_KIND_ONLINE, Expires: now.Add(onlineFor).Unix()}
	}
	var seen time.Time
	if online {
		seen = now
	} else if u.LastSeen != nil {
		seen = *u.LastSeen
	}
	if seen.IsZero() {
		return &appv1.UserStatus{}
	}
	if exact {
		return &appv1.UserStatus{Kind: appv1.UserStatusKind_USER_STATUS_KIND_OFFLINE, LastSeen: seen.Unix()}
	}
	switch ago := now.Sub(seen); {
	case ago <= 3*24*time.Hour:
		return &appv1.UserStatus{Kind: appv1.UserStatusKind_USER_STATUS_KIND_RECENTLY}
	case ago <= 7*24*time.Hour:
		return &appv1.UserStatus{Kind: appv1.UserStatusKind_USER_STATUS_KIND_LAST_WEEK}
	case ago <= 30*24*time.Hour:
		return &appv1.UserStatus{Kind: appv1.UserStatusKind_USER_STATUS_KIND_LAST_MONTH}
	default:
		return &appv1.UserStatus{}
	}
}

// usersWithStatus renders users for me with their presence.
func (s *Service) usersWithStatus(ctx context.Context, me int64, ids []int64) ([]*appv1.User, error) {
	users, err := loadUsers(ctx, s.pool, s.cfg.TenantID, ids)
	if err != nil {
		return nil, err
	}
	blocks, err := loadBlocks(ctx, s.pool, []int64{me}, ids)
	if err != nil {
		return nil, err
	}
	privacy, err := loadPrivacy(ctx, s.pool, ids)
	if err != nil {
		return nil, err
	}
	contacts, err := contactsOf(ctx, s.pool, me, ids)
	if err != nil {
		return nil, err
	}
	_, presence := s.realtime()
	now := time.Now()
	var out []*appv1.User
	for _, id := range ids {
		u := users[id]
		if u == nil {
			continue
		}
		r := u.render(me, blocks[blockKey{me, id}])
		r.Status = statusOf(u, me, privacy[id], contacts[id], presence != nil && presence.Online(id), now)
		out = append(out, r)
	}
	return out, nil
}

// UserStatus is a user's presence as viewer may see it; the gateway uses
// it for presence frames.
func (s *Service) UserStatus(ctx context.Context, viewer, userID int64, online bool) (*appv1.UserStatus, error) {
	users, err := loadUsers(ctx, s.pool, s.cfg.TenantID, []int64{userID})
	if err != nil {
		return nil, err
	}
	u := users[userID]
	if u == nil {
		return &appv1.UserStatus{}, nil
	}
	privacy, err := loadPrivacy(ctx, s.pool, []int64{userID})
	if err != nil {
		return nil, err
	}
	contacts, err := contactsOf(ctx, s.pool, viewer, []int64{userID})
	if err != nil {
		return nil, err
	}
	return statusOf(u, viewer, privacy[userID], contacts[userID], online, time.Now()), nil
}

// SetLastSeen records when a user was last online.
func (s *Service) SetLastSeen(ctx context.Context, userID int64, at time.Time) error {
	if _, err := s.pool.Exec(ctx, `UPDATE users SET last_seen_at = $2 WHERE id = $1 AND tenant_id = $3`, userID, at, s.cfg.TenantID); err != nil {
		return fmt.Errorf("chat: set last seen: %w", err)
	}
	return nil
}

// GetUsers returns users of the tenant; unknown ids are omitted.
func (s *Service) GetUsers(ctx context.Context, me int64, ids []int64) ([]*appv1.User, error) {
	ids = uniqueSorted(ids)
	if len(ids) > getUsersMax {
		return nil, errInvalid("at most %d users", getUsersMax)
	}
	return s.usersWithStatus(ctx, me, ids)
}

// ResolveUsername finds a user by exact username.
func (s *Service) ResolveUsername(ctx context.Context, me int64, username string) (*appv1.User, error) {
	name := profile.NormalizeUsername(username)
	if !profile.ValidUsername(name) {
		return nil, errInvalid("invalid username")
	}
	var id int64
	err := s.pool.QueryRow(ctx, `SELECT id FROM users WHERE tenant_id = $1 AND username = $2`, s.cfg.TenantID, name).Scan(&id)
	if isNoRows(err) {
		return nil, errNotFound("user")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: resolve username: %w", err)
	}
	users, err := s.usersWithStatus(ctx, me, []int64{id})
	if err != nil {
		return nil, err
	}
	if len(users) == 0 {
		return nil, errNotFound("user")
	}
	return users[0], nil
}

// SearchUsers matches usernames by prefix and names by substring, and an
// exact email when the owner allows it (find_by_email).
func (s *Service) SearchUsers(ctx context.Context, me int64, query string, limit int32) ([]*appv1.User, error) {
	query = strings.TrimSpace(query)
	if utf8.RuneCountInString(query) < 2 {
		return nil, nil
	}
	if limit <= 0 || limit > searchMax {
		limit = 20
	}
	if err := s.allow(limitSearch, "search", me); err != nil {
		return nil, err
	}
	var rows pgx.Rows
	var err error
	email := strings.Contains(query, "@") && !strings.HasPrefix(query, "@")
	if email {
		rows, err = s.pool.Query(ctx, `
			SELECT u.id, coalesce(p.find_by_email, $4) FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
			WHERE u.tenant_id = $1 AND lower(u.email) = lower($2) AND u.id <> $3`, s.cfg.TenantID, query, me, audNobody)
	} else {
		q := strings.ToLower(strings.TrimPrefix(query, "@"))
		rows, err = s.pool.Query(ctx, `
			SELECT u.id, coalesce(p.find_by_username, $5) FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
			WHERE u.tenant_id = $1 AND u.id <> $4 AND (u.username LIKE $2 || '%' OR lower(u.name) LIKE '%' || $3 || '%')
			ORDER BY (u.username = $2) DESC, u.username LIMIT $6`,
			s.cfg.TenantID, escapeLike(q), escapeLike(strings.ToLower(query)), me, audEveryone, limit*2)
	}
	if err != nil {
		return nil, fmt.Errorf("chat: search users: %w", err)
	}
	type hit struct {
		id       int64
		audience int16
	}
	hits, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (hit, error) {
		var h hit
		err := r.Scan(&h.id, &h.audience)
		return h, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: search users: %w", err)
	}
	ids := make([]int64, len(hits))
	for i, h := range hits {
		ids[i] = h.id
	}
	contacts, err := contactsOf(ctx, s.pool, me, ids)
	if err != nil {
		return nil, err
	}
	var found []int64
	for _, h := range hits {
		if allowedBy(h.audience, contacts[h.id]) && len(found) < int(limit) {
			found = append(found, h.id)
		}
	}
	return s.usersWithStatus(ctx, me, found)
}

// Block blocks a user of the tenant.
func (s *Service) Block(ctx context.Context, me, userID int64) error {
	if userID == me || userID <= 0 {
		return errInvalid("user_id must be another user")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO blocks (blocker_id, blocked_id)
		SELECT $1, id FROM users WHERE id = $2 AND tenant_id = $3
		ON CONFLICT DO NOTHING`, me, userID, s.cfg.TenantID)
	if err != nil {
		return fmt.Errorf("chat: block: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2)`, userID, s.cfg.TenantID).
			Scan(&exists); err != nil {
			return fmt.Errorf("chat: block: %w", err)
		}
		if !exists {
			return errNotFound("user")
		}
	}
	return nil
}

// Unblock removes a block.
func (s *Service) Unblock(ctx context.Context, me, userID int64) error {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, me, userID); err != nil {
		return fmt.Errorf("chat: unblock: %w", err)
	}
	return nil
}

// GetPrivacy returns my privacy settings.
func (s *Service) GetPrivacy(ctx context.Context, me int64) (*appv1.PrivacySettings, error) {
	p, err := loadPrivacy(ctx, s.pool, []int64{me})
	if err != nil {
		return nil, err
	}
	return p[me].render(), nil
}

// SetPrivacy changes the given settings.
func (s *Service) SetPrivacy(ctx context.Context, me int64, req *appv1.SetPrivacyRequest) (*appv1.PrivacySettings, error) {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	all, err := loadPrivacy(ctx, s.pool, []int64{me})
	if err != nil {
		return nil, err
	}
	p := all[me]
	set := func(dst *int16, v *appv1.PrivacyAudience) error {
		if v == nil {
			return nil
		}
		if *v < appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE || *v > appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY {
			return errInvalid("unknown privacy audience")
		}
		*dst = int16(*v)
		return nil
	}
	for _, f := range []struct {
		dst *int16
		v   *appv1.PrivacyAudience
	}{
		{&p.LastSeen, req.LastSeen}, {&p.ProfilePhoto, req.ProfilePhoto}, {&p.FindByEmail, req.FindByEmail},
		{&p.FindByUsername, req.FindByUsername}, {&p.AddToGroups, req.AddToGroups}, {&p.SendMessages, req.SendMessages},
	} {
		if err := set(f.dst, f.v); err != nil {
			return nil, err
		}
	}
	if req.NotificationPreview != nil {
		p.NotificationPreview = req.GetNotificationPreview()
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO privacy_settings (user_id, last_seen, profile_photo, find_by_email, find_by_username, add_to_groups,
			send_messages, notification_preview, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (user_id) DO UPDATE SET last_seen = excluded.last_seen, profile_photo = excluded.profile_photo,
			find_by_email = excluded.find_by_email, find_by_username = excluded.find_by_username,
			add_to_groups = excluded.add_to_groups, send_messages = excluded.send_messages,
			notification_preview = excluded.notification_preview, updated_at = now()`,
		me, p.LastSeen, p.ProfilePhoto, p.FindByEmail, p.FindByUsername, p.AddToGroups, p.SendMessages, p.NotificationPreview); err != nil {
		return nil, fmt.Errorf("chat: set privacy: %w", err)
	}
	return p.render(), nil
}

// Report files a report about a user, a chat or messages into the tenant's
// moderation queue. Reported messages are copied as evidence.
func (s *Service) Report(ctx context.Context, me int64, req *appv1.ReportRequest) error {
	reason := req.GetReason()
	if _, ok := appv1.ReportReason_name[int32(reason)]; !ok || reason == appv1.ReportReason_REPORT_REASON_UNSPECIFIED {
		return errInvalid("reason is required")
	}
	comment := strings.TrimSpace(strings.ToValidUTF8(req.GetComment(), ""))
	if utf8.RuneCountInString(comment) > reportCommentMax {
		return errInvalid("comment is longer than %d characters", reportCommentMax)
	}
	if err := s.allow(limitReport, "report", me); err != nil {
		return err
	}
	var userID, chatID int64
	var seqs []int64
	evidence := []map[string]any{}
	switch target := req.GetTarget().(type) {
	case *appv1.ReportRequest_UserId:
		users, err := loadUsers(ctx, s.pool, s.cfg.TenantID, []int64{target.UserId})
		if err != nil {
			return err
		}
		if users[target.UserId] == nil || target.UserId == me {
			return errNotFound("user")
		}
		userID = target.UserId
	case *appv1.ReportRequest_ChatId:
		if _, _, err := s.chatFor(ctx, s.pool, target.ChatId, me, false); err != nil {
			return err
		}
		chatID = target.ChatId
	case *appv1.ReportRequest_Messages:
		chatID = target.Messages.GetChatId()
		seqs = uniqueSorted(target.Messages.GetSeqs())
		if len(seqs) == 0 || len(seqs) > seqsPerCallMax {
			return errInvalid("seqs must hold 1 to %d messages", seqsPerCallMax)
		}
		_, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
		if err != nil {
			return err
		}
		msgs, err := loadMessages(ctx, s.pool, map[int64][]int64{chatID: seqs})
		if err != nil {
			return err
		}
		for _, seq := range seqs {
			row, ok := msgs[msgKey{chatID, seq}]
			if !ok || row.Seq < m.VisibleFrom {
				return errNotFound("message")
			}
			evidence = append(evidence, map[string]any{
				"seq": row.Seq, "from_id": row.FromID, "date": row.Date.Unix(), "text": row.Text, "deleted": row.Deleted,
			})
		}
	default:
		return errInvalid("a report target is required")
	}
	ev, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("chat: report evidence: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO reports (tenant_id, reporter_id, target_user_id, target_chat_id, seqs, reason, comment, evidence)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		s.cfg.TenantID, me, userID, chatID, append([]int64{}, seqs...), int16(reason), comment, ev); err != nil {
		return fmt.Errorf("chat: file report: %w", err)
	}
	s.logger.Info("report filed", "reporter_id", me, "target_user_id", userID, "target_chat_id", chatID, "reason", reason.String())
	return nil
}

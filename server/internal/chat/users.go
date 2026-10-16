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
	"app.local/server/internal/vifold"
	"github.com/jackc/pgx/v5"
)

// Privacy audiences as stored (app.v1.PrivacyAudience). "Contacts" of a
// user means the users in that user's own contact list (table contacts):
// sharing a chat does not count.
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
	contactsMax      = 10000
	contactsPageDef  = 100
	contactsPageMax  = 500
)

// liveUser is the SQL predicate (alias u) of an account that is neither
// waiting for deletion nor erased: only those can be found.
const liveUser = `u.deletion_requested_at IS NULL AND u.deleted_at IS NULL`

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

// listedBy returns which of owners have viewer in their contact list: for
// each owner, whether viewer is in the owner's audience CONTACTS.
func listedBy(ctx context.Context, q querier, viewer int64, owners []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(owners) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT owner_id FROM contacts WHERE contact_id = $1 AND owner_id = ANY($2)`, viewer, owners)
	if err != nil {
		return nil, fmt.Errorf("chat: contacts: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: contacts: %w", err)
	}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// relatedTo returns which of others me may look up by id: users who share
// a chat me is a current member of (in any membership state, so authors of
// past messages stay resolvable), users in me's contacts and users who have
// me in theirs.
func relatedTo(ctx context.Context, q querier, me int64, others []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(others) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT y.user_id FROM chat_members x JOIN chat_members y ON y.chat_id = x.chat_id AND y.user_id = ANY($2)
		WHERE x.user_id = $1 AND x.left_at IS NULL
		UNION SELECT contact_id FROM contacts WHERE owner_id = $1 AND contact_id = ANY($2)
		UNION SELECT owner_id FROM contacts WHERE contact_id = $1 AND owner_id = ANY($2)`, me, others)
	if err != nil {
		return nil, fmt.Errorf("chat: related users: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: related users: %w", err)
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
	if users[peer] == nil || users[peer].Deleted {
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
	contacts, err := listedBy(ctx, q, me, []int64{peer})
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
func (s *Service) filterAddable(ctx context.Context, q querier, me int64, userIDs []int64) (allowed []int64, failed addFailures, err error) {
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
	contacts, err := listedBy(ctx, q, me, ids)
	if err != nil {
		return nil, nil, err
	}
	for _, id := range ids {
		switch {
		case users[id] == nil || users[id].Deleted:
			failed = append(failed, addFailure{id, appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_NOT_FOUND})
		case blocks[blockKey{id, me}]:
			failed = append(failed, addFailure{id, appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_BLOCKED})
		case !allowedBy(privacy[id].AddToGroups, contacts[id]):
			failed = append(failed, addFailure{id, appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_PRIVACY_ADD_TO_GROUPS})
		default:
			allowed = append(allowed, id)
		}
	}
	return allowed, failed, nil
}

// statusOf renders a user's presence for viewer after privacy rules; a
// user who blocked the viewer shows nothing.
func statusOf(u *userRow, viewer int64, p privacyRow, contact, blockedViewer, online bool, now time.Time) *appv1.UserStatus {
	if (blockedViewer || u.Deleted) && u.ID != viewer {
		return &appv1.UserStatus{}
	}
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
	blockedMe, err := loadBlocks(ctx, s.pool, ids, []int64{me})
	if err != nil {
		return nil, err
	}
	privacy, err := loadPrivacy(ctx, s.pool, ids)
	if err != nil {
		return nil, err
	}
	contacts, err := listedBy(ctx, s.pool, me, ids)
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
		r.Status = statusOf(u, me, privacy[id], contacts[id], blockedMe[blockKey{id, me}],
			presence != nil && presence.Online(id), now)
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
	contacts, err := listedBy(ctx, s.pool, viewer, []int64{userID})
	if err != nil {
		return nil, err
	}
	blocks, err := loadBlocks(ctx, s.pool, []int64{userID}, []int64{viewer})
	if err != nil {
		return nil, err
	}
	return statusOf(u, viewer, privacy[userID], contacts[userID], blocks[blockKey{userID, viewer}], online, time.Now()), nil
}

// SetLastSeen records when a user was last online.
func (s *Service) SetLastSeen(ctx context.Context, userID int64, at time.Time) error {
	if _, err := s.pool.Exec(ctx, `UPDATE users SET last_seen_at = $2 WHERE id = $1 AND tenant_id = $3`, userID, at, s.cfg.TenantID); err != nil {
		return fmt.Errorf("chat: set last seen: %w", err)
	}
	return nil
}

// GetUsers returns the users me is related to (relatedTo) and me; other
// ids are omitted like unknown ones, so ids cannot be used to enumerate
// the tenant's users.
func (s *Service) GetUsers(ctx context.Context, me int64, ids []int64) ([]*appv1.User, error) {
	ids = uniqueSorted(ids)
	if len(ids) > getUsersMax {
		return nil, errInvalid("at most %d users", getUsersMax)
	}
	related, err := relatedTo(ctx, s.pool, me, ids)
	if err != nil {
		return nil, err
	}
	ids = slices.DeleteFunc(ids, func(id int64) bool { return id != me && !related[id] })
	return s.usersWithStatus(ctx, me, ids)
}

// findable looks a user up by exact username or email and applies the
// user's find_by_username or find_by_email audience to me: NotFound when
// there is no such user or they do not allow it, so the answer never tells
// the two apart.
func (s *Service) findable(ctx context.Context, me int64, username, email string) (int64, error) {
	var id int64
	var audience int16
	var err error
	if email != "" {
		err = s.pool.QueryRow(ctx, `
			SELECT u.id, coalesce(p.find_by_email, $3) FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
			WHERE u.tenant_id = $1 AND lower(u.email) = lower($2) AND `+liveUser, s.cfg.TenantID, email, audNobody).Scan(&id, &audience)
	} else {
		err = s.pool.QueryRow(ctx, `
			SELECT u.id, coalesce(p.find_by_username, $3) FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
			WHERE u.tenant_id = $1 AND u.username = $2 AND `+liveUser, s.cfg.TenantID, username, audEveryone).Scan(&id, &audience)
	}
	if isNoRows(err) {
		return 0, errNotFound("user")
	}
	if err != nil {
		return 0, fmt.Errorf("chat: find user: %w", err)
	}
	if id == me {
		return id, nil
	}
	contacts, err := listedBy(ctx, s.pool, me, []int64{id})
	if err != nil {
		return 0, err
	}
	if !allowedBy(audience, contacts[id]) {
		return 0, errNotFound("user")
	}
	return id, nil
}

// ResolveUsername finds a user by exact username when their
// find_by_username allows me.
func (s *Service) ResolveUsername(ctx context.Context, me int64, username string) (*appv1.User, error) {
	name := profile.NormalizeUsername(username)
	if !profile.ValidUsername(name) {
		return nil, errInvalid("invalid username")
	}
	if err := s.allowSearch(ctx, me); err != nil {
		return nil, err
	}
	id, err := s.findable(ctx, me, name, "")
	if err != nil {
		return nil, err
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

// SearchUsers matches usernames by prefix and names by substring, ignoring
// accents and đ (chat_fold_name), and an exact email when the owner allows it
// (find_by_email).
func (s *Service) SearchUsers(ctx context.Context, me int64, query string, limit int32) ([]*appv1.User, error) {
	query = strings.TrimSpace(query)
	if utf8.RuneCountInString(query) < 2 {
		return nil, nil
	}
	if limit <= 0 || limit > searchMax {
		limit = 20
	}
	if err := s.allowSearch(ctx, me); err != nil {
		return nil, err
	}
	var rows pgx.Rows
	var err error
	email := strings.Contains(query, "@") && !strings.HasPrefix(query, "@")
	if email {
		rows, err = s.pool.Query(ctx, `
			SELECT u.id, coalesce(p.find_by_email, $4) FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
			WHERE u.tenant_id = $1 AND lower(u.email) = lower($2) AND u.id <> $3 AND `+liveUser, s.cfg.TenantID, query, me, audNobody)
	} else {
		q := strings.ToLower(strings.TrimPrefix(query, "@"))
		rows, err = s.pool.Query(ctx, `
			SELECT u.id, coalesce(p.find_by_username, $5) FROM users u LEFT JOIN privacy_settings p ON p.user_id = u.id
			WHERE u.tenant_id = $1 AND u.id <> $4 AND `+liveUser+`
				AND (u.username LIKE $2 || '%' OR chat_fold_name(u.name) LIKE '%' || $3 || '%')
			ORDER BY (u.username = $2) DESC, u.username LIMIT $6`,
			s.cfg.TenantID, escapeLike(q), escapeLike(vifold.Fold(query)), me, audEveryone, limit*2)
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
	contacts, err := listedBy(ctx, s.pool, me, ids)
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

// ------------------------------------------------------------- contacts

// AddContact puts a user into my contact list: by id (a user I can already
// see, GetUsers rules), or by exact username or email when the user's
// find_by_username or find_by_email allows me. NotFound otherwise, the same
// as for an unknown user.
func (s *Service) AddContact(ctx context.Context, me int64, req *appv1.AddContactRequest) (*appv1.User, error) {
	var id int64
	switch target := req.GetTarget().(type) {
	case *appv1.AddContactRequest_UserId:
		if target.UserId <= 0 {
			return nil, errInvalid("user_id is required")
		}
		related, err := relatedTo(ctx, s.pool, me, []int64{target.UserId})
		if err != nil {
			return nil, err
		}
		if target.UserId != me && !related[target.UserId] {
			return nil, errNotFound("user")
		}
		id = target.UserId
	case *appv1.AddContactRequest_Username:
		name := profile.NormalizeUsername(strings.TrimPrefix(strings.TrimSpace(target.Username), "@"))
		if !profile.ValidUsername(name) {
			return nil, errInvalid("invalid username")
		}
		if err := s.allowSearch(ctx, me); err != nil {
			return nil, err
		}
		var err error
		if id, err = s.findable(ctx, me, name, ""); err != nil {
			return nil, err
		}
	case *appv1.AddContactRequest_Email:
		email := strings.TrimSpace(target.Email)
		if email == "" || len(email) > 320 || !strings.Contains(email, "@") {
			return nil, errInvalid("invalid email")
		}
		if err := s.allowSearch(ctx, me); err != nil {
			return nil, err
		}
		var err error
		if id, err = s.findable(ctx, me, "", email); err != nil {
			return nil, err
		}
	default:
		return nil, errInvalid("a user_id, username or email is required")
	}
	if id == me {
		return nil, errInvalid("you cannot add yourself")
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM contacts WHERE owner_id = $1`, me).Scan(&count); err != nil {
		return nil, fmt.Errorf("chat: count contacts: %w", err)
	}
	if count >= contactsMax {
		return nil, errPrecondition("a contact list holds at most %d users", contactsMax)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO contacts (tenant_id, owner_id, contact_id)
		SELECT $1, $2, id FROM users WHERE id = $3 AND tenant_id = $1
		ON CONFLICT DO NOTHING`, s.cfg.TenantID, me, id); err != nil {
		return nil, fmt.Errorf("chat: add contact: %w", err)
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

// DeleteContact removes a user from my contact list (no error when absent).
func (s *Service) DeleteContact(ctx context.Context, me, userID int64) error {
	if userID <= 0 {
		return errInvalid("user_id is required")
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM contacts WHERE owner_id = $1 AND contact_id = $2`, me, userID); err != nil {
		return fmt.Errorf("chat: delete contact: %w", err)
	}
	return nil
}

// GetContacts pages through my contact list by user id. The cursor is the
// last user id returned.
func (s *Service) GetContacts(ctx context.Context, me int64, cursor string, limit int32) (*appv1.GetContactsResponse, error) {
	if limit <= 0 {
		limit = contactsPageDef
	}
	limit = min(limit, contactsPageMax)
	after := int64(0)
	if cursor != "" {
		if _, err := fmt.Sscan(cursor, &after); err != nil || after < 0 {
			return nil, errInvalid("invalid cursor")
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.contact_id, c.created_at FROM contacts c JOIN users u ON u.id = c.contact_id AND u.tenant_id = $2
		WHERE c.owner_id = $1 AND c.contact_id > $3 ORDER BY c.contact_id LIMIT $4`, me, s.cfg.TenantID, after, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list contacts: %w", err)
	}
	contacts, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.Contact, error) {
		c := &appv1.Contact{}
		var at time.Time
		err := r.Scan(&c.UserId, &at)
		c.AddedAt = at.Unix()
		return c, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: list contacts: %w", err)
	}
	resp := &appv1.GetContactsResponse{}
	if len(contacts) > int(limit) {
		contacts = contacts[:limit]
		resp.NextCursor = fmt.Sprint(contacts[len(contacts)-1].GetUserId())
	}
	ids := make([]int64, len(contacts))
	for i, c := range contacts {
		ids[i] = c.GetUserId()
	}
	if resp.Users, err = s.usersWithStatus(ctx, me, ids); err != nil {
		return nil, err
	}
	resp.Contacts = contacts
	return resp, nil
}

// Block blocks a user of the tenant.
func (s *Service) Block(ctx context.Context, me, userID int64) error {
	if userID == me || userID <= 0 {
		return errInvalid("user_id must be another user")
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
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
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
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
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
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
	if err := s.allow(ctx, limitReport, "report", me); err != nil {
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
			item := map[string]any{
				"seq": row.Seq, "from_id": row.FromID, "date": row.Date.Unix(), "text": row.Text, "deleted": row.Deleted,
			}
			if row.FromID == 0 && isIntegration(row) {
				item["hook"] = true
			}
			evidence = append(evidence, item)
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

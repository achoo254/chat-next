package chat

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// Invite links carry 128 random bits (ADR 0010: unique per tenant).
const (
	inviteTokenBytes = 16
	invitePath       = "/join/"
	inviteUsageMax   = 100000
	inviteMaxLife    = 366 * 24 * time.Hour
	// invitePreviewMembers: members CheckInvite shows of a group.
	invitePreviewMembers = 5
)

func newInviteToken() (string, error) {
	b := make([]byte, inviteTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("chat: invite token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// parseInvite accepts a full link (…/join/<token>) or the bare token.
func parseInvite(link string) (string, error) {
	link = strings.TrimSpace(link)
	if i := strings.LastIndex(link, "/"); i >= 0 {
		link = link[i+1:]
	}
	link = strings.TrimPrefix(link, "+")
	if len(link) < 22 || len(link) > 64 {
		return "", errInvalid("invalid invite link")
	}
	if _, err := base64.RawURLEncoding.DecodeString(link); err != nil {
		return "", errInvalid("invalid invite link")
	}
	return link, nil
}

func (s *Service) inviteLink(token string) string {
	return s.cfg.PublicOrigin + invitePath + token
}

type inviteRow struct {
	Token      string
	ChatID     int64
	CreatorID  int64
	ExpiresAt  *time.Time
	UsageLimit int32
	UsageCount int32
	Revoked    bool
}

const inviteColumns = `token, chat_id, creator_id, expires_at, usage_limit, usage_count, revoked_at IS NOT NULL`

func scanInvite(row pgx.Row) (*inviteRow, error) {
	i := &inviteRow{}
	err := row.Scan(&i.Token, &i.ChatID, &i.CreatorID, &i.ExpiresAt, &i.UsageLimit, &i.UsageCount, &i.Revoked)
	return i, err
}

func (i *inviteRow) usable(now time.Time) bool {
	return !i.Revoked && (i.ExpiresAt == nil || i.ExpiresAt.After(now)) && (i.UsageLimit == 0 || i.UsageCount < i.UsageLimit)
}

func (s *Service) renderInvite(i *inviteRow) *appv1.InviteLink {
	out := &appv1.InviteLink{
		Link: s.inviteLink(i.Token), CreatorId: i.CreatorID, UsageLimit: i.UsageLimit, UsageCount: i.UsageCount, Revoked: i.Revoked,
	}
	if i.ExpiresAt != nil {
		out.ExpiresAt = i.ExpiresAt.Unix()
	}
	return out
}

// canInvite: admins, and group members allowed to add members.
func canInvite(c *chatRow, m *memberRow) bool {
	return c.Type != typePrivate && (m.isAdmin() || (c.Type == typeGroup && c.can(m, permAddMembers)))
}

// ExportInviteLink creates an invite link.
func (s *Service) ExportInviteLink(ctx context.Context, me, chatID, expiresAt int64, usageLimit int32) (*appv1.InviteLink, error) {
	now := time.Now()
	var expires *time.Time
	if expiresAt != 0 {
		e := time.Unix(expiresAt, 0)
		if !e.After(now) || e.Sub(now) > inviteMaxLife {
			return nil, errInvalid("expires_at must be in the future and within a year")
		}
		expires = &e
	}
	if usageLimit < 0 || usageLimit > inviteUsageMax {
		return nil, errInvalid("usage_limit must be 0 to %d", inviteUsageMax)
	}
	if err := s.allow(limitCreate, "create", me); err != nil {
		return nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, err
	}
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if !canInvite(c, m) {
		return nil, errDenied("you cannot invite people to this chat")
	}
	token, err := newInviteToken()
	if err != nil {
		return nil, err
	}
	inv, err := scanInvite(s.pool.QueryRow(ctx, `
		INSERT INTO invite_links (tenant_id, token, chat_id, creator_id, expires_at, usage_limit)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+inviteColumns,
		s.cfg.TenantID, token, chatID, me, expires, usageLimit))
	if err != nil {
		return nil, fmt.Errorf("chat: create invite: %w", err)
	}
	return s.renderInvite(inv), nil
}

// GetInviteLinks lists a chat's links: every link for admins, their own for
// other members.
func (s *Service) GetInviteLinks(ctx context.Context, me, chatID int64) ([]*appv1.InviteLink, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if !canInvite(c, m) {
		return nil, errDenied("you cannot invite people to this chat")
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+inviteColumns+` FROM invite_links
		WHERE tenant_id = $1 AND chat_id = $2 AND ($3 OR creator_id = $4)
		ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 200`, s.cfg.TenantID, chatID, m.isAdmin(), me)
	if err != nil {
		return nil, fmt.Errorf("chat: list invites: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*inviteRow, error) { return scanInvite(r) })
	if err != nil {
		return nil, fmt.Errorf("chat: list invites: %w", err)
	}
	out := make([]*appv1.InviteLink, len(list))
	for i, inv := range list {
		out[i] = s.renderInvite(inv)
	}
	return out, nil
}

// RevokeInviteLink revokes a link (admins, or its creator).
func (s *Service) RevokeInviteLink(ctx context.Context, me, chatID int64, link string) (*appv1.InviteLink, error) {
	token, err := parseInvite(link)
	if err != nil {
		return nil, err
	}
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	inv, err := scanInvite(s.pool.QueryRow(ctx, `
		UPDATE invite_links SET revoked_at = coalesce(revoked_at, now())
		WHERE tenant_id = $1 AND token = $2 AND chat_id = $3 AND ($4 OR creator_id = $5)
		RETURNING `+inviteColumns, s.cfg.TenantID, token, c.ID, m.isAdmin(), me))
	if isNoRows(err) {
		return nil, errNotFound("invite link")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: revoke invite: %w", err)
	}
	return s.renderInvite(inv), nil
}

// inviteByToken loads a link of the tenant, usable or not.
func (s *Service) inviteByToken(ctx context.Context, q querier, token string) (*inviteRow, error) {
	inv, err := scanInvite(q.QueryRow(ctx, `SELECT `+inviteColumns+` FROM invite_links WHERE tenant_id = $1 AND token = $2`,
		s.cfg.TenantID, token))
	if isNoRows(err) {
		return nil, errNotFound("invite link")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: load invite: %w", err)
	}
	return inv, nil
}

// errBanned answers a banned user who tries to rejoin.
func errBanned() error {
	return errDenied("you were removed from this chat by an admin")
}

// joinCheck looks at a link and the user behind it. It returns the user's
// membership row when they are a current member (they just open the chat),
// errBanned when an admin removed them, and NotFound when the link no longer
// admits anyone: unusable, or its creator is no longer a member allowed to
// invite. usable is the link's own state (expiry, usage, revocation).
func (s *Service) joinCheck(ctx context.Context, q querier, c *chatRow, inv *inviteRow, me int64, usable bool) (*memberRow, error) {
	members, err := loadMembers(ctx, q, []int64{c.ID}, []int64{me, inv.CreatorID})
	if err != nil {
		return nil, err
	}
	m := members[memberKey{c.ID, me}]
	switch {
	case m.active():
		return m, nil
	case m != nil && m.Banned:
		return nil, errBanned()
	}
	if creator := members[memberKey{c.ID, inv.CreatorID}]; !usable || !creator.active() || !canInvite(c, creator) {
		return nil, errNotFound("invite link")
	}
	return nil, nil
}

// CheckInvite previews the chat behind a link before the user joins.
func (s *Service) CheckInvite(ctx context.Context, me int64, link string) (*appv1.CheckInviteResponse, error) {
	token, err := parseInvite(link)
	if err != nil {
		return nil, err
	}
	if err := s.allow(limitJoin, "join", me); err != nil {
		return nil, err
	}
	inv, err := s.inviteByToken(ctx, s.pool, token)
	if err != nil {
		return nil, err
	}
	chats, err := loadChats(ctx, s.pool, s.cfg.TenantID, []int64{inv.ChatID})
	if err != nil {
		return nil, err
	}
	c := chats[inv.ChatID]
	if c == nil {
		return nil, errNotFound("invite link")
	}
	resp := &appv1.CheckInviteResponse{Title: c.Title, About: c.About, Type: chatTypes[c.Type], MemberCount: c.MemberCount,
		HistoryVisibility: c.render(me, nil).GetHistoryVisibility()}
	m, err := s.joinCheck(ctx, s.pool, c, inv, me, inv.usable(time.Now()))
	if err != nil {
		return nil, err
	}
	if m != nil {
		// Members open the chat whatever state the link is in.
		resp.Chat = c.render(me, m)
	}
	// Groups show a few members (a channel's members are for admins only).
	if c.Type == typeGroup {
		rows, err := s.pool.Query(ctx, `
			SELECT user_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL
			ORDER BY (role <> 'member') DESC, joined_at, user_id LIMIT $2`, c.ID, invitePreviewMembers)
		if err != nil {
			return nil, fmt.Errorf("chat: invite preview members: %w", err)
		}
		if resp.MemberIds, err = pgx.CollectRows(rows, pgx.RowTo[int64]); err != nil {
			return nil, fmt.Errorf("chat: invite preview members: %w", err)
		}
		ents := newEntitySet()
		ents.addUsers(me, resp.MemberIds...)
		rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
		if err != nil {
			return nil, err
		}
		resp.Users = rendered.users[me]
	}
	return resp, nil
}

// JoinByInvite adds me to the chat behind a link; joining a chat I am in
// already returns it without using the link.
func (s *Service) JoinByInvite(ctx context.Context, me int64, link string) (*appv1.JoinByInviteResponse, error) {
	token, err := parseInvite(link)
	if err != nil {
		return nil, err
	}
	if err := s.allow(limitJoin, "join", me); err != nil {
		return nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, err
	}
	inv, err := s.inviteByToken(ctx, s.pool, token)
	if err != nil {
		return nil, err
	}
	chatID := inv.ChatID
	t, err := s.inTx(ctx, func(t *txn) error {
		c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+` WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL FOR UPDATE OF c`,
			chatID, s.cfg.TenantID))
		if isNoRows(err) {
			return errNotFound("invite link")
		}
		if err != nil {
			return fmt.Errorf("chat: load chat: %w", err)
		}
		// The usage update below decides whether the link itself is usable.
		if m, err := s.joinCheck(ctx, t.tx, c, inv, me, true); err != nil || m != nil {
			return err
		}
		if int(c.MemberCount) >= s.cfg.ChatMembersMax {
			return errPrecondition("chat_full: this chat reached its member limit")
		}
		tag, err := t.tx.Exec(ctx, `
			UPDATE invite_links SET usage_count = usage_count + 1
			WHERE tenant_id = $1 AND token = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
				AND (usage_limit = 0 OR usage_count < usage_limit)`, s.cfg.TenantID, token)
		if err != nil {
			return fmt.Errorf("chat: use invite: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return errNotFound("invite link")
		}
		_, err = t.addMembers(ctx, c, me, []int64{me}, me, true)
		return err
	})
	if err != nil {
		return nil, err
	}
	chat, users, err := s.GetChat(ctx, me, chatID)
	if err != nil {
		return nil, err
	}
	return &appv1.JoinByInviteResponse{Chat: chat, Users: users, Ack: t.ack(me, chatID)}, nil
}

package chat

import (
	"cmp"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ids"
	"github.com/jackc/pgx/v5"
)

// Text limits of chats, in code points.
const (
	titleMax       = 128
	aboutMax       = 255
	addMembersMax  = 200
	membersPageMax = 200
	dialogsPageMax = 500
	// chatShard is the shard of every chat id until data is split (ADR 0001).
	chatShard = 0
)

func cleanTitle(s string) (string, error) {
	s = strings.Join(strings.Fields(strings.ToValidUTF8(s, "")), " ")
	if s == "" {
		return "", errInvalid("title is required")
	}
	if utf8.RuneCountInString(s) > titleMax {
		return "", errInvalid("title is longer than %d characters", titleMax)
	}
	return s, nil
}

func cleanAbout(s string) (string, error) {
	s = strings.TrimSpace(strings.ToValidUTF8(s, ""))
	if utf8.RuneCountInString(s) > aboutMax {
		return "", errInvalid("description is longer than %d characters", aboutMax)
	}
	return s, nil
}

// chatFor loads a chat of the tenant and the user's membership. lock takes
// the chat row lock (the first lock of every chat mutation). NotFound when
// the chat does not exist or the user was never a member.
func (s *Service) chatFor(ctx context.Context, q querier, chatID, userID int64, lock bool) (*chatRow, *memberRow, error) {
	if chatID <= 0 {
		return nil, nil, errInvalid("chat_id is required")
	}
	sql := `SELECT ` + chatColumns + ` FROM ` + chatFrom + ` WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`
	if lock {
		sql += ` FOR UPDATE OF c`
	}
	c, err := scanChat(q.QueryRow(ctx, sql, chatID, s.cfg.TenantID))
	if isNoRows(err) {
		return nil, nil, errNotFound("chat")
	}
	if err != nil {
		return nil, nil, fmt.Errorf("chat: load chat: %w", err)
	}
	m, err := scanMember(q.QueryRow(ctx, `SELECT `+memberColumns+` FROM chat_members m WHERE m.chat_id = $1 AND m.user_id = $2`,
		chatID, userID))
	if isNoRows(err) {
		return nil, nil, errNotFound("chat")
	}
	if err != nil {
		return nil, nil, fmt.Errorf("chat: load membership: %w", err)
	}
	return c, m, nil
}

// activeChatFor is chatFor for a current member.
func (s *Service) activeChatFor(ctx context.Context, q querier, chatID, userID int64, lock bool) (*chatRow, *memberRow, error) {
	c, m, err := s.chatFor(ctx, q, chatID, userID, lock)
	if err != nil {
		return nil, nil, err
	}
	if !m.active() {
		return nil, nil, errDenied("you are not a member of this chat")
	}
	return c, m, nil
}

// activeMembers returns the user ids of the chat's current members.
func activeMembers(ctx context.Context, q querier, chatID int64) ([]int64, error) {
	rows, err := q.Query(ctx, `SELECT user_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL ORDER BY user_id`, chatID)
	if err != nil {
		return nil, fmt.Errorf("chat: list members: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: list members: %w", err)
	}
	return ids, nil
}

func (s *Service) newChatID(ctx context.Context, q querier) (int64, error) {
	var local int64
	if err := q.QueryRow(ctx, `SELECT nextval('chat_local_id_seq')`).Scan(&local); err != nil {
		return 0, fmt.Errorf("chat: next chat id: %w", err)
	}
	return ids.MakeSharded(chatShard, local)
}

// insertChat creates the chat row and its owner (or both private members).
func (s *Service) insertChat(ctx context.Context, t *txn, c *chatRow) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO chats (id, tenant_id, type, title, about, creator_id, default_permissions, forum, member_count)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
		c.ID, s.cfg.TenantID, c.Type, c.Title, c.About, c.CreatorID, int32(c.DefaultPerms), c.Forum)
	if err != nil {
		return fmt.Errorf("chat: create chat: %w", err)
	}
	return nil
}

// ------------------------------------------------------------------ create

// CreatePrivate returns the private chat between me and peer, creating it
// when needed. No update is written until the first message.
func (s *Service) CreatePrivate(ctx context.Context, me, peer int64) (*appv1.Chat, []*appv1.User, error) {
	if peer <= 0 || peer == me {
		return nil, nil, errInvalid("user_id must be another user")
	}
	if err := s.allow(limitCreate, "create", me); err != nil {
		return nil, nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, nil, err
	}
	low, high := min(me, peer), max(me, peer)
	var chatID int64
	_, err := s.inTx(ctx, func(t *txn) error {
		err := t.tx.QueryRow(ctx, `SELECT chat_id FROM private_chats WHERE tenant_id = $1 AND user_low = $2 AND user_high = $3`,
			s.cfg.TenantID, low, high).Scan(&chatID)
		if err == nil {
			return nil
		}
		if !isNoRows(err) {
			return fmt.Errorf("chat: find private chat: %w", err)
		}
		if err := s.checkCanMessage(ctx, t.tx, me, peer); err != nil {
			return err
		}
		if chatID, err = s.newChatID(ctx, t.tx); err != nil {
			return err
		}
		if err := s.insertChat(ctx, t, &chatRow{ID: chatID, Type: typePrivate, CreatorID: me, DefaultPerms: privatePerms}); err != nil {
			return err
		}
		tag, err := t.tx.Exec(ctx, `
			INSERT INTO private_chats (tenant_id, user_low, user_high, chat_id) VALUES ($1, $2, $3, $4)
			ON CONFLICT DO NOTHING`, s.cfg.TenantID, low, high, chatID)
		if err != nil {
			return fmt.Errorf("chat: create private chat: %w", err)
		}
		if tag.RowsAffected() == 0 {
			// A concurrent call created it; retry reads it.
			return &pgconnRetry{}
		}
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO chat_members (chat_id, user_id, role) SELECT $1, u, 'member' FROM unnest($2::bigint[]) u`,
			chatID, []int64{low, high}); err != nil {
			return fmt.Errorf("chat: add private members: %w", err)
		}
		_, err = t.tx.Exec(ctx, `UPDATE chats SET member_count = 2 WHERE id = $1`, chatID)
		return err
	})
	if isRetry(err) {
		return s.CreatePrivate(ctx, me, peer)
	}
	if err != nil {
		return nil, nil, err
	}
	return s.GetChat(ctx, me, chatID)
}

// CreateGroup creates a group owned by me with the users that allow it.
func (s *Service) CreateGroup(ctx context.Context, me int64, title string, userIDs []int64, forum bool) (*appv1.CreateGroupResponse, error) {
	title, err := cleanTitle(title)
	if err != nil {
		return nil, err
	}
	if len(userIDs) > addMembersMax {
		return nil, errInvalid("at most %d users at once", addMembersMax)
	}
	if err := s.allow(limitCreate, "create", me); err != nil {
		return nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, err
	}
	resp := &appv1.CreateGroupResponse{}
	var chatID int64
	t, err := s.inTx(ctx, func(t *txn) error {
		resp.FailedUserIds = nil
		var err error
		if chatID, err = s.newChatID(ctx, t.tx); err != nil {
			return err
		}
		c := &chatRow{ID: chatID, TenantID: s.cfg.TenantID, Type: typeGroup, Title: title, CreatorID: me,
			SyncMode: syncSmall, HistoryVisibility: visShared, DefaultPerms: defaultGroupPerms, Forum: forum}
		if err := s.insertChat(ctx, t, c); err != nil {
			return err
		}
		if forum {
			if err := t.createGeneralTopic(ctx, c, me); err != nil {
				return err
			}
		}
		allowed, failed, err := s.filterAddable(ctx, t.tx, me, userIDs)
		if err != nil {
			return err
		}
		resp.FailedUserIds, resp.Failures = failed.split()
		return s.startChat(ctx, t, c, me, allowed, &appv1.MessageAction{Kind: &appv1.MessageAction_ChatCreated{
			ChatCreated: &appv1.ActionChatCreated{Title: title}}})
	})
	if err != nil {
		return nil, err
	}
	resp.Ack = t.ack(me, chatID)
	chat, users, err := s.GetChat(ctx, me, chatID)
	if err != nil {
		return nil, err
	}
	resp.Chat, resp.Users = chat, users
	return resp, nil
}

// CreateChannel creates a channel owned by me.
func (s *Service) CreateChannel(ctx context.Context, me int64, title, about string) (*appv1.CreateChannelResponse, error) {
	title, err := cleanTitle(title)
	if err != nil {
		return nil, err
	}
	if about, err = cleanAbout(about); err != nil {
		return nil, err
	}
	if err := s.allow(limitCreate, "create", me); err != nil {
		return nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, err
	}
	var chatID int64
	t, err := s.inTx(ctx, func(t *txn) error {
		var err error
		if chatID, err = s.newChatID(ctx, t.tx); err != nil {
			return err
		}
		c := &chatRow{ID: chatID, TenantID: s.cfg.TenantID, Type: typeChannel, Title: title, About: about, CreatorID: me,
			SyncMode: syncSmall, HistoryVisibility: visShared}
		if err := s.insertChat(ctx, t, c); err != nil {
			return err
		}
		return s.startChat(ctx, t, c, me, nil, &appv1.MessageAction{Kind: &appv1.MessageAction_ChatCreated{
			ChatCreated: &appv1.ActionChatCreated{Title: title}}})
	})
	if err != nil {
		return nil, err
	}
	chat, _, err := s.GetChat(ctx, me, chatID)
	if err != nil {
		return nil, err
	}
	return &appv1.CreateChannelResponse{Chat: chat, Ack: t.ack(me, chatID)}, nil
}

// startChat adds the owner and the first members of a new chat and posts
// the creation message.
func (s *Service) startChat(ctx context.Context, t *txn, c *chatRow, owner int64, others []int64, action *appv1.MessageAction) error {
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO chat_members (chat_id, user_id, role, inviter_id) VALUES ($1, $2, 'owner', $2)`, c.ID, owner); err != nil {
		return fmt.Errorf("chat: add owner: %w", err)
	}
	c.MemberCount = 1
	if _, err := t.insertMembers(ctx, c, others, owner); err != nil {
		return err
	}
	members := append([]int64{owner}, others...)
	if _, err := t.tx.Exec(ctx, `UPDATE chats SET member_count = $2 WHERE id = $1`, c.ID, len(members)); err != nil {
		return fmt.Errorf("chat: count members: %w", err)
	}
	c.MemberCount = int32(len(members))
	ev := t.event(kindMessageNew, c.ID, owner)
	if err := t.maybeGoLarge(ctx, ev, c, members); err != nil {
		return err
	}
	_, err := t.postMessage(ctx, ev, c, members, newMessage{fromID: owner, content: &appv1.Message{Action: action}})
	return err
}

// insertMembers adds users (or re-adds former members) and returns the ones
// that were not members already. member_count is the caller's job.
func (t *txn) insertMembers(ctx context.Context, c *chatRow, users []int64, inviter int64) ([]int64, error) {
	if len(users) == 0 {
		return nil, nil
	}
	visibleFrom := int64(0)
	if c.HistoryVisibility == visSinceJoin {
		visibleFrom = c.LastSeq + 1
	}
	rows, err := t.tx.Query(ctx, `
		INSERT INTO chat_members (chat_id, user_id, role, inviter_id, joined_seq, visible_from_seq)
		SELECT $1, u, 'member', $3, $4, $5 FROM unnest($2::bigint[]) u ORDER BY u
		ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL, left_seq = NULL, banned_at = NULL, banned_by = NULL,
			role = 'member', permissions = NULL, inviter_id = excluded.inviter_id, joined_at = now(),
			joined_seq = excluded.joined_seq, visible_from_seq = excluded.visible_from_seq, read_outbox_max_seq = 0
		WHERE chat_members.left_at IS NOT NULL
		RETURNING user_id`, c.ID, users, inviter, c.LastSeq, visibleFrom)
	if err != nil {
		return nil, fmt.Errorf("chat: add members: %w", err)
	}
	added, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: add members: %w", err)
	}
	slices.Sort(added)
	return added, nil
}

// maybeGoLarge switches a small chat whose membership passed the threshold
// to sync_mode=large: every member's log gets chat_mode_changed with the
// chat_pts to start from (ADR 0002). Later writes of the transaction go to
// the chat's own log.
func (t *txn) maybeGoLarge(ctx context.Context, ev *Event, c *chatRow, members []int64) error {
	if c.SyncMode == syncLarge || c.Type == typePrivate || int(c.MemberCount) <= t.s.cfg.LargeChatThreshold {
		return nil
	}
	if _, err := t.tx.Exec(ctx, `UPDATE chats SET sync_mode = 'large', updated_at = now() WHERE id = $1`, c.ID); err != nil {
		return fmt.Errorf("chat: switch to large: %w", err)
	}
	modeEv := t.event(kindChatModeChanged, c.ID, ev.ActorID)
	t.toUsers(modeEv, members, &appv1.Update{Kind: &appv1.Update_ChatModeChanged{ChatModeChanged: &appv1.UpdateChatModeChanged{
		ChatId: c.ID, SyncMode: appv1.SyncMode_SYNC_MODE_LARGE, ChatPts: c.ChatPts,
	}}})
	c.SyncMode = syncLarge
	t.s.logger.Info("chat switched to sync_mode=large", "chat_id", c.ID, "members", c.MemberCount)
	return nil
}

// ---------------------------------------------------------------- members

// bannedAmong returns which of users are banned from the chat.
func bannedAmong(ctx context.Context, q querier, chatID int64, users []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(users) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id = ANY($2) AND banned_at IS NOT NULL`, chatID, users)
	if err != nil {
		return nil, fmt.Errorf("chat: banned members: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: banned members: %w", err)
	}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// AddMembers adds users to a group or channel. Users not added come back
// with a reason: their privacy or blocks refuse it, they are banned (unless
// an admin adds them, which lifts the ban), they are members already, or
// the chat is full.
func (s *Service) AddMembers(ctx context.Context, me, chatID int64, userIDs []int64) (*appv1.AddMembersResponse, error) {
	if len(userIDs) == 0 || len(userIDs) > addMembersMax {
		return nil, errInvalid("user_ids must hold 1 to %d users", addMembersMax)
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	var failed addFailures
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate {
			return errInvalid("private chats have exactly two members")
		}
		if !c.can(m, permAddMembers) {
			return errDenied("you cannot add members to this chat")
		}
		if err := s.checkUnrestricted(ctx, t.tx, me); err != nil {
			return err
		}
		allowed, refused, err := s.filterAddable(ctx, t.tx, me, userIDs)
		if err != nil {
			return err
		}
		current, err := s.membersAmong(ctx, t.tx, c.ID, allowed)
		if err != nil {
			return err
		}
		allowed = refused.drop(allowed, current, appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_ALREADY_MEMBER)
		if !m.isAdmin() {
			banned, err := bannedAmong(ctx, t.tx, c.ID, allowed)
			if err != nil {
				return err
			}
			allowed = refused.drop(allowed, banned, appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_BANNED)
		}
		if room := s.cfg.ChatMembersMax - int(c.MemberCount); len(allowed) > room {
			full := map[int64]bool{}
			for _, id := range allowed[max(room, 0):] {
				full[id] = true
			}
			allowed = refused.drop(allowed, full, appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_TOO_MANY)
		}
		failed = refused
		_, err = t.addMembers(ctx, c, me, allowed, me, false)
		return err
	})
	if err != nil {
		return nil, err
	}
	resp := &appv1.AddMembersResponse{Ack: t.ack(me, chatID)}
	resp.FailedUserIds, resp.Failures = failed.split()
	return resp, nil
}

// membersAmong returns which of users are current members of the chat.
func (s *Service) membersAmong(ctx context.Context, q querier, chatID int64, users []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(users) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id = ANY($2) AND left_at IS NULL`, chatID, users)
	if err != nil {
		return nil, fmt.Errorf("chat: current members: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: current members: %w", err)
	}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// addFailure is one user not added to a chat, with the reason.
type addFailure struct {
	userID int64
	reason appv1.AddMemberFailureReason
}

type addFailures []addFailure

// drop removes the users in set from users, recording them with reason.
func (f *addFailures) drop(users []int64, set map[int64]bool, reason appv1.AddMemberFailureReason) []int64 {
	return slices.DeleteFunc(users, func(id int64) bool {
		if set[id] {
			*f = append(*f, addFailure{userID: id, reason: reason})
		}
		return set[id]
	})
}

// split returns the legacy failed ids (every refusal except users who are
// members already, sorted) and the failures with reasons, by user id.
func (f addFailures) split() ([]int64, []*appv1.AddMemberFailure) {
	list := slices.Clone(f)
	slices.SortFunc(list, func(a, b addFailure) int { return cmp.Compare(a.userID, b.userID) })
	var ids []int64
	out := make([]*appv1.AddMemberFailure, 0, len(list))
	for _, x := range list {
		if x.reason != appv1.AddMemberFailureReason_ADD_MEMBER_FAILURE_REASON_ALREADY_MEMBER {
			ids = append(ids, x.userID)
		}
		out = append(out, &appv1.AddMemberFailure{UserId: x.userID, Reason: x.reason})
	}
	return ids, out
}

// addMembers adds users to a locked chat and announces them: a service
// message, member_added, and a read position for each newcomer so the
// history before they joined never counts as unread.
func (t *txn) addMembers(ctx context.Context, c *chatRow, actor int64, users []int64, inviter int64, viaInvite bool) ([]int64, error) {
	added, err := t.insertMembers(ctx, c, users, inviter)
	if err != nil || len(added) == 0 {
		return added, err
	}
	if err := t.tx.QueryRow(ctx, `UPDATE chats SET member_count = member_count + $2, updated_at = now() WHERE id = $1 RETURNING member_count`,
		c.ID, len(added)).Scan(&c.MemberCount); err != nil {
		return nil, fmt.Errorf("chat: count members: %w", err)
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO chat_read_states (chat_id, user_id, topic_id, read_inbox_max_seq)
		SELECT $1, u, 0, $3 FROM unnest($2::bigint[]) u
		ON CONFLICT (chat_id, user_id, topic_id) DO UPDATE SET read_inbox_max_seq = excluded.read_inbox_max_seq, updated_at = now()`,
		c.ID, added, c.LastSeq); err != nil {
		return nil, fmt.Errorf("chat: newcomer read state: %w", err)
	}
	members, err := activeMembers(ctx, t.tx, c.ID)
	if err != nil {
		return nil, err
	}
	ev := t.event(kindMemberAdded, c.ID, actor)
	if err := t.maybeGoLarge(ctx, ev, c, members); err != nil {
		return nil, err
	}
	addedUpdate := &appv1.Update{Kind: &appv1.Update_MemberAdded{MemberAdded: &appv1.UpdateMemberAdded{
		ChatId: c.ID, UserIds: added, InviterId: inviter,
	}}}
	if err := t.toChat(ctx, ev, c, members, addedUpdate); err != nil {
		return nil, err
	}
	if c.SyncMode == syncLarge {
		// Newcomers learn about the chat from their own log.
		t.toUsers(ev, added, addedUpdate)
	}
	if c.LastSeq > 0 {
		t.toUsers(ev, added, &appv1.Update{Kind: &appv1.Update_Read{Read: &appv1.UpdateRead{
			ChatId: c.ID, MaxSeq: c.LastSeq, TopSeq: c.LastSeq, ChatPts: chatPtsIfLarge(c),
		}}})
	}
	action := &appv1.MessageAction{Kind: &appv1.MessageAction_MembersAdded{MembersAdded: &appv1.ActionMembersAdded{UserIds: added}}}
	if viaInvite {
		action = &appv1.MessageAction{Kind: &appv1.MessageAction_JoinedByInvite{JoinedByInvite: &appv1.ActionJoinedByInvite{}}}
	}
	if c.Type != typeChannel {
		if _, err := t.postMessage(ctx, ev, c, members, newMessage{fromID: actor, content: &appv1.Message{Action: action}}); err != nil {
			return nil, err
		}
	}
	return added, nil
}

func chatPtsIfLarge(c *chatRow) int64 {
	if c.SyncMode == syncLarge {
		return c.ChatPts
	}
	return 0
}

// RemoveMember removes a member; admins remove members, the owner removes
// admins too. With ban the user is also banned and the invite links they
// created in the chat are revoked; without, they may rejoin by a valid link.
func (s *Service) RemoveMember(ctx context.Context, me, chatID, userID int64, ban bool) (*appv1.SyncAck, error) {
	if userID == me {
		return s.LeaveChat(ctx, me, chatID, 0)
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate {
			return errInvalid("cannot remove members of a private chat")
		}
		target, err := s.memberRow(ctx, t.tx, chatID, userID)
		if err != nil {
			return err
		}
		if !target.active() {
			return errNotFound("member")
		}
		if !m.isAdmin() || target.Role == roleOwner || (target.Role == roleAdmin && m.Role != roleOwner) {
			return errDenied("you cannot remove this member")
		}
		if ban {
			if _, err := t.tx.Exec(ctx, `
				UPDATE invite_links SET revoked_at = now() WHERE chat_id = $1 AND creator_id = $2 AND revoked_at IS NULL`,
				chatID, userID); err != nil {
				return fmt.Errorf("chat: revoke the member's invite links: %w", err)
			}
		}
		return t.removeMember(ctx, c, me, userID, ban)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// errOwnerNeedsAdmin is LeaveChat's answer to an owner who would leave
// members behind without an admin to take the chat over. Clients recognize
// it by failed_precondition on LeaveChat (the only one it returns) and the
// message prefix.
func errOwnerNeedsAdmin() error {
	return errPrecondition("owner_needs_admin: appoint an admin before leaving; ownership passes to the longest-serving admin")
}

// LeaveChat removes me from a group or channel. An owner who leaves hands
// the chat to newOwner, which must be a current admin, or (newOwner 0) to
// the longest-serving admin; with other members but no admin the owner
// cannot leave.
func (s *Service) LeaveChat(ctx context.Context, me, chatID, newOwner int64) (*appv1.SyncAck, error) {
	if newOwner < 0 || newOwner == me {
		return nil, errInvalid("new_owner_id must be another member")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate {
			return errInvalid("cannot leave a private chat")
		}
		var heir int64
		if newOwner != 0 {
			if m.Role != roleOwner {
				return errInvalid("only the owner names a new owner")
			}
			target, err := s.memberRow(ctx, t.tx, chatID, newOwner)
			if isNotFound(err) || (err == nil && (!target.active() || target.Role != roleAdmin)) {
				return errInvalid("new_owner_id must be an admin of the chat")
			}
			if err != nil {
				return err
			}
			heir = newOwner
		} else if m.Role == roleOwner {
			err := t.tx.QueryRow(ctx, `
				SELECT user_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL AND role = 'admin'
				ORDER BY joined_at, user_id LIMIT 1`, chatID).Scan(&heir)
			switch {
			case isNoRows(err) && c.MemberCount > 1:
				return errOwnerNeedsAdmin()
			case err != nil && !isNoRows(err):
				return fmt.Errorf("chat: pick new owner: %w", err)
			}
		}
		if err := t.removeMember(ctx, c, me, me, false); err != nil {
			return err
		}
		if heir == 0 {
			return nil
		}
		return t.setRole(ctx, c, me, heir, roleOwner)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

func (s *Service) memberRow(ctx context.Context, q querier, chatID, userID int64) (*memberRow, error) {
	m, err := scanMember(q.QueryRow(ctx, `SELECT `+memberColumns+` FROM chat_members m WHERE m.chat_id = $1 AND m.user_id = $2`,
		chatID, userID))
	if isNoRows(err) {
		return nil, errNotFound("member")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: load member: %w", err)
	}
	return m, nil
}

// removeMember posts the service message while the user is still a member,
// then removes them (banned when ban) and writes member_removed to the
// remaining members and to the removed user. actor 0 is moderation: no
// service message, and actor_id 0 in member_removed.
func (t *txn) removeMember(ctx context.Context, c *chatRow, actor, userID int64, ban bool) error {
	members, err := activeMembers(ctx, t.tx, c.ID)
	if err != nil {
		return err
	}
	ev := t.event(kindMemberRemoved, c.ID, actor)
	if c.Type != typeChannel && actor != 0 {
		action := &appv1.MessageAction{Kind: &appv1.MessageAction_MemberRemoved{MemberRemoved: &appv1.ActionMemberRemoved{UserId: userID, By: actor}}}
		if actor == userID {
			action = &appv1.MessageAction{Kind: &appv1.MessageAction_MemberLeft{MemberLeft: &appv1.ActionMemberLeft{}}}
		}
		if _, err := t.postMessage(ctx, ev, c, members, newMessage{fromID: actor, content: &appv1.Message{Action: action}}); err != nil {
			return err
		}
	}
	if _, err := t.tx.Exec(ctx, `
		UPDATE chat_members SET left_at = now(), left_seq = $3, role = 'member', permissions = NULL, pin_rank = NULL,
			banned_at = CASE WHEN $4 THEN now() END, banned_by = CASE WHEN $4 THEN $5::bigint END
		WHERE chat_id = $1 AND user_id = $2`, c.ID, userID, c.LastSeq, ban, actor); err != nil {
		return fmt.Errorf("chat: remove member: %w", err)
	}
	if err := t.tx.QueryRow(ctx, `UPDATE chats SET member_count = member_count - 1, updated_at = now() WHERE id = $1 RETURNING member_count`,
		c.ID).Scan(&c.MemberCount); err != nil {
		return fmt.Errorf("chat: count members: %w", err)
	}
	removed := &appv1.Update{Kind: &appv1.Update_MemberRemoved{MemberRemoved: &appv1.UpdateMemberRemoved{
		ChatId: c.ID, UserId: userID, ActorId: actor,
	}}}
	if err := t.toChat(ctx, ev, c, members, removed); err != nil {
		return err
	}
	if c.SyncMode == syncLarge {
		t.toUsers(ev, []int64{userID}, removed)
	}
	ev.Forget = append(ev.Forget, userID)
	return nil
}

// SetMemberPermissions restricts one member (admins only). The member's
// effective rights are these bits within the chat's defaults.
func (s *Service) SetMemberPermissions(ctx context.Context, me, chatID, userID int64, perms uint32) (*appv1.SyncAck, error) {
	if perms&^allPerms != 0 {
		return nil, errInvalid("unknown permission bits")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate || !m.isAdmin() {
			return errDenied("only admins change member permissions")
		}
		target, err := s.memberRow(ctx, t.tx, chatID, userID)
		if err != nil {
			return err
		}
		if !target.active() {
			return errNotFound("member")
		}
		if target.Role != roleMember {
			return errInvalid("admins have every permission; demote them first")
		}
		if _, err := t.tx.Exec(ctx, `UPDATE chat_members SET permissions = $3 WHERE chat_id = $1 AND user_id = $2`,
			chatID, userID, int32(perms)); err != nil {
			return fmt.Errorf("chat: set permissions: %w", err)
		}
		target.Perms = &perms
		return t.announceMember(ctx, c, me, target)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// SetAdmin promotes or demotes a member (owner only).
func (s *Service) SetAdmin(ctx context.Context, me, chatID, userID int64, admin bool) (*appv1.SyncAck, error) {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate || m.Role != roleOwner {
			return errDenied("only the owner appoints admins")
		}
		if userID == me {
			return errInvalid("the owner cannot change their own role")
		}
		role := roleMember
		if admin {
			role = roleAdmin
		}
		return t.setRole(ctx, c, me, userID, role)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

func (t *txn) setRole(ctx context.Context, c *chatRow, actor, userID int64, role string) error {
	target, err := t.s.memberRow(ctx, t.tx, c.ID, userID)
	if err != nil {
		return err
	}
	if !target.active() {
		return errNotFound("member")
	}
	if target.Role == role {
		return nil
	}
	if _, err := t.tx.Exec(ctx, `UPDATE chat_members SET role = $3, permissions = NULL WHERE chat_id = $1 AND user_id = $2`,
		c.ID, userID, role); err != nil {
		return fmt.Errorf("chat: set role: %w", err)
	}
	target.Role, target.Perms = role, nil
	return t.announceMember(ctx, c, actor, target)
}

func (t *txn) announceMember(ctx context.Context, c *chatRow, actor int64, target *memberRow) error {
	members, err := activeMembers(ctx, t.tx, c.ID)
	if err != nil {
		return err
	}
	ev := t.event(kindMemberPermissions, c.ID, actor)
	return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_MemberPermissions{MemberPermissions: &appv1.UpdateMemberPermissions{
		ChatId: c.ID, UserId: target.UserID, Role: memberRoles[target.Role], Permissions: c.permsOf(target),
	}}})
}

// ------------------------------------------------------------ chat info

// SetHistoryVisibility changes what newcomers see (admins only).
func (s *Service) SetHistoryVisibility(ctx context.Context, me, chatID int64, vis appv1.HistoryVisibility) (*appv1.SyncAck, error) {
	value := ""
	switch vis {
	case appv1.HistoryVisibility_HISTORY_VISIBILITY_SHARED:
		value = visShared
	case appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN:
		value = visSinceJoin
	default:
		return nil, errInvalid("history_visibility is required")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate || !m.isAdmin() {
			return errDenied("only admins change history visibility")
		}
		if c.HistoryVisibility == value {
			return nil
		}
		if _, err := t.tx.Exec(ctx, `UPDATE chats SET history_visibility = $2, updated_at = now() WHERE id = $1`, chatID, value); err != nil {
			return fmt.Errorf("chat: set history visibility: %w", err)
		}
		c.HistoryVisibility = value
		return t.chatChanged(ctx, c, me, &appv1.MessageAction{Kind: &appv1.MessageAction_HistoryVisibilityChanged{
			HistoryVisibilityChanged: &appv1.ActionHistoryVisibilityChanged{Visible: value == visShared},
		}})
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// UpdateChatInfo changes title, description, default permissions or turns
// forum topics on.
func (s *Service) UpdateChatInfo(ctx context.Context, me int64, req *appv1.UpdateChatInfoRequest) (*appv1.UpdateChatInfoResponse, error) {
	if req.PhotoFileId != nil {
		return nil, errPrecondition("chat photos need media uploads, which are not available yet")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	chatID := req.GetChatId()
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if c.Type == typePrivate {
			return errInvalid("private chats have no info to change")
		}
		var action *appv1.MessageAction
		changed := false
		if req.Title != nil || req.About != nil {
			if !c.can(m, permChangeInfo) {
				return errDenied("you cannot change this chat's info")
			}
		}
		if req.Title != nil {
			title, err := cleanTitle(req.GetTitle())
			if err != nil {
				return err
			}
			if title != c.Title {
				c.Title, changed = title, true
				action = &appv1.MessageAction{Kind: &appv1.MessageAction_TitleChanged{TitleChanged: &appv1.ActionTitleChanged{Title: title}}}
			}
		}
		if req.About != nil {
			about, err := cleanAbout(req.GetAbout())
			if err != nil {
				return err
			}
			if about != c.About {
				c.About, changed = about, true
			}
		}
		if req.DefaultPermissions != nil {
			if !m.isAdmin() {
				return errDenied("only admins change default permissions")
			}
			perms := req.GetDefaultPermissions()
			if perms&^allPerms != 0 {
				return errInvalid("unknown permission bits")
			}
			if c.Type == typeChannel && perms != 0 {
				return errInvalid("channel members cannot post")
			}
			if perms != c.DefaultPerms {
				c.DefaultPerms, changed = perms, true
			}
		}
		if req.Forum != nil {
			if !m.isAdmin() {
				return errDenied("only admins turn topics on")
			}
			switch {
			case !req.GetForum() && c.Forum:
				return errInvalid("topics cannot be turned off")
			case req.GetForum() && c.Type != typeGroup:
				return errInvalid("only groups have topics")
			case req.GetForum() && !c.Forum:
				if err := t.enableForum(ctx, c, me); err != nil {
					return err
				}
				changed = true
			}
		}
		if !changed {
			return nil
		}
		if _, err := t.tx.Exec(ctx, `
			UPDATE chats SET title = $2, about = $3, default_permissions = $4, forum = $5, updated_at = now() WHERE id = $1`,
			chatID, c.Title, c.About, int32(c.DefaultPerms), c.Forum); err != nil {
			return fmt.Errorf("chat: update chat info: %w", err)
		}
		return t.chatChanged(ctx, c, me, action)
	})
	if err != nil {
		return nil, err
	}
	chat, _, err := s.GetChat(ctx, me, chatID)
	if err != nil {
		return nil, err
	}
	return &appv1.UpdateChatInfoResponse{Chat: chat, Ack: t.ack(me, chatID)}, nil
}

// chatChanged posts an optional service message and chat_updated.
func (t *txn) chatChanged(ctx context.Context, c *chatRow, actor int64, action *appv1.MessageAction) error {
	members, err := activeMembers(ctx, t.tx, c.ID)
	if err != nil {
		return err
	}
	ev := t.event(kindChatUpdated, c.ID, actor)
	if action != nil {
		if _, err := t.postMessage(ctx, ev, c, members, newMessage{fromID: actor, content: &appv1.Message{Action: action}}); err != nil {
			return err
		}
	}
	// The stored chat is rendered again for each viewer on delivery.
	return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_ChatUpdated{ChatUpdated: &appv1.UpdateChatUpdated{
		Chat: &appv1.Chat{Id: c.ID},
	}}})
}

// ------------------------------------------------------------------ reads

// GetChat returns a chat the caller is or was a member of, with the users a
// client needs to show it (the peer of a private chat).
func (s *Service) GetChat(ctx context.Context, me, chatID int64) (*appv1.Chat, []*appv1.User, error) {
	c, m, err := s.chatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, nil, err
	}
	ents := newEntitySet()
	if peer := c.peerOf(me); peer != 0 {
		ents.addUsers(me, peer, me)
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, nil, err
	}
	return c.render(me, m), rendered.users[me], nil
}

// dialogCursor is the opaque GetDialogs cursor: last_message_at (unix
// micros) and chat id of the last dialog returned.
func encodeDialogCursor(at time.Time, chatID int64) string {
	b := make([]byte, 16)
	binary.BigEndian.PutUint64(b[:8], uint64(at.UnixMicro()))
	binary.BigEndian.PutUint64(b[8:], uint64(chatID))
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeDialogCursor(s string) (time.Time, int64, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != 16 {
		return time.Time{}, 0, errInvalid("invalid cursor")
	}
	return time.UnixMicro(int64(binary.BigEndian.Uint64(b[:8]))), int64(binary.BigEndian.Uint64(b[8:])), nil
}

// dialogListed is the condition of a membership m (chat c) that shows in
// the dialog list: current, and not a private chat deleted for oneself
// (visible_from_seq past the newest message) until a new message arrives.
const dialogListed = `m.left_at IS NULL AND NOT (c.type = 'private' AND m.visible_from_seq > c.last_seq)`

// GetDialogs lists the caller's chats: on the first page every pinned chat
// (pinned order) and then the others, newest activity first.
func (s *Service) GetDialogs(ctx context.Context, me int64, cursor string, limit int32) (*appv1.GetDialogsResponse, error) {
	if limit <= 0 || limit > dialogsPageMax {
		limit = 100
	}
	before := time.Unix(1<<40, 0)
	beforeID := int64(1<<62 - 1)
	if cursor != "" {
		var err error
		if before, beforeID, err = decodeDialogCursor(cursor); err != nil {
			return nil, err
		}
	}
	var pinned []int64
	if cursor == "" {
		var err error
		if pinned, err = pinnedDialogs(ctx, s.pool, s.cfg.TenantID, me); err != nil {
			return nil, err
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.last_message_at FROM chat_members m JOIN chats c ON c.id = m.chat_id
		WHERE m.user_id = $1 AND `+dialogListed+` AND m.pin_rank IS NULL AND c.tenant_id = $2
			AND (c.last_message_at, c.id) < ($3, $4)
		ORDER BY c.last_message_at DESC, c.id DESC LIMIT $5`, me, s.cfg.TenantID, before, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list dialogs: %w", err)
	}
	type item struct {
		id int64
		at time.Time
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (item, error) {
		var it item
		err := r.Scan(&it.id, &it.at)
		return it, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: list dialogs: %w", err)
	}
	next := ""
	if len(items) > int(limit) {
		items = items[:limit]
		last := items[len(items)-1]
		next = encodeDialogCursor(last.at, last.id)
	}
	chatIDs := slices.Clone(pinned)
	for _, it := range items {
		chatIDs = append(chatIDs, it.id)
	}
	page, err := s.dialogs(ctx, me, chatIDs)
	if err != nil {
		return nil, err
	}
	return &appv1.GetDialogsResponse{
		Dialogs: page.Dialogs, Messages: page.Messages, Chats: page.Chats, Users: page.Users, NextCursor: next,
		PinnedChatIds: pinned,
	}, nil
}

// pinnedDialogs returns the user's pinned chats, top first.
func pinnedDialogs(ctx context.Context, q querier, tenantID string, me int64) ([]int64, error) {
	rows, err := q.Query(ctx, `
		SELECT c.id FROM chat_members m JOIN chats c ON c.id = m.chat_id
		WHERE m.user_id = $1 AND `+dialogListed+` AND m.pin_rank IS NOT NULL AND c.tenant_id = $2
		ORDER BY m.pin_rank DESC, c.id`, me, tenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: pinned dialogs: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: pinned dialogs: %w", err)
	}
	return ids, nil
}

// GetPeerDialogs returns the caller's dialogs of the given chats.
func (s *Service) GetPeerDialogs(ctx context.Context, me int64, chatIDs []int64) (*appv1.GetPeerDialogsResponse, error) {
	if len(chatIDs) > dialogsPageMax {
		return nil, errInvalid("at most %d chats", dialogsPageMax)
	}
	return s.dialogs(ctx, me, chatIDs)
}

// dialogs renders the caller's dialogs of chatIDs in that order, skipping
// chats the caller is not a member of. Top messages and read states of
// every chat come from one query each.
func (s *Service) dialogs(ctx context.Context, me int64, chatIDs []int64) (*appv1.GetPeerDialogsResponse, error) {
	out := &appv1.GetPeerDialogsResponse{}
	if len(chatIDs) == 0 {
		return out, nil
	}
	chats, err := loadChats(ctx, s.pool, s.cfg.TenantID, chatIDs)
	if err != nil {
		return nil, err
	}
	members, err := loadMembers(ctx, s.pool, chatIDs, []int64{me})
	if err != nil {
		return nil, err
	}
	var list []*memberRow
	seen := map[int64]bool{}
	for _, id := range chatIDs {
		if m := members[memberKey{id, me}]; chats[id] != nil && m.active() && !seen[id] {
			seen[id] = true
			list = append(list, m)
		}
	}
	tops, err := topMessages(ctx, s.pool, me, list)
	if err != nil {
		return nil, err
	}
	states, err := s.readStates(ctx, s.pool, chats, list)
	if err != nil {
		return nil, err
	}
	pins, err := pinnedStates(ctx, s.pool, me, list)
	if err != nil {
		return nil, err
	}
	ents := newEntitySet()
	var topRows []*messageRow
	for _, m := range list {
		c, rs := chats[m.ChatID], states[m.ChatID]
		d := &appv1.Dialog{
			ChatId:              c.ID,
			ReadInboxMaxSeq:     rs.readInbox,
			ReadOutboxMaxSeq:    m.ReadOutbox,
			UnreadCount:         rs.unread,
			UnreadMentionsCount: rs.mentions,
			ChatPts:             chatPtsIfLarge(c),
			MuteUntil:           activeMute(m.MuteUntil, time.Now()),
			Pinned:              m.PinRank != 0,
			PinnedMessageCount:  pins[c.ID].count,
			PinnedMessageSeq:    pins[c.ID].newest,
			UnreadMark:          m.UnreadMark,
		}
		if top := tops[c.ID]; top != nil {
			d.TopSeq = top.Seq
			topRows = append(topRows, top)
		}
		out.Dialogs = append(out.Dialogs, d)
		ents.addChats(me, c.ID)
		if peer := c.peerOf(me); peer != 0 {
			ents.addUsers(me, peer)
		}
	}
	msgs, users, err := s.renderMessages(ctx, s.pool, me, topRows)
	if err != nil {
		return nil, err
	}
	out.Messages = msgs
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	out.Chats = rendered.chats[me]
	out.Users = mergeUsers(rendered.users[me], users)
	return out, nil
}

// pinState is a member's view of a chat's pinned messages.
type pinState struct {
	count  int32
	newest int64
}

// pinnedStates counts, per chat, the pinned messages the member sees
// (history visibility, not hidden for them; pins are always of live
// messages) and finds the newest, in one query.
func pinnedStates(ctx context.Context, q querier, me int64, members []*memberRow) (map[int64]pinState, error) {
	out := map[int64]pinState{}
	if len(members) == 0 {
		return out, nil
	}
	chatIDs := make([]int64, len(members))
	visible := make([]int64, len(members))
	for i, m := range members {
		chatIDs[i], visible[i] = m.ChatID, m.VisibleFrom
	}
	rows, err := q.Query(ctx, `
		SELECT x.chat_id, count(*), max(p.seq) FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, visible_from)
		JOIN pinned_messages p ON p.chat_id = x.chat_id AND p.seq >= x.visible_from
		WHERE NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $3 AND h.chat_id = p.chat_id AND h.seq = p.seq)
		GROUP BY x.chat_id`, chatIDs, visible, me)
	if err != nil {
		return nil, fmt.Errorf("chat: pinned states: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var chatID int64
		var st pinState
		if err := rows.Scan(&chatID, &st.count, &st.newest); err != nil {
			return nil, fmt.Errorf("chat: pinned states: %w", err)
		}
		out[chatID] = st
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: pinned states: %w", err)
	}
	return out, nil
}

// topMessages returns, per chat, the newest message visible to the member
// (history visibility, not hidden for them; a recalled one included as its
// placeholder), in one query.
func topMessages(ctx context.Context, q querier, me int64, members []*memberRow) (map[int64]*messageRow, error) {
	out := map[int64]*messageRow{}
	if len(members) == 0 {
		return out, nil
	}
	chatIDs := make([]int64, len(members))
	visible := make([]int64, len(members))
	for i, m := range members {
		chatIDs[i], visible[i] = m.ChatID, m.VisibleFrom
	}
	rows, err := q.Query(ctx, `
		SELECT newest.* FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, visible_from)
		CROSS JOIN LATERAL (
			SELECT `+messageColumns+` FROM messages m
			WHERE m.chat_id = x.chat_id AND m.seq >= x.visible_from
				AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $3 AND h.chat_id = m.chat_id AND h.seq = m.seq)
			ORDER BY m.seq DESC LIMIT 1) newest`, chatIDs, visible, me)
	if err != nil {
		return nil, fmt.Errorf("chat: top messages: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, fmt.Errorf("chat: top messages: %w", err)
		}
		out[m.ChatID] = m
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: top messages: %w", err)
	}
	return out, nil
}

// unreadMax caps unread counts: counting stops there (clients show "999+"),
// so a long unread history never costs a full scan.
const unreadMax = 1000

// readStateOf is the caller's read position of a chat and its unread count.
type readStateOf struct {
	readInbox int64
	unread    int32
	mentions  int32
	topSeq    int64
	chatPts   int64
}

// unreadVisible is the condition of a message (alias msg) that counts as
// unread for user $1 above position pos (an SQL expression): from someone
// else, not deleted, not hidden for them.
func unreadVisible(pos string) string {
	return `msg.from_id <> $1 AND msg.deleted_at IS NULL AND msg.seq > ` + pos + `
		AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $1 AND h.chat_id = msg.chat_id AND h.seq = msg.seq)`
}

// readStates computes the chat-level read position and unread count of
// each membership (all of one user), in one query. A message is unread when
// it is visible to the member and above both their read position for its
// topic (topic 0 outside forums) and the seq they joined at. In a forum
// only topics whose newest message is above that position are counted.
func (s *Service) readStates(ctx context.Context, q querier, chats map[int64]*chatRow, members []*memberRow) (map[int64]readStateOf, error) {
	out := map[int64]readStateOf{}
	if len(members) == 0 {
		return out, nil
	}
	me := members[0].UserID
	n := len(members)
	chatIDs, forum, joined, visible := make([]int64, n), make([]bool, n), make([]int64, n), make([]int64, n)
	for i, m := range members {
		chatIDs[i], forum[i], joined[i], visible[i] = m.ChatID, chats[m.ChatID].Forum, m.JoinedSeq, m.VisibleFrom
	}
	topicPos := `greatest(coalesce(r.read_inbox_max_seq, 0), x.joined, x.visible - 1)`
	chatPos := `greatest(coalesce(r0.read_inbox_max_seq, 0), x.joined, x.visible - 1)`
	rows, err := q.Query(ctx, `
		SELECT x.chat_id, coalesce(r0.read_inbox_max_seq, 0), c.last_seq, c.chat_pts,
			CASE WHEN x.forum THEN (
				SELECT count(*) FROM (
					SELECT 1 FROM forum_topics t
					LEFT JOIN chat_read_states r ON r.chat_id = t.chat_id AND r.user_id = $1 AND r.topic_id = t.id
					CROSS JOIN LATERAL (
						SELECT 1 FROM messages msg
						WHERE msg.chat_id = t.chat_id AND msg.topic_id = t.id AND `+unreadVisible(topicPos)+`
						LIMIT $6) u
					WHERE t.chat_id = x.chat_id AND t.top_seq > `+topicPos+`
					LIMIT $6) n)
			ELSE (
				SELECT count(*) FROM (
					SELECT 1 FROM messages msg WHERE msg.chat_id = x.chat_id AND `+unreadVisible(chatPos)+`
					LIMIT $6) n)
			END,
			(SELECT count(*) FROM (
				SELECT 1 FROM message_mentions mm
				JOIN messages msg ON msg.chat_id = mm.chat_id AND msg.seq = mm.seq
				LEFT JOIN chat_read_states r ON r.chat_id = msg.chat_id AND r.user_id = $1
					AND r.topic_id = CASE WHEN x.forum THEN msg.topic_id ELSE 0 END
				WHERE mm.user_id = $1 AND mm.chat_id = x.chat_id AND `+unreadVisible(topicPos)+`
				LIMIT $6) mn)
		FROM unnest($2::bigint[], $3::bool[], $4::bigint[], $5::bigint[]) AS x(chat_id, forum, joined, visible)
		JOIN chats c ON c.id = x.chat_id
		LEFT JOIN chat_read_states r0 ON r0.chat_id = x.chat_id AND r0.user_id = $1 AND r0.topic_id = 0`,
		me, chatIDs, forum, joined, visible, unreadMax)
	if err != nil {
		return nil, fmt.Errorf("chat: read states: %w", err)
	}
	defer rows.Close()
	byChat := map[int64]*memberRow{}
	for _, m := range members {
		byChat[m.ChatID] = m
	}
	for rows.Next() {
		var chatID int64
		var rs readStateOf
		var unread, mentions int64
		if err := rows.Scan(&chatID, &rs.readInbox, &rs.topSeq, &rs.chatPts, &unread, &mentions); err != nil {
			return nil, fmt.Errorf("chat: read states: %w", err)
		}
		rs.unread, rs.mentions = int32(min(unread, unreadMax)), int32(min(mentions, unreadMax))
		rs.readInbox = max(rs.readInbox, byChat[chatID].JoinedSeq)
		out[chatID] = rs
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: read states: %w", err)
	}
	return out, nil
}

// readState is readStates of one chat.
func (s *Service) readState(ctx context.Context, q querier, c *chatRow, m *memberRow) (readStateOf, error) {
	states, err := s.readStates(ctx, q, map[int64]*chatRow{c.ID: c}, []*memberRow{m})
	if err != nil {
		return readStateOf{}, err
	}
	rs, ok := states[c.ID]
	if !ok {
		return readStateOf{}, fmt.Errorf("chat: read state of chat %d missing", c.ID)
	}
	return rs, nil
}

func mergeUsers(lists ...[]*appv1.User) []*appv1.User {
	seen := map[int64]bool{}
	var out []*appv1.User
	for _, list := range lists {
		for _, u := range list {
			if !seen[u.GetId()] {
				seen[u.GetId()] = true
				out = append(out, u)
			}
		}
	}
	return out
}

// GetMembers lists current members, optionally filtered by name or
// username (channels: admins only). The cursor is the last user id
// returned.
func (s *Service) GetMembers(ctx context.Context, me, chatID int64, query, cursor string, limit int32) (*appv1.GetMembersResponse, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if c.Type == typeChannel && !m.isAdmin() {
		return nil, errDenied("only admins see the members of a channel")
	}
	if limit <= 0 || limit > membersPageMax {
		limit = 100
	}
	after := int64(0)
	if cursor != "" {
		if _, err := fmt.Sscan(cursor, &after); err != nil || after < 0 {
			return nil, errInvalid("invalid cursor")
		}
	}
	pattern := "%" + escapeLike(strings.ToLower(strings.TrimSpace(query))) + "%"
	rows, err := s.pool.Query(ctx, `
		SELECT `+memberColumns+` FROM chat_members m JOIN users u ON u.id = m.user_id
		WHERE m.chat_id = $1 AND m.left_at IS NULL AND m.user_id > $2
			AND ($3 = '%%' OR lower(u.name) LIKE $3 OR u.username LIKE $3)
		ORDER BY m.user_id LIMIT $4`, c.ID, after, pattern, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list members: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*memberRow, error) { return scanMember(r) })
	if err != nil {
		return nil, fmt.Errorf("chat: list members: %w", err)
	}
	resp := &appv1.GetMembersResponse{}
	if len(list) > int(limit) {
		list = list[:limit]
		resp.NextCursor = fmt.Sprint(list[len(list)-1].UserID)
	}
	ents := newEntitySet()
	for _, m := range list {
		resp.Members = append(resp.Members, &appv1.ChatMember{
			UserId: m.UserID, Role: memberRoles[m.Role], Permissions: c.permsOf(m),
			JoinedAt: m.JoinedAt.Unix(), InviterId: m.InviterID,
		})
		ents.addUsers(me, m.UserID)
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Users = rendered.users[me]
	return resp, nil
}

// UnbanMember lifts a ban (admins). The user is not added back.
func (s *Service) UnbanMember(ctx context.Context, me, chatID, userID int64) error {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return err
	}
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return err
	}
	if c.Type == typePrivate || !m.isAdmin() {
		return errDenied("only admins unban members")
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE chat_members SET banned_at = NULL, banned_by = NULL WHERE chat_id = $1 AND user_id = $2 AND banned_at IS NOT NULL`,
		chatID, userID)
	if err != nil {
		return fmt.Errorf("chat: unban: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errNotFound("banned member")
	}
	return nil
}

// GetBannedMembers lists the chat's banned users by user id (admins). The
// cursor is the last user id returned.
func (s *Service) GetBannedMembers(ctx context.Context, me, chatID int64, cursor string, limit int32) (*appv1.GetBannedMembersResponse, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if c.Type == typePrivate || !m.isAdmin() {
		return nil, errDenied("only admins see banned members")
	}
	if limit <= 0 || limit > membersPageMax {
		limit = 100
	}
	after := int64(0)
	if cursor != "" {
		if _, err := fmt.Sscan(cursor, &after); err != nil || after < 0 {
			return nil, errInvalid("invalid cursor")
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT user_id, coalesce(banned_by, 0), banned_at FROM chat_members
		WHERE chat_id = $1 AND banned_at IS NOT NULL AND user_id > $2
		ORDER BY user_id LIMIT $3`, c.ID, after, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: list banned: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.BannedMember, error) {
		b := &appv1.BannedMember{}
		var at time.Time
		err := r.Scan(&b.UserId, &b.BannedBy, &at)
		b.BannedAt = at.Unix()
		return b, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: list banned: %w", err)
	}
	resp := &appv1.GetBannedMembersResponse{}
	if len(list) > int(limit) {
		list = list[:limit]
		resp.NextCursor = fmt.Sprint(list[len(list)-1].GetUserId())
	}
	ents := newEntitySet()
	for _, b := range list {
		ents.addUsers(me, b.GetUserId(), b.GetBannedBy())
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	resp.Members, resp.Users = list, rendered.users[me]
	return resp, nil
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// pgconnRetry makes inTx's caller run the whole operation again (a
// concurrent insert won a unique key).
type pgconnRetry struct{}

func (*pgconnRetry) Error() string { return "chat: retry" }

func isRetry(err error) bool {
	_, ok := err.(*pgconnRetry)
	return ok
}

package chat

import (
	"context"
	"fmt"
	"slices"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// The member_changed and reaction updates of bots, cut from the log entries
// the outbox rows wrote: a bot's own membership changes (member_added,
// member_removed, member_permissions, and the chat_created message of a
// chat created with it) and reactions on its messages.

// memberEvent is a change of a bot's membership found in a row.
type memberEvent struct {
	row    OutboxRow
	bot    int64
	chatID int64
	change BotMemberChange
	// removed: the bot was removed or left; banned or not is read at cut
	// time.
	removed bool
}

// reactionEvent is a reaction on a message of a bot found in a row.
type reactionEvent struct {
	row       OutboxRow
	bot       int64
	chatID    int64
	seq, user int64
}

func isChatCreated(m *messageRow) bool {
	if len(m.Content) == 0 {
		return false
	}
	var content appv1.Message
	return proto.Unmarshal(m.Content, &content) == nil && content.GetAction().GetChatCreated() != nil
}

// botEventUpdates cuts member_changed and reaction updates from the member
// and reaction rows (members: the live bots that are current members of the
// rows' chats) and renders the chat_created memberships found among the
// messages.
func (s *Service) botEventUpdates(ctx context.Context, rows []OutboxRow, members map[int64][]botMember, created []memberEvent) ([]BotUpdate, error) {
	// Bots that may be concerned: current bot members, and for removals the
	// bots among the recipients (a removed bot gets the entry in its log).
	var recipients []int64
	for _, r := range rows {
		if r.Kind == kindMemberRemoved {
			recipients = append(recipients, r.UserIDs...)
		}
	}
	removedBots, err := s.liveBotsAmong(ctx, uniqueSorted(recipients))
	if err != nil {
		return nil, err
	}
	type logKey struct{ id, pos int64 }
	var users, pts, chats, chatPts []int64
	userRow := map[logKey]OutboxRow{}
	chatRow := map[logKey]OutboxRow{}
	for _, r := range rows {
		concerned := func(u int64) bool {
			if r.Kind == kindMemberRemoved {
				return removedBots[u]
			}
			return slices.ContainsFunc(members[r.ChatID], func(b botMember) bool { return b.botID == u })
		}
		hit := false
		for i, u := range r.UserIDs {
			if i < len(r.Pts) && concerned(u) {
				users, pts = append(users, u), append(pts, r.Pts[i])
				userRow[logKey{u, r.Pts[i]}] = r
				hit = true
			}
		}
		if len(members[r.ChatID]) == 0 && !hit {
			continue
		}
		for _, p := range r.ChatPts {
			chats, chatPts = append(chats, r.ChatID), append(chatPts, p)
			chatRow[logKey{r.ChatID, p}] = r
		}
	}
	type eventKey struct{ bot, row int64 }
	seen := map[eventKey]bool{}
	var events []memberEvent
	for _, e := range created {
		if !seen[eventKey{e.bot, e.row.ID}] {
			seen[eventKey{e.bot, e.row.ID}] = true
			events = append(events, e)
		}
	}
	var reactions []reactionEvent
	reacted := map[int64][]int64{}
	// owner is the bot whose log holds the entry; 0 for the chat log, where
	// any bot target counts.
	collect := func(r OutboxRow, owner int64, u *appv1.Update) {
		var found []memberEvent
		switch k := u.GetKind().(type) {
		case *appv1.Update_MemberAdded:
			for _, id := range k.MemberAdded.GetUserIds() {
				found = append(found, memberEvent{bot: id, change: BotMemberChange{ActorID: k.MemberAdded.GetInviterId(), Status: MemberStatusMember}})
			}
		case *appv1.Update_MemberRemoved:
			found = append(found, memberEvent{bot: k.MemberRemoved.GetUserId(), removed: true,
				change: BotMemberChange{ActorID: k.MemberRemoved.GetActorId(), Status: MemberStatusLeft}})
		case *appv1.Update_MemberPermissions:
			p := k.MemberPermissions
			status := MemberStatusMember
			switch p.GetRole() {
			case appv1.MemberRole_MEMBER_ROLE_OWNER:
				status = MemberStatusOwner
			case appv1.MemberRole_MEMBER_ROLE_ADMIN:
				status = MemberStatusAdmin
			default:
			}
			found = append(found, memberEvent{bot: p.GetUserId(), change: BotMemberChange{ActorID: r.ActorID, Status: status, Permissions: p.GetPermissions()}})
		case *appv1.Update_Reaction:
			if r.Kind == kindReaction {
				reactions = append(reactions, reactionEvent{row: r, chatID: k.Reaction.GetChatId(), seq: k.Reaction.GetSeq(), user: r.ActorID})
				reacted[k.Reaction.GetChatId()] = append(reacted[k.Reaction.GetChatId()], k.Reaction.GetSeq())
			}
		default:
		}
		for _, e := range found {
			if (owner != 0 && e.bot != owner) || e.bot == 0 {
				continue
			}
			if r.Kind == kindMemberRemoved && !removedBots[e.bot] {
				continue
			}
			if r.Kind != kindMemberRemoved && !slices.ContainsFunc(members[r.ChatID], func(b botMember) bool { return b.botID == e.bot }) {
				continue
			}
			if seen[eventKey{e.bot, r.ID}] {
				continue
			}
			seen[eventKey{e.bot, r.ID}] = true
			e.row, e.chatID = r, r.ChatID
			events = append(events, e)
		}
	}
	if err := readUserLog(ctx, s.pool, users, pts, func(user, pos int64, u *appv1.Update) {
		collect(userRow[logKey{user, pos}], user, u)
	}); err != nil {
		return nil, err
	}
	if err := readChatLog(ctx, s.pool, chats, chatPts, func(chatID, pos int64, u *appv1.Update) {
		collect(chatRow[logKey{chatID, pos}], 0, u)
	}); err != nil {
		return nil, err
	}
	out, err := s.renderMemberEvents(ctx, events)
	if err != nil {
		return nil, err
	}
	more, err := s.renderReactionEvents(ctx, reactions, reacted, members)
	if err != nil {
		return nil, err
	}
	return append(out, more...), nil
}

// liveBotsAmong returns which of ids are live bots of the tenant.
func (s *Service) liveBotsAmong(ctx context.Context, ids []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT user_id FROM bots WHERE user_id = ANY($1) AND tenant_id = $2 AND deleted_at IS NULL`,
		ids, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: find bots: %w", err)
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: find bots: %w", err)
	}
	for _, id := range list {
		out[id] = true
	}
	return out, nil
}

// renderMemberEvents renders member_changed updates: the chat as the bot
// sees it, the actor, and the bot's membership (a removal reads banned or
// left from the member row; an addition the permissions of the chat).
func (s *Service) renderMemberEvents(ctx context.Context, events []memberEvent) ([]BotUpdate, error) {
	if len(events) == 0 {
		return nil, nil
	}
	var chatIDs, userIDs []int64
	for _, e := range events {
		chatIDs = append(chatIDs, e.chatID)
		userIDs = append(userIDs, e.bot, e.change.ActorID)
	}
	chats, err := loadChats(ctx, s.pool, s.cfg.TenantID, uniqueSorted(chatIDs))
	if err != nil {
		return nil, err
	}
	people, err := loadUsers(ctx, s.pool, s.cfg.TenantID, uniqueSorted(userIDs))
	if err != nil {
		return nil, err
	}
	var out []BotUpdate
	for _, e := range events {
		c := chats[e.chatID]
		if c == nil {
			continue
		}
		m, err := s.memberRow(ctx, s.pool, c.ID, e.bot)
		if err != nil && !isNotFound(err) {
			return nil, err
		}
		change := e.change
		switch {
		case e.removed && m != nil && m.Banned:
			change.Status, change.Permissions = MemberStatusBanned, 0
		case e.removed:
			change.Status, change.Permissions = MemberStatusLeft, 0
		case change.Status == MemberStatusMember && m.active() && m.Role == roleMember:
			change.Permissions = c.permsOf(m)
		}
		var users []*appv1.User
		for _, id := range []int64{e.bot, change.ActorID} {
			if u := people[id]; u != nil {
				users = append(users, u.render(e.bot, false))
			}
		}
		out = append(out, BotUpdate{
			BotID: e.bot, OutboxID: e.row.ID, Kind: BotUpdateMemberChanged, At: e.row.CreatedAt,
			Chat: c.render(e.bot, m), Users: users, Member: &change,
		})
	}
	return out, nil
}

// renderReactionEvents keeps the reactions on messages of live bots that
// are current members of the chat (never a bot's own or another bot's
// reaction) and reads the reactor's reaction as of now.
func (s *Service) renderReactionEvents(ctx context.Context, events []reactionEvent, keys map[int64][]int64, members map[int64][]botMember) ([]BotUpdate, error) {
	if len(events) == 0 {
		return nil, nil
	}
	msgs, err := loadMessages(ctx, s.pool, keys)
	if err != nil {
		return nil, err
	}
	var reactors []int64
	for _, e := range events {
		reactors = append(reactors, e.user)
	}
	botReactors, err := botsAmong(ctx, s.pool, uniqueSorted(reactors))
	if err != nil {
		return nil, err
	}
	type eventKey struct{ bot, row int64 }
	seen := map[eventKey]bool{}
	var kept []reactionEvent
	var chatIDs []int64
	for _, e := range events {
		m := msgs[msgKey{e.chatID, e.seq}]
		if m == nil || m.Deleted || botReactors[e.user] || e.user == 0 ||
			!slices.ContainsFunc(members[e.chatID], func(b botMember) bool { return b.botID == m.FromID }) {
			continue
		}
		e.bot = m.FromID
		if seen[eventKey{e.bot, e.row.ID}] {
			continue
		}
		seen[eventKey{e.bot, e.row.ID}] = true
		kept = append(kept, e)
		chatIDs = append(chatIDs, e.chatID)
	}
	if len(kept) == 0 {
		return nil, nil
	}
	chats, err := loadChats(ctx, s.pool, s.cfg.TenantID, uniqueSorted(chatIDs))
	if err != nil {
		return nil, err
	}
	var out []BotUpdate
	for _, e := range kept {
		c := chats[e.chatID]
		if c == nil {
			continue
		}
		var emoji string
		err := s.pool.QueryRow(ctx, `SELECT emoji FROM message_reactions WHERE chat_id = $1 AND seq = $2 AND user_id = $3`,
			e.chatID, e.seq, e.user).Scan(&emoji)
		if err != nil && !isNoRows(err) {
			return nil, fmt.Errorf("chat: read reaction: %w", err)
		}
		chat, users, err := s.botChat(ctx, c, e.bot)
		if err != nil {
			return nil, err
		}
		list, err := loadUsers(ctx, s.pool, s.cfg.TenantID, []int64{e.user})
		if err != nil {
			return nil, err
		}
		if u := list[e.user]; u != nil {
			users = mergeUsers(users, []*appv1.User{u.render(e.bot, false)})
		}
		out = append(out, BotUpdate{
			BotID: e.bot, OutboxID: e.row.ID, Kind: BotUpdateReaction, At: e.row.CreatedAt, Chat: chat, Users: users,
			Reaction: &BotReaction{Seq: e.seq, UserID: e.user, Emoji: emoji},
		})
	}
	return out, nil
}

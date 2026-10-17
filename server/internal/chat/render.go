package chat

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// Chat types, sync modes, history visibility and roles as stored.
const (
	typePrivate = "private"
	typeGroup   = "group"
	typeChannel = "channel"

	syncSmall = "small"
	syncLarge = "large"

	visShared    = "shared"
	visSinceJoin = "since_join"

	roleMember = "member"
	roleAdmin  = "admin"
	roleOwner  = "owner"
)

// Permission bits (app.v1.ChatPermission).
const (
	permSend         = uint32(appv1.ChatPermission_CHAT_PERMISSION_SEND_MESSAGES)
	permMedia        = uint32(appv1.ChatPermission_CHAT_PERMISSION_SEND_MEDIA)
	permAddMembers   = uint32(appv1.ChatPermission_CHAT_PERMISSION_ADD_MEMBERS)
	permPin          = uint32(appv1.ChatPermission_CHAT_PERMISSION_PIN_MESSAGES)
	permChangeInfo   = uint32(appv1.ChatPermission_CHAT_PERMISSION_CHANGE_INFO)
	permManageTopics = uint32(appv1.ChatPermission_CHAT_PERMISSION_MANAGE_TOPICS)

	allPerms     = permSend | permMedia | permAddMembers | permPin | permChangeInfo | permManageTopics
	privatePerms = permSend | permMedia | permPin
	// Defaults of a new group: members talk, add people and open topics;
	// pinning and chat info are for admins.
	defaultGroupPerms = permSend | permMedia | permAddMembers | permManageTopics
)

// ------------------------------------------------------------------ chats

type chatRow struct {
	ID                int64
	TenantID          string
	Type              string
	Title             string
	About             string
	CreatorID         int64
	SyncMode          string
	HistoryVisibility string
	DefaultPerms      uint32
	Forum             bool
	LastSeq           int64
	ChatPts           int64
	LastTopicID       int64
	MemberCount       int32
	PinnedSeq         int64
	CreatedAt         time.Time
	// The newest message (creation before any): what the dialog list orders by.
	LastMessageAt time.Time
	// Private chats: the two participants.
	UserLow, UserHigh int64
	// PhotoID is the file_id of the group's or channel's photo ("" without one).
	PhotoID string
}

const chatColumns = `c.id, c.tenant_id, c.type, c.title, c.about, c.creator_id, c.sync_mode, c.history_visibility,
	c.default_permissions, c.forum, c.last_seq, c.chat_pts, c.last_topic_id, c.member_count, c.pinned_seq, c.created_at,
	c.last_message_at, coalesce(p.user_low, 0), coalesce(p.user_high, 0),
	coalesce((SELECT cf.public_id FROM files cf WHERE cf.id = c.photo_file_id), '')`

const chatFrom = `chats c LEFT JOIN private_chats p ON p.chat_id = c.id`

func scanChat(row pgx.Row) (*chatRow, error) {
	c := &chatRow{}
	var perms int32
	err := row.Scan(&c.ID, &c.TenantID, &c.Type, &c.Title, &c.About, &c.CreatorID, &c.SyncMode, &c.HistoryVisibility,
		&perms, &c.Forum, &c.LastSeq, &c.ChatPts, &c.LastTopicID, &c.MemberCount, &c.PinnedSeq, &c.CreatedAt,
		&c.LastMessageAt, &c.UserLow, &c.UserHigh, &c.PhotoID)
	c.DefaultPerms = uint32(perms)
	return c, err
}

// peerOf returns the other participant of a private chat.
func (c *chatRow) peerOf(viewer int64) int64 {
	switch viewer {
	case c.UserLow:
		return c.UserHigh
	case c.UserHigh:
		return c.UserLow
	default:
		return 0
	}
}

type memberRow struct {
	ChatID      int64
	UserID      int64
	Role        string
	Perms       *uint32
	InviterID   int64
	JoinedAt    time.Time
	JoinedSeq   int64
	VisibleFrom int64
	ReadOutbox  int64
	Left        bool
	// Former members: when they left and the chat's last seq then.
	LeftAt  *time.Time
	LeftSeq int64
	// Removed by an admin and not unbanned yet.
	Banned bool
	// The member's own dialog settings: muted until (unix seconds, 0 = not
	// muted) and pinned position (0 = not pinned).
	MuteUntil int64
	PinRank   int32
	// The member marked the chat as unread.
	UnreadMark bool
}

const memberColumns = `m.chat_id, m.user_id, m.role, m.permissions, m.inviter_id, m.joined_at, m.joined_seq,
	m.visible_from_seq, m.read_outbox_max_seq, m.left_at IS NOT NULL, m.left_at, coalesce(m.left_seq, 0),
	m.banned_at IS NOT NULL, m.mute_until, coalesce(m.pin_rank, 0), m.unread_mark`

func scanMember(row pgx.Row) (*memberRow, error) {
	m := &memberRow{}
	var perms *int32
	err := row.Scan(&m.ChatID, &m.UserID, &m.Role, &perms, &m.InviterID, &m.JoinedAt, &m.JoinedSeq,
		&m.VisibleFrom, &m.ReadOutbox, &m.Left, &m.LeftAt, &m.LeftSeq, &m.Banned, &m.MuteUntil, &m.PinRank,
		&m.UnreadMark)
	if perms != nil {
		p := uint32(*perms)
		m.Perms = &p
	}
	return m, err
}

func (m *memberRow) active() bool {
	return m != nil && !m.Left
}

// sees reports whether the member (current or former) may see a message's
// content: within history visibility, and for a former member only what
// existed when they left, unchanged since.
func (m *memberRow) sees(msg *messageRow) bool {
	if m == nil || msg.Seq < m.VisibleFrom {
		return false
	}
	if !m.Left {
		return true
	}
	if msg.Seq > m.LeftSeq {
		return false
	}
	return msg.ChangedAt == nil || m.LeftAt == nil || !msg.ChangedAt.After(*m.LeftAt)
}

func (m *memberRow) isAdmin() bool {
	return m.active() && (m.Role == roleAdmin || m.Role == roleOwner)
}

// permsOf returns the effective ChatPermission bits of a member.
func (c *chatRow) permsOf(m *memberRow) uint32 {
	if !m.active() {
		return 0
	}
	switch {
	case c.Type == typePrivate:
		return privatePerms
	case m.Role == roleOwner || m.Role == roleAdmin:
		return allPerms
	case c.Type == typeChannel:
		return 0
	case m.Perms != nil:
		return *m.Perms & c.DefaultPerms
	default:
		return c.DefaultPerms
	}
}

func (c *chatRow) can(m *memberRow, perm uint32) bool {
	return c.permsOf(m)&perm == perm
}

var chatTypes = map[string]appv1.ChatType{
	typePrivate: appv1.ChatType_CHAT_TYPE_PRIVATE,
	typeGroup:   appv1.ChatType_CHAT_TYPE_GROUP,
	typeChannel: appv1.ChatType_CHAT_TYPE_CHANNEL,
	"secret":    appv1.ChatType_CHAT_TYPE_SECRET,
}

var memberRoles = map[string]appv1.MemberRole{
	roleMember: appv1.MemberRole_MEMBER_ROLE_MEMBER,
	roleAdmin:  appv1.MemberRole_MEMBER_ROLE_ADMIN,
	roleOwner:  appv1.MemberRole_MEMBER_ROLE_OWNER,
}

// render returns the chat as viewer sees it; m is the viewer's membership
// (nil when never a member).
func (c *chatRow) render(viewer int64, m *memberRow) *appv1.Chat {
	out := &appv1.Chat{
		Id:                 c.ID,
		Type:               chatTypes[c.Type],
		Title:              c.Title,
		About:              c.About,
		SyncMode:           appv1.SyncMode_SYNC_MODE_SMALL,
		HistoryVisibility:  appv1.HistoryVisibility_HISTORY_VISIBILITY_SHARED,
		MemberCount:        c.MemberCount,
		DefaultPermissions: c.DefaultPerms,
		PinnedSeq:          c.PinnedSeq,
		CreatedAt:          c.CreatedAt.Unix(),
		MyPermissions:      c.permsOf(m),
		Left:               !m.active(),
		Forum:              c.Forum,
	}
	if c.SyncMode == syncLarge {
		out.SyncMode = appv1.SyncMode_SYNC_MODE_LARGE
	}
	if c.HistoryVisibility == visSinceJoin {
		out.HistoryVisibility = appv1.HistoryVisibility_HISTORY_VISIBILITY_SINCE_JOIN
	}
	if c.Type == typePrivate {
		out.Title, out.About = "", ""
		out.PeerUserId = c.peerOf(viewer)
	}
	// Only members fetch the photo (chat_photo_of).
	if c.PhotoID != "" && c.Type != typePrivate && m.active() {
		out.Photo = media.PhotoRef(c.PhotoID)
	}
	if m.active() {
		out.MyRole = memberRoles[m.Role]
	}
	return out
}

func loadChats(ctx context.Context, q querier, tenantID string, ids []int64) (map[int64]*chatRow, error) {
	out := map[int64]*chatRow{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+` WHERE c.tenant_id = $1 AND c.id = ANY($2)`,
		tenantID, ids)
	if err != nil {
		return nil, fmt.Errorf("chat: load chats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, fmt.Errorf("chat: load chats: %w", err)
		}
		out[c.ID] = c
	}
	return out, rows.Err()
}

type memberKey struct{ chatID, userID int64 }

func loadMembers(ctx context.Context, q querier, chatIDs, userIDs []int64) (map[memberKey]*memberRow, error) {
	out := map[memberKey]*memberRow{}
	if len(chatIDs) == 0 || len(userIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT `+memberColumns+` FROM chat_members m WHERE m.chat_id = ANY($1) AND m.user_id = ANY($2)`,
		chatIDs, userIDs)
	if err != nil {
		return nil, fmt.Errorf("chat: load members: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		m, err := scanMember(rows)
		if err != nil {
			return nil, fmt.Errorf("chat: load members: %w", err)
		}
		out[memberKey{m.ChatID, m.UserID}] = m
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------ users

type userRow struct {
	ID       int64
	Username string
	Name     string
	Bio      string
	Email    string
	LastSeen *time.Time
	IsBot    bool
	// InlinePlaceholder: a bot with inline mode on ("" when off).
	InlinePlaceholder string
	// Deleted: the account waits for deletion or was erased; others see a
	// deleted account without profile.
	Deleted bool
	// PhotoID is the file_id of the profile photo ("" without one).
	PhotoID string
	// photoSeenBy: viewers the owner's privacy shows a person's photo to
	// (seePhotos); bots' photos everyone sees.
	photoSeenBy map[int64]bool
}

// seePhotos records which viewers may see the photos of users: wanted
// lists, per viewer, the users they will render.
func seePhotos(ctx context.Context, q querier, users map[int64]*userRow, wanted map[int64][]int64) error {
	var pairs []photoPair
	for viewer, ids := range wanted {
		for _, id := range ids {
			if u := users[id]; u != nil && u.PhotoID != "" && !u.IsBot && id != viewer {
				pairs = append(pairs, photoPair{owner: id, viewer: viewer})
			}
		}
	}
	seen, err := photoSeen(ctx, q, pairs)
	if err != nil {
		return err
	}
	for p := range seen {
		u := users[p.owner]
		if u.photoSeenBy == nil {
			u.photoSeenBy = map[int64]bool{}
		}
		u.photoSeenBy[p.viewer] = true
	}
	return nil
}

func loadUsers(ctx context.Context, q querier, tenantID string, ids []int64) (map[int64]*userRow, error) {
	out := map[int64]*userRow{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT u.id, u.username, u.name, u.bio, coalesce(u.email, ''), u.last_seen_at, u.is_bot,
			u.deletion_requested_at IS NOT NULL OR u.deleted_at IS NOT NULL, coalesce(b.inline_placeholder, ''),
			coalesce(pf.public_id, '')
		FROM users u LEFT JOIN bots b ON b.user_id = u.id AND b.deleted_at IS NULL
			LEFT JOIN files pf ON pf.id = u.photo_file_id
		WHERE u.tenant_id = $1 AND u.id = ANY($2)`,
		tenantID, ids)
	if err != nil {
		return nil, fmt.Errorf("chat: load users: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		u := &userRow{}
		if err := rows.Scan(&u.ID, &u.Username, &u.Name, &u.Bio, &u.Email, &u.LastSeen, &u.IsBot, &u.Deleted, &u.InlinePlaceholder, &u.PhotoID); err != nil {
			return nil, fmt.Errorf("chat: load users: %w", err)
		}
		out[u.ID] = u
	}
	return out, rows.Err()
}

func (u *userRow) render(viewer int64, blocked bool) *appv1.User {
	if u.Deleted && u.ID != viewer {
		return &appv1.User{Id: u.ID, Deleted: true, IsBlocked: blocked, IsBot: u.IsBot}
	}
	out := &appv1.User{Id: u.ID, Username: u.Username, Name: u.Name, Bio: u.Bio, IsSelf: u.ID == viewer, IsBlocked: blocked,
		IsBot: u.IsBot, BotInlinePlaceholder: u.InlinePlaceholder}
	if u.PhotoID != "" && (u.IsBot || u.ID == viewer || u.photoSeenBy[viewer]) {
		out.Photo = media.PhotoRef(u.PhotoID)
	}
	if u.ID == viewer {
		out.Email = u.Email
	}
	return out
}

type blockKey struct{ blocker, blocked int64 }

// loadBlocks returns which of viewers blocked which of users.
func loadBlocks(ctx context.Context, q querier, viewers, users []int64) (map[blockKey]bool, error) {
	out := map[blockKey]bool{}
	if len(viewers) == 0 || len(users) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT blocker_id, blocked_id FROM blocks WHERE blocker_id = ANY($1) AND blocked_id = ANY($2)`,
		viewers, users)
	if err != nil {
		return nil, fmt.Errorf("chat: load blocks: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var k blockKey
		if err := rows.Scan(&k.blocker, &k.blocked); err != nil {
			return nil, fmt.Errorf("chat: load blocks: %w", err)
		}
		out[k] = true
	}
	return out, rows.Err()
}

// --------------------------------------------------------------- messages

type msgKey struct{ chatID, seq int64 }

type messageRow struct {
	ChatID      int64
	Seq         int64
	TopicID     int64
	FromID      int64
	RandomID    int64
	Date        time.Time
	Text        string
	Content     []byte
	ReplyToSeq  int64
	GroupedID   int64
	EditVersion int32
	EditDate    *time.Time
	// ChangedAt: the content last changed after posting (nil when never).
	ChangedAt *time.Time
	Deleted   bool
}

const messageColumns = `m.chat_id, m.seq, m.topic_id, m.from_id, m.random_id, m.date, m.text, m.content, m.reply_to_seq,
	m.grouped_id, m.edit_version, m.edit_date, m.changed_at, m.deleted_at IS NOT NULL`

func scanMessage(row pgx.Row) (*messageRow, error) {
	m := &messageRow{}
	err := row.Scan(&m.ChatID, &m.Seq, &m.TopicID, &m.FromID, &m.RandomID, &m.Date, &m.Text, &m.Content, &m.ReplyToSeq,
		&m.GroupedID, &m.EditVersion, &m.EditDate, &m.ChangedAt, &m.Deleted)
	return m, err
}

// flattenKeys turns chat -> seqs into the parallel arrays the batched
// lookups unnest; each pair is one primary key probe (with run-time
// partition pruning for messages).
func flattenKeys(keys map[int64][]int64) (chats, seqs []int64) {
	for chatID, list := range keys {
		for _, seq := range list {
			chats = append(chats, chatID)
			seqs = append(seqs, seq)
		}
	}
	return chats, seqs
}

// loadMessages loads messages by key in one query.
func loadMessages(ctx context.Context, q querier, keys map[int64][]int64) (map[msgKey]*messageRow, error) {
	out := map[msgKey]*messageRow{}
	chats, seqs := flattenKeys(keys)
	if len(chats) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT `+messageColumns+` FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
		JOIN messages m ON m.chat_id = x.chat_id AND m.seq = x.seq`, chats, seqs)
	if err != nil {
		return nil, fmt.Errorf("chat: load messages: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, fmt.Errorf("chat: load messages: %w", err)
		}
		out[msgKey{m.ChatID, m.Seq}] = m
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: load messages: %w", err)
	}
	return out, nil
}

// recentReactorsMax is how many recent reactors a reaction chip carries.
const recentReactorsMax = 3

// reactionsOf holds the reactions of a set of messages: counts per emoji
// with their most recent reactors, and the emoji each viewer chose.
type reactionsOf struct {
	counts map[msgKey][]*appv1.ReactionCount
	mine   map[memberKey]map[int64]string // (chat, viewer) -> seq -> emoji
	// reactorsHidden: (channel, viewer) pairs where the viewer is not an
	// admin, so who reacted stays private.
	reactorsHidden map[memberKey]bool
}

func loadReactions(ctx context.Context, q querier, keys map[int64][]int64, viewers []int64) (*reactionsOf, error) {
	r := &reactionsOf{counts: map[msgKey][]*appv1.ReactionCount{}, mine: map[memberKey]map[int64]string{},
		reactorsHidden: map[memberKey]bool{}}
	chats, seqs := flattenKeys(keys)
	if len(chats) == 0 {
		return r, nil
	}
	rows, err := q.Query(ctx, `
		SELECT r.chat_id, r.seq, r.emoji, count(*), min(r.created_at),
			(array_agg(r.user_id ORDER BY r.created_at DESC, r.user_id DESC))[1:$3]
		FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
		JOIN message_reactions r ON r.chat_id = x.chat_id AND r.seq = x.seq
		GROUP BY r.chat_id, r.seq, r.emoji`, chats, seqs, recentReactorsMax)
	if err != nil {
		return nil, fmt.Errorf("chat: load reactions: %w", err)
	}
	type agg struct {
		emoji  string
		n      int32
		first  time.Time
		recent []int64
	}
	byMsg := map[msgKey][]agg{}
	for rows.Next() {
		var k msgKey
		var a agg
		if err := rows.Scan(&k.chatID, &k.seq, &a.emoji, &a.n, &a.first, &a.recent); err != nil {
			rows.Close()
			return nil, fmt.Errorf("chat: load reactions: %w", err)
		}
		byMsg[k] = append(byMsg[k], a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: load reactions: %w", err)
	}
	for k, list := range byMsg {
		// Most used first; ties keep the order they were first used.
		slices.SortFunc(list, func(a, b agg) int {
			return cmp.Or(cmp.Compare(b.n, a.n), a.first.Compare(b.first), cmp.Compare(a.emoji, b.emoji))
		})
		for _, a := range list {
			r.counts[k] = append(r.counts[k], &appv1.ReactionCount{Emoji: a.emoji, Count: a.n, RecentUserIds: a.recent})
		}
	}
	if len(byMsg) == 0 || len(viewers) == 0 {
		return r, nil
	}
	if r.reactorsHidden, err = loadReactorsHidden(ctx, q, sortedKeys(boolSet(keys)), viewers); err != nil {
		return nil, err
	}
	rows, err = q.Query(ctx, `
		SELECT r.chat_id, r.seq, r.user_id, r.emoji FROM unnest($1::bigint[], $2::bigint[]) AS x(chat_id, seq)
		JOIN message_reactions r ON r.chat_id = x.chat_id AND r.seq = x.seq
		WHERE r.user_id = ANY($3)`, chats, seqs, viewers)
	if err != nil {
		return nil, fmt.Errorf("chat: load own reactions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var chatID, seq, user int64
		var emoji string
		if err := rows.Scan(&chatID, &seq, &user, &emoji); err != nil {
			return nil, fmt.Errorf("chat: load own reactions: %w", err)
		}
		k := memberKey{chatID, user}
		if r.mine[k] == nil {
			r.mine[k] = map[int64]string{}
		}
		r.mine[k][seq] = emoji
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: load own reactions: %w", err)
	}
	return r, nil
}

// loadReactorsHidden returns the (chat, viewer) pairs among chatIDs and
// viewers where the chat is a channel and the viewer not one of its current
// admins: there the viewer may not learn who reacted.
func loadReactorsHidden(ctx context.Context, q querier, chatIDs, viewers []int64) (map[memberKey]bool, error) {
	rows, err := q.Query(ctx, `
		SELECT c.id, v.user_id FROM chats c CROSS JOIN unnest($2::bigint[]) AS v(user_id)
		WHERE c.id = ANY($1) AND c.type = 'channel' AND NOT EXISTS (
			SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = v.user_id AND m.left_at IS NULL
				AND m.role IN ('admin', 'owner'))`, chatIDs, viewers)
	if err != nil {
		return nil, fmt.Errorf("chat: reactor visibility: %w", err)
	}
	defer rows.Close()
	out := map[memberKey]bool{}
	for rows.Next() {
		var k memberKey
		if err := rows.Scan(&k.chatID, &k.userID); err != nil {
			return nil, fmt.Errorf("chat: reactor visibility: %w", err)
		}
		out[k] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: reactor visibility: %w", err)
	}
	return out, nil
}

// forViewer returns the reactions of a message with chosen set for viewer,
// and the recent reactors only where viewer may see who reacted.
func (r *reactionsOf) forViewer(k msgKey, viewer int64) []*appv1.ReactionCount {
	list := r.counts[k]
	if len(list) == 0 {
		return nil
	}
	mine := r.mine[memberKey{k.chatID, viewer}][k.seq]
	hidden := r.reactorsHidden[memberKey{k.chatID, viewer}]
	out := make([]*appv1.ReactionCount, len(list))
	for i, c := range list {
		out[i] = &appv1.ReactionCount{Emoji: c.Emoji, Count: c.Count, Chosen: c.Emoji == mine}
		if !hidden {
			out[i].RecentUserIds = c.RecentUserIds
		}
	}
	return out
}

// recentReactors lists the recent reactors carried by reactions.
func recentReactors(reactions []*appv1.ReactionCount) []int64 {
	var ids []int64
	for _, c := range reactions {
		ids = append(ids, c.GetRecentUserIds()...)
	}
	return ids
}

type hiddenKey struct {
	user int64
	msg  msgKey
}

func loadHidden(ctx context.Context, q querier, viewers []int64, keys map[int64][]int64) (map[hiddenKey]bool, error) {
	out := map[hiddenKey]bool{}
	chats, seqs := flattenKeys(keys)
	if len(viewers) == 0 || len(chats) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT h.user_id, h.chat_id, h.seq FROM unnest($2::bigint[], $3::bigint[]) AS x(chat_id, seq)
		JOIN user_hidden_messages h ON h.chat_id = x.chat_id AND h.seq = x.seq
		WHERE h.user_id = ANY($1)`, viewers, chats, seqs)
	if err != nil {
		return nil, fmt.Errorf("chat: load hidden: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var user int64
		var k msgKey
		if err := rows.Scan(&user, &k.chatID, &k.seq); err != nil {
			return nil, fmt.Errorf("chat: load hidden: %w", err)
		}
		out[hiddenKey{user, k}] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: load hidden: %w", err)
	}
	return out, nil
}

// render returns the message as viewer sees it; a message deleted for
// everyone becomes its recalled placeholder, with no content.
func (m *messageRow) render(viewer int64, reactions []*appv1.ReactionCount) (*appv1.Message, error) {
	if m.Deleted {
		out := &appv1.Message{ChatId: m.ChatID, Seq: m.Seq, FromId: m.FromID, Date: m.Date.Unix(), TopicId: m.TopicID,
			EditVersion: m.EditVersion, Recalled: true}
		if viewer == m.FromID {
			out.RandomId = m.RandomID
		}
		return out, nil
	}
	out := &appv1.Message{}
	if len(m.Content) > 0 {
		if err := proto.Unmarshal(m.Content, out); err != nil {
			return nil, fmt.Errorf("chat: decode message %d/%d: %w", m.ChatID, m.Seq, err)
		}
	}
	out.ChatId, out.Seq, out.FromId, out.Date = m.ChatID, m.Seq, m.FromID, m.Date.Unix()
	out.Text, out.ReplyToSeq, out.GroupedId, out.TopicId = m.Text, m.ReplyToSeq, m.GroupedID, m.TopicID
	out.EditVersion = m.EditVersion
	if m.EditDate != nil {
		out.EditDate = m.EditDate.Unix()
	}
	if viewer == m.FromID {
		out.RandomId = m.RandomID
	}
	out.Reactions = reactions
	return out, nil
}

// referencedUsers lists the users a message mentions in any way, its recent
// reactors included.
func referencedUsers(m *appv1.Message) []int64 {
	ids := append([]int64{m.GetFromId()}, recentReactors(m.GetReactions())...)
	if f := m.GetForwardFrom(); f != nil {
		ids = append(ids, f.GetFromUserId())
	}
	ids = append(ids, m.GetViaBotId())
	for _, e := range m.GetEntities() {
		ids = append(ids, e.GetUserId())
	}
	switch a := m.GetAction().GetKind().(type) {
	case *appv1.MessageAction_MembersAdded:
		ids = append(ids, a.MembersAdded.GetUserIds()...)
	case *appv1.MessageAction_MemberRemoved:
		ids = append(ids, a.MemberRemoved.GetUserId(), a.MemberRemoved.GetBy())
	default:
	}
	return ids
}

// ------------------------------------------------------------ batch render

// entitySet collects users and chats to attach for each viewer.
type entitySet struct {
	users map[int64]map[int64]bool
	chats map[int64]map[int64]bool
}

func newEntitySet() *entitySet {
	return &entitySet{users: map[int64]map[int64]bool{}, chats: map[int64]map[int64]bool{}}
}

func (e *entitySet) addUsers(viewer int64, ids ...int64) {
	for _, id := range ids {
		if id == 0 {
			continue
		}
		if e.users[viewer] == nil {
			e.users[viewer] = map[int64]bool{}
		}
		e.users[viewer][id] = true
	}
}

func (e *entitySet) addChats(viewer int64, ids ...int64) {
	for _, id := range ids {
		if id == 0 {
			continue
		}
		if e.chats[viewer] == nil {
			e.chats[viewer] = map[int64]bool{}
		}
		e.chats[viewer][id] = true
	}
}

// renderedEntities holds users and chats rendered per viewer.
type renderedEntities struct {
	users map[int64][]*appv1.User
	chats map[int64][]*appv1.Chat
}

// render loads every referenced user and chat once and renders them for
// each viewer. A private chat comes with its peer: the client names and
// shows the chat by that user, and has no other way to learn who it is.
func (e *entitySet) render(ctx context.Context, q querier, tenantID string) (*renderedEntities, error) {
	var chatIDs []int64
	seenC := map[int64]bool{}
	for _, set := range e.chats {
		for id := range set {
			if !seenC[id] {
				seenC[id] = true
				chatIDs = append(chatIDs, id)
			}
		}
	}
	chats, err := loadChats(ctx, q, tenantID, chatIDs)
	if err != nil {
		return nil, err
	}
	for v, set := range e.chats {
		for id := range set {
			if c, ok := chats[id]; ok && c.Type == typePrivate {
				e.addUsers(v, c.peerOf(v))
			}
		}
	}
	var viewers, userIDs []int64
	seenV, seenU := map[int64]bool{}, map[int64]bool{}
	for v, set := range e.users {
		if !seenV[v] {
			seenV[v] = true
			viewers = append(viewers, v)
		}
		for id := range set {
			if !seenU[id] {
				seenU[id] = true
				userIDs = append(userIDs, id)
			}
		}
	}
	for v := range e.chats {
		if !seenV[v] {
			seenV[v] = true
			viewers = append(viewers, v)
		}
	}
	users, err := loadUsers(ctx, q, tenantID, userIDs)
	if err != nil {
		return nil, err
	}
	blocks, err := loadBlocks(ctx, q, viewers, userIDs)
	if err != nil {
		return nil, err
	}
	members, err := loadMembers(ctx, q, chatIDs, viewers)
	if err != nil {
		return nil, err
	}
	wanted := map[int64][]int64{}
	for v, set := range e.users {
		for id := range set {
			wanted[v] = append(wanted[v], id)
		}
	}
	if err := seePhotos(ctx, q, users, wanted); err != nil {
		return nil, err
	}
	out := &renderedEntities{users: map[int64][]*appv1.User{}, chats: map[int64][]*appv1.Chat{}}
	for v, set := range e.users {
		for _, id := range sortedKeys(set) {
			if u, ok := users[id]; ok {
				out.users[v] = append(out.users[v], u.render(v, blocks[blockKey{v, id}]))
			}
		}
	}
	for v, set := range e.chats {
		for _, id := range sortedKeys(set) {
			if c, ok := chats[id]; ok {
				out.chats[v] = append(out.chats[v], c.render(v, members[memberKey{id, v}]))
			}
		}
	}
	return out, nil
}

func sortedKeys(set map[int64]bool) []int64 {
	out := make([]int64, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	slices.Sort(out)
	return out
}

// renderFrames renders log updates for their viewers: messages come from
// the messages table as each viewer sees them now, and only what the
// viewer's membership allows (history visibility; for a former member
// nothing newer than when they left, nor changed since). An update about a
// message the viewer may not see, or that is deleted or hidden, loses its
// body but keeps its position; updates of a chat the viewer was never in
// are emptied. Chats and users referenced are attached. With chatLog (a
// large chat's own log) only current members get a frame. jobs' updates
// are edited in place.
func (s *Service) renderFrames(ctx context.Context, q querier, viewers []int64, jobs map[int64][]*appv1.Update, chatLog bool) (map[int64]*appv1.UpdateFrame, error) {
	keys := map[int64][]int64{}
	chatSet := map[int64]bool{}
	addKey := func(chatID, seq int64) {
		if chatID != 0 && seq != 0 && !slices.Contains(keys[chatID], seq) {
			keys[chatID] = append(keys[chatID], seq)
		}
	}
	for _, list := range jobs {
		for _, u := range list {
			if chatID := updateChatID(u); chatID != 0 {
				chatSet[chatID] = true
			}
			switch k := u.Kind.(type) {
			case *appv1.Update_MessageNew:
				addKey(k.MessageNew.GetMessage().GetChatId(), k.MessageNew.GetMessage().GetSeq())
			case *appv1.Update_MessageEdit:
				addKey(k.MessageEdit.GetMessage().GetChatId(), k.MessageEdit.GetMessage().GetSeq())
			case *appv1.Update_Reaction:
				addKey(k.Reaction.GetChatId(), k.Reaction.GetSeq())
			default:
			}
		}
	}
	members, err := loadMembers(ctx, q, sortedKeys(chatSet), viewers)
	if err != nil {
		return nil, err
	}
	msgs, err := loadMessages(ctx, q, keys)
	if err != nil {
		return nil, err
	}
	reactions, err := loadReactions(ctx, q, keys, viewers)
	if err != nil {
		return nil, err
	}
	hidden, err := loadHidden(ctx, q, viewers, keys)
	if err != nil {
		return nil, err
	}
	// visible returns the message when viewer (membership m) may see it.
	visible := func(viewer int64, m *memberRow, chatID, seq int64) *messageRow {
		k := msgKey{chatID, seq}
		msg, ok := msgs[k]
		if !ok || msg.Deleted || hidden[hiddenKey{viewer, k}] || !m.sees(msg) {
			return nil
		}
		return msg
	}
	ents := newEntitySet()
	var served []int64
	for _, viewer := range viewers {
		if chatLog && !activeInAll(members, viewer, jobs[viewer]) {
			continue
		}
		served = append(served, viewer)
		for _, u := range jobs[viewer] {
			chatID := updateChatID(u)
			if _, ok := u.Kind.(*appv1.Update_ChatDeleted); ok {
				// Carries only the id of a chat the viewer was in; a chat
				// deleted for everyone has no member rows left.
				continue
			}
			var m *memberRow
			if chatID != 0 {
				if m = members[memberKey{chatID, viewer}]; m == nil {
					u.Kind = nil
					continue
				}
				ents.addChats(viewer, chatID)
			}
			switch k := u.Kind.(type) {
			case *appv1.Update_MessageNew:
				msg := visible(viewer, m, chatID, k.MessageNew.GetMessage().GetSeq())
				if msg == nil {
					u.Kind = nil
					continue
				}
				rendered, err := msg.render(viewer, reactions.forViewer(msgKey{chatID, msg.Seq}, viewer))
				if err != nil {
					return nil, err
				}
				k.MessageNew.Message = rendered
				ents.addUsers(viewer, referencedUsers(rendered)...)
			case *appv1.Update_MessageEdit:
				msg := visible(viewer, m, chatID, k.MessageEdit.GetMessage().GetSeq())
				if msg == nil {
					u.Kind = nil
					continue
				}
				rendered, err := msg.render(viewer, reactions.forViewer(msgKey{chatID, msg.Seq}, viewer))
				if err != nil {
					return nil, err
				}
				k.MessageEdit.Message = rendered
				ents.addUsers(viewer, referencedUsers(rendered)...)
			case *appv1.Update_Reaction:
				// Reaction counts are current: a former member gets none.
				if m.Left || visible(viewer, m, chatID, k.Reaction.GetSeq()) == nil {
					u.Kind = nil
					continue
				}
				k.Reaction.Reactions = reactions.forViewer(msgKey{chatID, k.Reaction.GetSeq()}, viewer)
				ents.addUsers(viewer, recentReactors(k.Reaction.GetReactions())...)
			case *appv1.Update_MemberAdded:
				ents.addUsers(viewer, k.MemberAdded.GetUserIds()...)
				ents.addUsers(viewer, k.MemberAdded.GetInviterId())
			case *appv1.Update_MemberRemoved:
				ents.addUsers(viewer, k.MemberRemoved.GetUserId(), k.MemberRemoved.GetActorId())
			case *appv1.Update_MemberPermissions:
				ents.addUsers(viewer, k.MemberPermissions.GetUserId())
			default:
			}
		}
	}
	rendered, err := ents.render(ctx, q, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	frames := make(map[int64]*appv1.UpdateFrame, len(served))
	for _, viewer := range served {
		chats := rendered.chats[viewer]
		// chat_updated carries the chat as the viewer sees it now.
		for _, u := range jobs[viewer] {
			if k, ok := u.Kind.(*appv1.Update_ChatUpdated); ok {
				for _, c := range chats {
					if c.GetId() == k.ChatUpdated.GetChat().GetId() {
						k.ChatUpdated.Chat = c
					}
				}
			}
		}
		frames[viewer] = &appv1.UpdateFrame{Updates: jobs[viewer], Users: rendered.users[viewer], Chats: chats}
	}
	return frames, nil
}

// activeInAll reports whether viewer is a current member of every chat its
// updates are about.
func activeInAll(members map[memberKey]*memberRow, viewer int64, updates []*appv1.Update) bool {
	for _, u := range updates {
		if chatID := updateChatID(u); chatID != 0 && !members[memberKey{chatID, viewer}].active() {
			return false
		}
	}
	return true
}

// renderMessages renders history rows for one viewer, with their users.
func (s *Service) renderMessages(ctx context.Context, q querier, viewer int64, rows []*messageRow) ([]*appv1.Message, []*appv1.User, error) {
	keys := map[int64][]int64{}
	for _, m := range rows {
		keys[m.ChatID] = append(keys[m.ChatID], m.Seq)
	}
	reactions, err := loadReactions(ctx, q, keys, []int64{viewer})
	if err != nil {
		return nil, nil, err
	}
	ents := newEntitySet()
	out := make([]*appv1.Message, 0, len(rows))
	for _, m := range rows {
		msg, err := m.render(viewer, reactions.forViewer(msgKey{m.ChatID, m.Seq}, viewer))
		if err != nil {
			return nil, nil, err
		}
		out = append(out, msg)
		ents.addUsers(viewer, referencedUsers(msg)...)
	}
	rendered, err := ents.render(ctx, q, s.cfg.TenantID)
	if err != nil {
		return nil, nil, err
	}
	return out, rendered.users[viewer], nil
}

// errNoRows tells helpers apart from database failures.
func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

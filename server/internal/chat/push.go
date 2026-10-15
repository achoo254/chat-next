package chat

import (
	"context"
	"fmt"
	"time"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
)

// pushTextMax bounds the message text a notification carries, in runes
// (the same cut the in-app notification makes).
const pushTextMax = 140

// PushMessage is a new message as the push consumer notifies it: one per
// message_new outbox row (an album row is its last message).
// Who receives it, and with what text, is the consumer's business.
type PushMessage struct {
	OutboxID int64
	At       time.Time
	ChatID   int64
	// ChatType is "private", "group" or "channel".
	ChatType string
	// ChatTitle is empty for private chats.
	ChatTitle string
	// SenderID is 0 for an incoming webhook's message.
	SenderID int64
	// SenderName is the sender's display name, or the webhook's label.
	SenderName string
	Seq        int64
	// Text is the message text cut to pushTextMax runes ("…" appended).
	Text string
	// MediaKind and FileName describe the media of a message without text.
	MediaKind appv1.MediaKind
	FileName  string
}

// PushMessages returns the new messages among rows that may notify
// people: rows of kind message_new whose messages are not service
// messages, recalled or marked silent, in chats that still exist. Rows of
// other kinds are ignored.
func (s *Service) PushMessages(ctx context.Context, rows []OutboxRow) ([]PushMessage, error) {
	type logKey struct{ id, pos int64 }
	var users, pts, chats, chatPts []int64
	userRow := map[logKey]int{}
	chatRow := map[logKey]int{}
	for i, r := range rows {
		if r.Kind != kindMessageNew || r.ChatID == 0 {
			continue
		}
		if len(r.ChatPts) > 0 {
			for _, p := range r.ChatPts {
				chats, chatPts = append(chats, r.ChatID), append(chatPts, p)
				chatRow[logKey{r.ChatID, p}] = i
			}
			continue
		}
		// Every member's log holds the same messages; read one log,
		// preferring a recipient's over the sender's.
		pick := -1
		for j, u := range r.UserIDs {
			if j >= len(r.Pts) {
				break
			}
			if pick < 0 || u != r.ActorID {
				pick = j
			}
			if u != r.ActorID {
				break
			}
		}
		if pick >= 0 {
			users, pts = append(users, r.UserIDs[pick]), append(pts, r.Pts[pick])
			userRow[logKey{r.UserIDs[pick], r.Pts[pick]}] = i
		}
	}
	// Log entries name the messages (chat, seq); the messages table has
	// their content.
	refs := map[int][]int64{}
	collect := func(row int, u *appv1.Update) {
		if m := u.GetMessageNew().GetMessage(); m != nil {
			refs[row] = append(refs[row], m.GetSeq())
		}
	}
	if err := readUserLog(ctx, s.pool, users, pts, func(user, pos int64, u *appv1.Update) {
		collect(userRow[logKey{user, pos}], u)
	}); err != nil {
		return nil, err
	}
	if err := readChatLog(ctx, s.pool, chats, chatPts, func(chatID, pos int64, u *appv1.Update) {
		collect(chatRow[logKey{chatID, pos}], u)
	}); err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return nil, nil
	}
	keys := map[int64][]int64{}
	for row, seqs := range refs {
		keys[rows[row].ChatID] = append(keys[rows[row].ChatID], seqs...)
	}
	loaded, err := loadMessages(ctx, s.pool, keys)
	if err != nil {
		return nil, err
	}
	found := map[int][]*appv1.Message{}
	for row, seqs := range refs {
		for _, seq := range seqs {
			m, ok := loaded[msgKey{rows[row].ChatID, seq}]
			if !ok {
				continue
			}
			msg, err := m.render(0, nil)
			if err != nil {
				return nil, err
			}
			found[row] = append(found[row], msg)
		}
	}

	var chatIDs, senderIDs []int64
	for row, msgs := range found {
		chatIDs = append(chatIDs, rows[row].ChatID)
		for _, m := range msgs {
			senderIDs = append(senderIDs, m.GetFromId())
		}
	}
	type chatInfo struct{ typ, title string }
	info := map[int64]chatInfo{}
	chatRows, err := s.pool.Query(ctx, `
		SELECT id, type, title FROM chats
		WHERE id = ANY($1) AND tenant_id = $2 AND deleted_at IS NULL AND type IN ('private', 'group', 'channel')`,
		uniqueSorted(chatIDs), s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: push chats: %w", err)
	}
	for chatRows.Next() {
		var id int64
		var c chatInfo
		if err := chatRows.Scan(&id, &c.typ, &c.title); err != nil {
			chatRows.Close()
			return nil, fmt.Errorf("chat: push chats: %w", err)
		}
		info[id] = c
	}
	chatRows.Close()
	if err := chatRows.Err(); err != nil {
		return nil, fmt.Errorf("chat: push chats: %w", err)
	}
	names := map[int64]string{}
	if ids := uniqueSorted(senderIDs); len(ids) > 0 {
		nameRows, err := s.pool.Query(ctx, `SELECT id, name FROM users WHERE id = ANY($1)`, ids)
		if err != nil {
			return nil, fmt.Errorf("chat: push senders: %w", err)
		}
		for nameRows.Next() {
			var id int64
			var name string
			if err := nameRows.Scan(&id, &name); err != nil {
				nameRows.Close()
				return nil, fmt.Errorf("chat: push senders: %w", err)
			}
			names[id] = name
		}
		nameRows.Close()
		if err := nameRows.Err(); err != nil {
			return nil, fmt.Errorf("chat: push senders: %w", err)
		}
	}

	var out []PushMessage
	for i, r := range rows {
		c, ok := info[r.ChatID]
		if !ok {
			continue
		}
		var last *appv1.Message
		for _, m := range found[i] {
			if m.GetAction() != nil || m.GetRecalled() || m.GetSilent() {
				continue
			}
			if last == nil || m.GetSeq() > last.GetSeq() {
				last = m
			}
		}
		if last == nil {
			continue
		}
		p := PushMessage{
			OutboxID: r.ID, At: r.CreatedAt, ChatID: r.ChatID, ChatType: c.typ, ChatTitle: c.title,
			SenderID: last.GetFromId(), SenderName: names[last.GetFromId()], Seq: last.GetSeq(),
			Text: cutRunes(last.GetText(), pushTextMax), MediaKind: last.GetMedia().GetKind(), FileName: last.GetMedia().GetFileName(),
		}
		if label := last.GetIntegrationLabel(); label != "" {
			p.SenderName = label
		}
		if c.typ == "private" {
			p.ChatTitle = ""
		}
		out = append(out, p)
	}
	return out, nil
}

// cutRunes cuts s to at most n runes, marking a cut with "…".
func cutRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i, count := 0, 0
	for i = range s {
		if count == n {
			break
		}
		count++
	}
	return s[:i] + "…"
}

// PushTarget is a browser push subscription that should be notified of a
// message, with what the user's settings allow it to show.
type PushTarget struct {
	SubscriptionID int64
	UserID         int64
	Endpoint       string
	P256DH, Auth   []byte
	Locale         string
	// Preview: the user shows message content for this chat type ("Hiện
	// nội dung tin"); otherwise only a generic text.
	Preview bool
	// Silent: the user's sound setting is not the default one.
	Silent bool
}

// PushTargets returns the push subscriptions to notify of m: those of the
// chat's current members other than the sender, on sessions that are still
// usable (not revoked, idle less than idleTimeout, younger than maxAge),
// whose owner has not muted the chat, has notifications on for its chat
// type and has not blocked the sender. Whether the owner is using the app
// right now is the caller's check.
func (s *Service) PushTargets(ctx context.Context, m PushMessage, idleTimeout, maxAge time.Duration, now time.Time) ([]PushTarget, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth, ps.locale,
			ns.private_enabled, ns.private_preview, ns.groups_enabled, ns.groups_preview,
			ns.channels_enabled, ns.channels_preview, ns.sound
		FROM push_subscriptions ps
		JOIN user_sessions s ON s.id = ps.session_id
		JOIN chat_members m ON m.chat_id = $1 AND m.user_id = ps.user_id AND m.left_at IS NULL
		LEFT JOIN notification_settings ns ON ns.user_id = ps.user_id
		WHERE ps.tenant_id = $2 AND ps.user_id <> $3 AND m.mute_until <= $4
			AND s.revoked_at IS NULL AND s.last_seen_at > $5 AND s.created_at > $6
			AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = ps.user_id AND b.blocked_id = $3)
		ORDER BY ps.id`,
		m.ChatID, s.cfg.TenantID, m.SenderID, now.Unix(), now.Add(-idleTimeout), now.Add(-maxAge))
	if err != nil {
		return nil, fmt.Errorf("chat: push targets: %w", err)
	}
	defer rows.Close()
	var out []PushTarget
	for rows.Next() {
		var t PushTarget
		var privateOn, privatePreview, groupsOn, groupsPreview, channelsOn, channelsPreview *bool
		var sound *int16
		if err := rows.Scan(&t.SubscriptionID, &t.UserID, &t.Endpoint, &t.P256DH, &t.Auth, &t.Locale,
			&privateOn, &privatePreview, &groupsOn, &groupsPreview, &channelsOn, &channelsPreview, &sound); err != nil {
			return nil, fmt.Errorf("chat: push targets: %w", err)
		}
		n := defaultNotifySettings()
		if privateOn != nil {
			// A row exists: every column is set.
			n = notifySettingsRow{
				PrivateEnabled: *privateOn, PrivatePreview: deref(privatePreview), GroupsEnabled: deref(groupsOn),
				GroupsPreview: deref(groupsPreview), ChannelsEnabled: deref(channelsOn), ChannelsPreview: deref(channelsPreview),
				Sound: deref(sound),
			}
		}
		var enabled bool
		switch m.ChatType {
		case "group":
			enabled, t.Preview = n.GroupsEnabled, n.GroupsPreview
		case "channel":
			enabled, t.Preview = n.ChannelsEnabled, n.ChannelsPreview
		default:
			enabled, t.Preview = n.PrivateEnabled, n.PrivatePreview
		}
		if !enabled {
			continue
		}
		t.Silent = n.Sound != int16(appv1.NotificationSound_NOTIFICATION_SOUND_DEFAULT)
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: push targets: %w", err)
	}
	return out, nil
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

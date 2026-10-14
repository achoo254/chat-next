package chat

import (
	"context"
	"fmt"
	"time"
)

// Online counts of groups (GetChatOnlineCount): computed from the gateway's
// presence and the members' last-seen privacy, cached briefly per chat and
// viewer so a big group's header does not query on every open.
const (
	onlineCountMax   = 10000
	onlineCountTTL   = 30 * time.Second
	onlineCacheLimit = 10000
)

type onlineKey struct{ chatID, viewer int64 }

type onlineEntry struct {
	n  int32
	at time.Time
}

// GetChatOnlineCount returns how many members of a group (or, for its
// admins, a channel) are online now, among those whose last-seen privacy
// lets me see them online; counting stops at onlineCountMax.
func (s *Service) GetChatOnlineCount(ctx context.Context, me, chatID int64) (int32, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return 0, err
	}
	switch c.Type {
	case typeGroup:
	case typeChannel:
		if !m.isAdmin() {
			return 0, errDenied("only admins see who is online in a channel")
		}
	default:
		return 0, errInvalid("online counts are for groups and channels")
	}
	key := onlineKey{chatID: c.ID, viewer: me}
	now := time.Now()
	s.onlineMu.Lock()
	cached, ok := s.onlineCounts[key]
	s.onlineMu.Unlock()
	if ok && now.Sub(cached.at) < onlineCountTTL {
		return cached.n, nil
	}
	_, presence := s.realtime()
	var online []int64
	if presence != nil {
		online = presence.OnlineUsers()
	}
	n := int32(0)
	if len(online) > 0 {
		// A member counts when the viewer may see them online (statusOf):
		// the viewer themselves, or last seen shared with everyone, or with
		// contacts and the viewer is in their list; never someone who
		// blocked the viewer.
		if err := s.pool.QueryRow(ctx, `
			SELECT count(*) FROM (
				SELECT 1 FROM chat_members m LEFT JOIN privacy_settings p ON p.user_id = m.user_id
				WHERE m.chat_id = $1 AND m.left_at IS NULL AND m.user_id = ANY($2)
					AND (m.user_id = $3 OR (
						NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = m.user_id AND b.blocked_id = $3)
						AND (coalesce(p.last_seen, $5) = $6
							OR (coalesce(p.last_seen, $5) = $7
								AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.owner_id = m.user_id AND ct.contact_id = $3)))))
				LIMIT $4) x`,
			c.ID, online, me, onlineCountMax, defaultPrivacy().LastSeen, audEveryone, audContacts).Scan(&n); err != nil {
			return 0, fmt.Errorf("chat: online count: %w", err)
		}
	}
	s.onlineMu.Lock()
	if len(s.onlineCounts) >= onlineCacheLimit {
		for k, e := range s.onlineCounts {
			if now.Sub(e.at) >= onlineCountTTL {
				delete(s.onlineCounts, k)
			}
		}
		if len(s.onlineCounts) >= onlineCacheLimit {
			clear(s.onlineCounts)
		}
	}
	s.onlineCounts[key] = onlineEntry{n: n, at: now}
	s.onlineMu.Unlock()
	return n, nil
}

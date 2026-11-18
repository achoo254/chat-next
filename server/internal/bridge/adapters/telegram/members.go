package telegram

import (
	"context"
	"fmt"
	"strconv"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var (
	_ bridge.MemberReader = (*Adapter)(nil)
	_ bridge.MemberWriter = (*Adapter)(nil)
)

const (
	memberPage     = 200 // Telegram's page of participants
	memberPagesMax = 5   // a group of more than this many people is listed in part
)

// rememberUsers keeps the access hash of the people seen in a group: removing one or
// making one an admin needs it, and a member is not always in the dialog list.
func (c *conn) rememberUsers(users []tg.UserClass) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hashes == nil {
		c.hashes = map[int64]int64{}
	}
	for _, raw := range users {
		if u, ok := raw.(*tg.User); ok {
			c.hashes[u.ID] = u.AccessHash
		}
	}
}

func membersOf(users []tg.UserClass, admins map[int64]bool, ids []int64, self int64) []bridge.Member {
	byID := map[int64]*tg.User{}
	for _, raw := range users {
		if u, ok := raw.(*tg.User); ok {
			byID[u.ID] = u
		}
	}
	var out []bridge.Member
	for _, id := range ids {
		u := byID[id]
		if u == nil || u.Deleted {
			continue
		}
		out = append(out, bridge.Member{Participant: participantUser(u, self), Admin: admins[id]})
	}
	return out
}

// ListMembers implements bridge.MemberReader.
func (a *Adapter) ListMembers(ctx context.Context, acct bridge.Account, conv string) ([]bridge.Member, bool, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, false, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, false, err
	}
	self := c.live.self
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		in := &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash}
		var users []tg.UserClass
		admins := map[int64]bool{}
		restricted := map[int64]bridge.Perms{}
		var ids []int64
		total := 0
		for page := 0; page < memberPagesMax; page++ {
			res, err := c.live.api().ChannelsGetParticipants(ctx, &tg.ChannelsGetParticipantsRequest{
				Channel: in, Filter: &tg.ChannelParticipantsRecent{}, Offset: len(ids), Limit: memberPage})
			if err != nil {
				return nil, false, translate(err)
			}
			list, ok := res.(*tg.ChannelsChannelParticipants)
			if !ok {
				return nil, false, nil // the group does not show its members to this account
			}
			total = list.Count
			users = append(users, list.Users...)
			for _, part := range list.Participants {
				var uid int64
				switch v := part.(type) {
				case *tg.ChannelParticipant:
					uid = v.UserID
				case *tg.ChannelParticipantSelf:
					uid = v.UserID
				case *tg.ChannelParticipantCreator:
					uid, admins[v.UserID] = v.UserID, true
				case *tg.ChannelParticipantAdmin:
					uid, admins[v.UserID] = v.UserID, true
				case *tg.ChannelParticipantBanned:
					peerUser, isUser := v.Peer.(*tg.PeerUser)
					if v.Left || !isUser {
						continue // out of the group, or not a person
					}
					uid = peerUser.UserID
					if p := permsOfBanned(v.BannedRights); p != nil {
						restricted[uid] = *p
					}
				default:
					continue
				}
				ids = append(ids, uid)
			}
			if len(list.Participants) < memberPage {
				break
			}
		}
		c.rememberUsers(users)
		members := membersOf(users, admins, ids, self)
		for i := range members {
			if id, err := strconv.ParseInt(members[i].Participant.ID, 10, 64); err == nil {
				if p, ok := restricted[id]; ok {
					members[i].Perms = &p
				}
			}
		}
		return members, len(ids) >= total, nil
	case *tg.InputPeerChat:
		full, err := c.live.api().MessagesGetFullChat(ctx, p.ChatID)
		if err != nil {
			return nil, false, translate(err)
		}
		cf, ok := full.FullChat.(*tg.ChatFull)
		if !ok {
			return nil, false, nil
		}
		parts, ok := cf.Participants.(*tg.ChatParticipants)
		if !ok {
			return nil, false, nil
		}
		admins := map[int64]bool{}
		var ids []int64
		for _, part := range parts.Participants {
			switch v := part.(type) {
			case *tg.ChatParticipant:
				ids = append(ids, v.UserID)
			case *tg.ChatParticipantCreator:
				ids, admins[v.UserID] = append(ids, v.UserID), true
			case *tg.ChatParticipantAdmin:
				ids, admins[v.UserID] = append(ids, v.UserID), true
			}
		}
		c.rememberUsers(full.Users)
		return membersOf(full.Users, admins, ids, self), true, nil
	}
	return nil, false, nil
}

// inputUser is the user to act on, by the access hash seen when the members were read.
func (c *conn) inputUser(participant string) (*tg.InputUser, error) {
	id, err := strconv.ParseInt(participant, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("telegram: bad member id %q", participant)
	}
	c.mu.Lock()
	hash, known := c.hashes[id]
	c.mu.Unlock()
	if !known {
		return nil, fmt.Errorf("%w: the person %s has not been seen in this group yet", bridge.ErrNotAllowed, participant)
	}
	return &tg.InputUser{UserID: id, AccessHash: hash}, nil
}

// RemoveMember implements bridge.MemberWriter: in a supergroup the person is banned and
// the ban lifted at once (so they can join again), in a basic group they are deleted.
func (a *Adapter) RemoveMember(ctx context.Context, acct bridge.Account, conv, participant string) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	user, err := c.inputUser(participant)
	if err != nil {
		return err
	}
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		in := &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash}
		who := &tg.InputPeerUser{UserID: user.UserID, AccessHash: user.AccessHash}
		if _, err := c.live.api().ChannelsEditBanned(ctx, &tg.ChannelsEditBannedRequest{Channel: in, Participant: who, BannedRights: tg.ChatBannedRights{ViewMessages: true}}); err != nil {
			return translatePin(err)
		}
		_, err := c.live.api().ChannelsEditBanned(ctx, &tg.ChannelsEditBannedRequest{Channel: in, Participant: who, BannedRights: tg.ChatBannedRights{}})
		return translatePin(err)
	case *tg.InputPeerChat:
		_, err := c.live.api().MessagesDeleteChatUser(ctx, &tg.MessagesDeleteChatUserRequest{ChatID: p.ChatID, UserID: user})
		return translatePin(err)
	}
	return fmt.Errorf("%w: %s has no members", bridge.ErrNotAllowed, conv)
}

// adminRights is what an admin made from Chat can do: moderate what is said and who is
// invited and pinned, not change the group or appoint admins.
var adminRights = tg.ChatAdminRights{DeleteMessages: true, InviteUsers: true, PinMessages: true}

// SetMemberAdmin implements bridge.MemberWriter.
func (a *Adapter) SetMemberAdmin(ctx context.Context, acct bridge.Account, conv, participant string, admin bool) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	user, err := c.inputUser(participant)
	if err != nil {
		return err
	}
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		rights := tg.ChatAdminRights{}
		if admin {
			rights = adminRights
		}
		_, err := c.live.api().ChannelsEditAdmin(ctx, &tg.ChannelsEditAdminRequest{
			Channel: &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash}, UserID: user, AdminRights: rights})
		return translatePin(err)
	case *tg.InputPeerChat:
		_, err := c.live.api().MessagesEditChatAdmin(ctx, &tg.MessagesEditChatAdminRequest{ChatID: p.ChatID, UserID: user, IsAdmin: admin})
		return translatePin(err)
	}
	return fmt.Errorf("%w: %s has no members", bridge.ErrNotAllowed, conv)
}

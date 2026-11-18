package telegram

import (
	"context"
	"fmt"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

var (
	_ bridge.MemberAdder    = (*Adapter)(nil)
	_ bridge.PermWriter     = (*Adapter)(nil)
	_ bridge.InviteManager  = (*Adapter)(nil)
	_ bridge.GroupLifecycle = (*Adapter)(nil)
)

// bannedRightsOf is the restriction Telegram applies for the rights Chat gives a member:
// what the member may not do is what is set. FullPerms is no restriction.
func bannedRightsOf(p bridge.Perms) tg.ChatBannedRights {
	return tg.ChatBannedRights{
		SendMessages: !p.Send,
		SendMedia:    !p.Media, SendPhotos: !p.Media, SendVideos: !p.Media, SendRoundvideos: !p.Media, SendAudios: !p.Media,
		SendVoices: !p.Media, SendDocs: !p.Media, SendStickers: !p.Media, SendGifs: !p.Media, SendGames: !p.Media, SendInline: !p.Media,
		SendPolls: !p.Media, EmbedLinks: !p.Media,
		InviteUsers: !p.AddMembers, PinMessages: !p.Pin, ChangeInfo: !p.ChangeInfo, ManageTopics: !p.ManageTopics,
	}
}

// permsOfBanned is the other way: the rights a restricted member has, nil when there is no restriction
// that Chat has a name for.
func permsOfBanned(r tg.ChatBannedRights) *bridge.Perms {
	p := bridge.Perms{
		Send: !r.SendMessages, Media: !r.SendMedia && !r.SendPhotos, AddMembers: !r.InviteUsers,
		Pin: !r.PinMessages, ChangeInfo: !r.ChangeInfo, ManageTopics: !r.ManageTopics,
	}
	if p == bridge.FullPerms {
		return nil
	}
	return &p
}

// AddMember implements bridge.MemberAdder.
func (a *Adapter) AddMember(ctx context.Context, acct bridge.Account, conv, participant string) error {
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
	var res *tg.MessagesInvitedUsers
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		res, err = c.live.api().ChannelsInviteToChannel(ctx, &tg.ChannelsInviteToChannelRequest{
			Channel: &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash}, Users: []tg.InputUserClass{user}})
	case *tg.InputPeerChat:
		res, err = c.live.api().MessagesAddChatUser(ctx, &tg.MessagesAddChatUserRequest{ChatID: p.ChatID, UserID: user, FwdLimit: 50})
	default:
		return fmt.Errorf("%w: %s has no members", bridge.ErrNotAllowed, conv)
	}
	if err != nil {
		return translatePin(err)
	}
	if res != nil && len(res.MissingInvitees) > 0 {
		return fmt.Errorf("%w: the person does not allow being added to groups", bridge.ErrNotAllowed)
	}
	return nil
}

// SetMemberPerms implements bridge.PermWriter: a restriction of one member exists only in
// supergroups and channels.
func (a *Adapter) SetMemberPerms(ctx context.Context, acct bridge.Account, conv, participant string, perms bridge.Perms) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	ch, ok := peer.(*tg.InputPeerChannel)
	if !ok {
		return fmt.Errorf("%w: a basic group has no rights for one member", bridge.ErrNotAllowed)
	}
	user, err := c.inputUser(participant)
	if err != nil {
		return err
	}
	_, err = c.live.api().ChannelsEditBanned(ctx, &tg.ChannelsEditBannedRequest{
		Channel:      &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash},
		Participant:  &tg.InputPeerUser{UserID: user.UserID, AccessHash: user.AccessHash},
		BannedRights: bannedRightsOf(perms)})
	return translatePin(err)
}

func inviteOf(raw tg.ExportedChatInviteClass) (bridge.InviteLink, bool) {
	inv, ok := raw.(*tg.ChatInviteExported)
	if !ok {
		return bridge.InviteLink{}, false
	}
	return bridge.InviteLink{Link: inv.Link, Title: inv.Title, Revoked: inv.Revoked, Usage: inv.Usage}, true
}

// ListInvites implements bridge.InviteManager: the links made by the account, those still
// working and those revoked.
func (a *Adapter) ListInvites(ctx context.Context, acct bridge.Account, conv string) ([]bridge.InviteLink, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return nil, err
	}
	var out []bridge.InviteLink
	for _, revoked := range []bool{false, true} {
		res, err := c.live.api().MessagesGetExportedChatInvites(ctx, &tg.MessagesGetExportedChatInvitesRequest{
			Peer: peer, AdminID: &tg.InputUserSelf{}, Revoked: revoked, Limit: 100})
		if err != nil {
			return nil, translatePin(err)
		}
		for _, raw := range res.Invites {
			if l, ok := inviteOf(raw); ok {
				out = append(out, l)
			}
		}
	}
	return out, nil
}

// CreateInvite implements bridge.InviteManager.
func (a *Adapter) CreateInvite(ctx context.Context, acct bridge.Account, conv, title string) (bridge.InviteLink, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return bridge.InviteLink{}, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return bridge.InviteLink{}, err
	}
	req := &tg.MessagesExportChatInviteRequest{Peer: peer}
	if title != "" {
		req.SetTitle(title)
	}
	res, err := c.live.api().MessagesExportChatInvite(ctx, req)
	if err != nil {
		return bridge.InviteLink{}, translatePin(err)
	}
	l, ok := inviteOf(res)
	if !ok {
		return bridge.InviteLink{}, fmt.Errorf("telegram: the invite link came back in a form this adapter does not know")
	}
	return l, nil
}

// RevokeInvite implements bridge.InviteManager.
func (a *Adapter) RevokeInvite(ctx context.Context, acct bridge.Account, conv, link string) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	_, err = c.live.api().MessagesEditExportedChatInvite(ctx, &tg.MessagesEditExportedChatInviteRequest{Peer: peer, Link: link, Revoked: true})
	return translatePin(err)
}

// LeaveGroup implements bridge.GroupLifecycle.
func (a *Adapter) LeaveGroup(ctx context.Context, acct bridge.Account, conv string) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		_, err = c.live.api().ChannelsLeaveChannel(ctx, &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash})
	case *tg.InputPeerChat:
		_, err = c.live.api().MessagesDeleteChatUser(ctx, &tg.MessagesDeleteChatUserRequest{ChatID: p.ChatID, UserID: &tg.InputUserSelf{}})
	default:
		return fmt.Errorf("%w: %s is not a group", bridge.ErrNotAllowed, conv)
	}
	return translatePin(err)
}

// DeleteGroup implements bridge.GroupLifecycle: only the creator of a group can.
func (a *Adapter) DeleteGroup(ctx context.Context, acct bridge.Account, conv string) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return err
	}
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		_, err = c.live.api().ChannelsDeleteChannel(ctx, &tg.InputChannel{ChannelID: p.ChannelID, AccessHash: p.AccessHash})
	case *tg.InputPeerChat:
		_, err = c.live.api().MessagesDeleteChat(ctx, p.ChatID)
	default:
		return fmt.Errorf("%w: %s is not a group", bridge.ErrNotAllowed, conv)
	}
	return translatePin(err)
}

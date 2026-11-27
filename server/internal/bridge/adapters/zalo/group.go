package zalo

import (
	"context"
	"errors"
	"strings"
	"time"

	"app.local/server/internal/bridge"
)

// A Zalo group is the conversation "g<group id>". The prefix keeps a group apart from
// a person, whose conversation is their bare id: Zalo gives both as decimal digits, and
// a command meant for a group must never reach a person of the same number.
const groupConvPrefix = "g"

// maxGroupsPerRead is how many groups one group_info command asks about (the
// sidecar's MAX_GROUPS_PER_READ).
const maxGroupsPerRead = 50

// groupInfoAnswer bounds the wait for a group_info answer.
const groupInfoAnswer = 15 * time.Second

// groupConv is the conversation of the group id.
func groupConv(id string) string { return groupConvPrefix + id }

// target is who a conversation's commands go to: the person's or the group's Zalo id,
// and whether it is a group. ok is false for anything else.
func target(conv string) (to string, group bool, ok bool) {
	if accountUID.MatchString(conv) {
		return conv, false, true
	}
	if id, isGroup := strings.CutPrefix(conv, groupConvPrefix); isGroup && accountUID.MatchString(id) {
		return id, true, true
	}
	return "", false, false
}

// isTarget reports whether commands can be sent to a conversation (target).
func isTarget(conv string) bool {
	_, _, ok := target(conv)
	return ok
}

// mapGroupMessage turns a group message event into the bridge message and its
// conversation. The sender is the owner (self) or a member named by dName; the
// group's title stays empty until the sidecar could look the name up, and such a
// group is not listed (heardAccount.conversations).
func mapGroupMessage(ev wireEvent, now time.Time) (bridge.Message, bridge.Conversation, error) {
	id, from, gid := string(ev.MsgID), string(ev.UIDFrom), string(ev.GroupID)
	if !zaloID.MatchString(id) || !zaloID.MatchString(from) || !accountUID.MatchString(gid) {
		return bridge.Message{}, bridge.Conversation{}, errors.New("zalo: group message without valid ids")
	}
	conv := bridge.Conversation{ID: groupConv(gid), Kind: bridge.ConvGroup, Title: strings.TrimSpace(ev.GroupName)}
	if avatarAllowed(ev.GroupAvatar) {
		conv.PhotoRef = avatarRef + ev.GroupAvatar
	}
	sender := bridge.Participant{ID: from, IsSelf: true}
	if !ev.Self {
		sender = bridge.Participant{ID: from, Name: "Zalo " + from, NameUnknown: true}
		if ev.DName != "" {
			sender.Name, sender.NameUnknown = ev.DName, false
		}
		withAvatar(&sender, ev.PeerAvatar)
		withSeen(&sender, ev.PeerSeen)
	}
	m := bridge.Message{Conversation: conv.ID, ID: id, From: sender, Date: parseTimestamp(ev.TS, now)}
	m.Text, m.Media = messageContent(ev)
	return m, conv, nil
}

var _ bridge.InfoReader = (*Adapter)(nil)

// GroupInfos implements bridge.InfoReader: the name, description and photo of the
// groups among convs, read through the account's listening sidecar in batches of
// maxGroupsPerRead. A group Zalo tells nothing about is left out; without a
// running sidecar, or when a read fails, the groups not read are left out and the
// engine asks again on its next round.
func (a *Adapter) GroupInfos(ctx context.Context, acct bridge.Account, convs []string) (map[string]bridge.GroupInfo, error) {
	var ids []string
	for _, c := range convs {
		if id, group, ok := target(c); ok && group {
			ids = append(ids, id)
		}
	}
	out := map[string]bridge.GroupInfo{}
	if len(ids) == 0 {
		return out, nil
	}
	side := a.sidecarOf(acct.ID)
	if side == nil {
		return out, nil
	}
	for start := 0; start < len(ids); start += maxGroupsPerRead {
		batch := ids[start:min(start+maxGroupsPerRead, len(ids))]
		ev, err := side.request(ctx, command{Cmd: cmdGroupInfo, ID: a.nextRequestID(), Groups: batch}, groupInfoAnswer)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil || ev.Ev != evGroupInfo {
			// What was read is kept; the rest is read again on the engine's next round.
			a.logger.Warn("zalo group info not read", "event", safeCode(ev.Ev))
			return out, nil
		}
		for _, id := range batch {
			g, ok := ev.Groups[id]
			if !ok || strings.TrimSpace(g.Name) == "" {
				continue
			}
			info := bridge.GroupInfo{Title: strings.TrimSpace(g.Name), About: g.About}
			if avatarAllowed(g.Avatar) {
				info.PhotoID, info.PhotoRef = g.Avatar, avatarRef+g.Avatar
			}
			out[groupConv(id)] = info
		}
	}
	return out, nil
}

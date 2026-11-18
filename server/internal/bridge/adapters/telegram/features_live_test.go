package telegram

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

// TestLiveTelegramFeatures is the spike of the full two-way sync: for each feature
// it reads what Telegram offers, what an account may do, and (for the personal
// state) what the other side hears back. It prints only counts, ids and the kind of
// each update, never a title or a message. By hand, never on its own:
//
//	BRIDGE_LIVE_FEATURES=1 BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… TELEGRAM_API_HASH=… \
//	  go test ./internal/bridge/adapters/telegram -run LiveTelegramFeatures -timeout 25m -v
//
// Always: a read-only inventory of the forum «BRIDGE_LIVE_FEATURES_GROUP» (default
// none: the first forum) and the personal state changes (reaction, unread mark,
// mute, pin of the dialog, draft, typing) on the Saved Messages chat, each undone at
// once. Optional:
//
//	BRIDGE_LIVE_FEATURES_WATCH=4m   log the kind of every update for that long, so
//	                                 things done by hand on the phone can be seen
//	BRIDGE_LIVE_FEATURES_INFO=<conv> change and put back the title and the about of a
//	                                 group made only for this test
//	BRIDGE_LIVE_FEATURES_MEMBERS=<conv>/<user id>  invite, promote, demote and remove one
//	                                 person of a group made only for this test
func TestLiveTelegramFeatures(t *testing.T) {
	if os.Getenv("BRIDGE_LIVE_FEATURES") == "" {
		t.Skip("set BRIDGE_LIVE_FEATURES=1 to run against a real Telegram account")
	}
	ctx, a, acct := liveSession(t, "live-features", 24*time.Minute)
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	api := c.live.api()
	step := func(name string, err error) {
		t.Helper()
		if err != nil {
			t.Logf("%-34s ERR %v", name, translatePin(err))
			return
		}
		t.Logf("%-34s ok", name)
	}

	// Every update the account hears during the test: its kind and the ids it names.
	var heard []string
	record := func(s string) { heard = append(heard, s) }
	watchFor := time.Duration(0)
	if d := os.Getenv("BRIDGE_LIVE_FEATURES_WATCH"); d != "" {
		if watchFor, err = time.ParseDuration(d); err != nil {
			t.Fatal(err)
		}
	}
	c.setManager(telegram.UpdateHandlerFunc(func(_ context.Context, u tg.UpdatesClass) error {
		var list []tg.UpdateClass
		switch v := u.(type) {
		case *tg.Updates:
			list = v.Updates
		case *tg.UpdatesCombined:
			list = v.Updates
		case *tg.UpdateShort:
			list = []tg.UpdateClass{v.Update}
		}
		for _, up := range list {
			switch v := up.(type) {
			case *tg.UpdateMessageReactions:
				record(fmt.Sprintf("MessageReactions msg=%d reactions=%d", v.MsgID, len(v.Reactions.Results)))
			case *tg.UpdateReadHistoryInbox:
				record(fmt.Sprintf("ReadHistoryInbox maxID=%d stillUnread=%d", v.MaxID, v.StillUnreadCount))
			case *tg.UpdateReadChannelInbox:
				record(fmt.Sprintf("ReadChannelInbox channel=%d maxID=%d stillUnread=%d", v.ChannelID, v.MaxID, v.StillUnreadCount))
			case *tg.UpdateNotifySettings:
				record(fmt.Sprintf("NotifySettings peer=%T", v.Peer))
			case *tg.UpdateDialogPinned:
				record(fmt.Sprintf("DialogPinned pinned=%v", v.Pinned))
			case *tg.UpdatePinnedDialogs:
				record("PinnedDialogs")
			case *tg.UpdateDialogUnreadMark:
				record(fmt.Sprintf("DialogUnreadMark unread=%v", v.Unread))
			case *tg.UpdateDraftMessage:
				record("DraftMessage")
			case *tg.UpdateChannelParticipant:
				record(fmt.Sprintf("ChannelParticipant channel=%d", v.ChannelID))
			case *tg.UpdateChatParticipant:
				record(fmt.Sprintf("ChatParticipant chat=%d", v.ChatID))
			case *tg.UpdateChatParticipants:
				record("ChatParticipants")
			case *tg.UpdateChannel:
				record(fmt.Sprintf("Channel channel=%d", v.ChannelID))
			case *tg.UpdateChat:
				record(fmt.Sprintf("Chat chat=%d", v.ChatID))
			case *tg.UpdateChatDefaultBannedRights:
				record("ChatDefaultBannedRights")
			case *tg.UpdateUserTyping, *tg.UpdateChatUserTyping, *tg.UpdateChannelUserTyping:
				record(fmt.Sprintf("Typing %s", reflect.TypeOf(v).Elem().Name()))
			case *tg.UpdateNewChannelMessage, *tg.UpdateNewMessage:
				if m, ok := messageOf(v); ok {
					if s, ok := m.(*tg.MessageService); ok {
						record(fmt.Sprintf("service %s", reflect.TypeOf(s.Action).Elem().Name()))
					}
				}
			}
		}
		return nil
	}))
	defer c.setManager(nil)
	mark := func(label string) {
		t.Helper()
		time.Sleep(1500 * time.Millisecond)
		t.Logf("   heard after %s: %v", label, heard)
		heard = nil
	}

	// ---- read-only inventory of a forum
	convs, err := a.ListConversations(ctx, acct)
	if err != nil {
		t.Fatal(err)
	}
	// A group's about left changed by an earlier run is cleared by title.
	if title := os.Getenv("BRIDGE_LIVE_FEATURES_CLEAR_ABOUT"); title != "" {
		for _, x := range convs {
			if x.Title != title {
				continue
			}
			peer, err := c.inputPeer(ctx, x.ID)
			if err != nil {
				t.Fatal(err)
			}
			_, err = api.MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: ""})
			step("about cleared", err)
			return
		}
		t.Fatal("no conversation has the title given in BRIDGE_LIVE_FEATURES_CLEAR_ABOUT")
	}

	groupID := os.Getenv("BRIDGE_LIVE_FEATURES_GROUP")
	for _, cv := range convs {
		if groupID != "" && cv.ID != groupID {
			continue
		}
		if groupID == "" && !cv.Forum {
			continue
		}
		peer, err := c.inputPeer(ctx, cv.ID)
		if err != nil {
			continue
		}
		ch, isChannel := peer.(*tg.InputPeerChannel)
		t.Logf("--- %s forum=%v", cv.ID, cv.Forum)
		if isChannel {
			full, err := api.ChannelsGetFullChannel(ctx, &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash})
			if err != nil {
				t.Logf("  full channel: %v", err)
			} else if fc, ok := full.FullChat.(*tg.ChannelFull); ok {
				t.Logf("  about %d chars, participants %d, admins %d, slowmode %v, pinned msg %d, available reactions %T",
					len(fc.About), fc.ParticipantsCount, fc.AdminsCount, fc.SlowmodeSeconds, fc.PinnedMsgID, fc.AvailableReactions)
				t.Logf("  exported invite present=%v, can view participants=%v", fc.ExportedInvite != nil, fc.CanViewParticipants)
			}
			parts, err := api.ChannelsGetParticipants(ctx, &tg.ChannelsGetParticipantsRequest{
				Channel: &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash}, Filter: &tg.ChannelParticipantsAdmins{}, Limit: 20})
			if err != nil {
				t.Logf("  admins list: %v", err)
			} else if p, ok := parts.(*tg.ChannelsChannelParticipants); ok {
				t.Logf("  admins listed: %d of %d", len(p.Participants), p.Count)
			}
			invites, err := api.MessagesGetExportedChatInvites(ctx, &tg.MessagesGetExportedChatInvitesRequest{Peer: peer, AdminID: &tg.InputUserSelf{}, Limit: 20})
			if err != nil {
				t.Logf("  invite links of mine: %v", translatePin(err))
			} else {
				t.Logf("  invite links of mine: %d", invites.Count)
			}
		}
		ns, err := api.AccountGetNotifySettings(ctx, &tg.InputNotifyPeer{Peer: peer})
		if err != nil {
			t.Logf("  notify settings: %v", err)
		} else {
			mute, _ := ns.GetMuteUntil()
			t.Logf("  notify settings: muteUntil=%d showPreviews=%v silent=%v", mute, ns.ShowPreviews, ns.Silent)
		}
		dialogs, err := api.MessagesGetPeerDialogs(ctx, []tg.InputDialogPeerClass{&tg.InputDialogPeer{Peer: peer}})
		if err != nil {
			t.Logf("  dialog: %v", err)
		} else if len(dialogs.Dialogs) > 0 {
			if d, ok := dialogs.Dialogs[0].(*tg.Dialog); ok {
				folder, _ := d.GetFolderID()
				t.Logf("  dialog: pinned=%v unreadMark=%v unread=%d unreadMentions=%d unreadReactions=%d folder=%d",
					d.Pinned, d.UnreadMark, d.UnreadCount, d.UnreadMentionsCount, d.UnreadReactionsCount, folder)
			}
		}
		break
	}
	filters, err := api.MessagesGetDialogFilters(ctx)
	if err != nil {
		t.Logf("dialog folders: %v", err)
	} else {
		t.Logf("dialog folders: %d", len(filters.Filters))
	}
	reactions, err := api.MessagesGetAvailableReactions(ctx, 0)
	if err == nil {
		if r, ok := reactions.(*tg.MessagesAvailableReactions); ok {
			t.Logf("available reactions: %d", len(r.Reactions))
		}
	}

	// ---- personal state, on Saved Messages, each change undone at once
	self := &tg.InputPeerSelf{}
	sent, err := api.MessagesSendMessage(ctx, &tg.MessagesSendMessageRequest{Peer: self, Message: "bridge spike, deleted at once", RandomID: time.Now().UnixNano()})
	step("send to Saved Messages", err)
	msgID := 0
	if upd, ok := sent.(*tg.UpdateShortSentMessage); ok {
		msgID = upd.ID
	} else if us, ok := sent.(*tg.Updates); ok {
		for _, up := range us.Updates {
			if m, ok := up.(*tg.UpdateMessageID); ok {
				msgID = m.ID
			}
		}
	}
	t.Logf("   message id %d", msgID)
	if msgID != 0 {
		_, err = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: self, MsgID: msgID, Reaction: []tg.ReactionClass{&tg.ReactionEmoji{Emoticon: "👍"}}})
		step("reaction set", err)
		mark("reaction set")
		_, err = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: self, MsgID: msgID})
		step("reaction cleared", err)
		mark("reaction cleared")
		_, err = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: self, MsgID: msgID, Reaction: []tg.ReactionClass{&tg.ReactionEmoji{Emoticon: "👍"}}})
		step("same reaction set again", err)
		_, _ = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: self, MsgID: msgID})
	}
	_, err = api.MessagesMarkDialogUnread(ctx, &tg.MessagesMarkDialogUnreadRequest{Peer: &tg.InputDialogPeer{Peer: self}, Unread: true})
	step("mark dialog unread", err)
	mark("mark unread")
	_, err = api.MessagesMarkDialogUnread(ctx, &tg.MessagesMarkDialogUnreadRequest{Peer: &tg.InputDialogPeer{Peer: self}, Unread: false})
	step("mark dialog read", err)
	mark("mark read")
	_, err = api.MessagesReadHistory(ctx, &tg.MessagesReadHistoryRequest{Peer: self, MaxID: msgID})
	step("read history", err)
	mark("read history")

	selfNotify := &tg.InputNotifyPeer{Peer: self}
	before, err := api.AccountGetNotifySettings(ctx, selfNotify)
	step("get notify settings", err)
	if err == nil {
		_, err = api.AccountUpdateNotifySettings(ctx, &tg.AccountUpdateNotifySettingsRequest{Peer: selfNotify,
			Settings: tg.InputPeerNotifySettings{MuteUntil: int(time.Now().Add(time.Hour).Unix())}})
		step("mute for an hour", err)
		mark("mute")
		restore := tg.InputPeerNotifySettings{}
		if v, ok := before.GetMuteUntil(); ok {
			restore.SetMuteUntil(v)
		} else {
			restore.SetMuteUntil(0)
		}
		_, err = api.AccountUpdateNotifySettings(ctx, &tg.AccountUpdateNotifySettingsRequest{Peer: selfNotify, Settings: restore})
		step("notify settings restored", err)
		mark("unmute")
	}
	_, err = api.MessagesToggleDialogPin(ctx, &tg.MessagesToggleDialogPinRequest{Peer: &tg.InputDialogPeer{Peer: self}, Pinned: true})
	step("pin the dialog", err)
	mark("pin dialog")
	_, err = api.MessagesToggleDialogPin(ctx, &tg.MessagesToggleDialogPinRequest{Peer: &tg.InputDialogPeer{Peer: self}, Pinned: false})
	step("unpin the dialog", err)
	mark("unpin dialog")
	_, err = api.MessagesSaveDraft(ctx, &tg.MessagesSaveDraftRequest{Peer: self, Message: "draft spike"})
	step("save draft", err)
	mark("draft")
	_, err = api.MessagesSaveDraft(ctx, &tg.MessagesSaveDraftRequest{Peer: self})
	step("clear draft", err)
	_, err = api.MessagesSetTyping(ctx, &tg.MessagesSetTypingRequest{Peer: self, Action: &tg.SendMessageTypingAction{}})
	step("typing (to self)", err)
	if msgID != 0 {
		_, err = api.MessagesDeleteMessages(ctx, &tg.MessagesDeleteMessagesRequest{ID: []int{msgID}, Revoke: true})
		step("delete the spike message", err)
	}

	// ---- structure, only on a group made for the test, found by its title
	if title := os.Getenv("BRIDGE_LIVE_FEATURES_TITLE"); title != "" {
		var cv *struct{ id, kind string }
		for _, x := range convs {
			if x.Title == title {
				cv = &struct{ id, kind string }{x.ID, string(x.Kind)}
			}
		}
		if cv == nil {
			t.Fatalf("no conversation has the title given in BRIDGE_LIVE_FEATURES_TITLE")
		}
		peer, err := c.inputPeer(ctx, cv.id)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("--- test group %s kind=%s peer=%T", cv.id, cv.kind, peer)
		var chatID int64
		var in *tg.InputChannel
		switch v := peer.(type) {
		case *tg.InputPeerChannel:
			in = &tg.InputChannel{ChannelID: v.ChannelID, AccessHash: v.AccessHash}
		case *tg.InputPeerChat:
			chatID = v.ChatID
		}
		// a message to react to and to anchor topics
		sent, err := api.MessagesSendMessage(ctx, &tg.MessagesSendMessageRequest{Peer: peer, Message: "bridge spike message", RandomID: time.Now().UnixNano()})
		step("send to the test group", err)
		gid := 0
		if us, ok := sent.(*tg.Updates); ok {
			for _, up := range us.Updates {
				if m, ok := up.(*tg.UpdateMessageID); ok {
					gid = m.ID
				}
			}
		}
		if gid != 0 {
			_, err = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: peer, MsgID: gid, Reaction: []tg.ReactionClass{&tg.ReactionEmoji{Emoticon: "👍"}}})
			step("reaction set (group)", err)
			mark("reaction set (group)")
			list, err := api.MessagesGetMessageReactionsList(ctx, &tg.MessagesGetMessageReactionsListRequest{Peer: peer, ID: gid, Limit: 10})
			if err == nil {
				t.Logf("   reactions list: %d, total %d", len(list.Reactions), list.Count)
			}
			_, err = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: peer, MsgID: gid})
			step("reaction cleared (group)", err)
			mark("reaction cleared (group)")
			_, err = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: peer, MsgID: gid, Reaction: []tg.ReactionClass{&tg.ReactionEmoji{Emoticon: "🔥"}}})
			step("reaction replaced (set another)", err)
			_, _ = api.MessagesSendReaction(ctx, &tg.MessagesSendReactionRequest{Peer: peer, MsgID: gid})
		}
		// title and about, put back
		if in != nil {
			full, err := api.ChannelsGetFullChannel(ctx, in)
			if err != nil {
				t.Fatal(err)
			}
			fc := full.FullChat.(*tg.ChannelFull)
			var oldTitle string
			for _, ch := range full.Chats {
				if cc, ok := ch.(*tg.Channel); ok && cc.ID == in.ChannelID {
					oldTitle = cc.Title
				}
			}
			_, err = api.ChannelsEditTitle(ctx, &tg.ChannelsEditTitleRequest{Channel: in, Title: oldTitle + " 2"})
			step("title changed (channel)", err)
			mark("title")
			_, err = api.ChannelsEditTitle(ctx, &tg.ChannelsEditTitleRequest{Channel: in, Title: oldTitle})
			step("title put back (channel)", err)
			mark("title back")
			_, err = api.MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: "bridge spike"})
			step("about changed", err)
			mark("about")
			_, err = api.MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: fc.About})
			step("about put back", err)
			mark("about back")
			// own invite links
			link, err := api.MessagesExportChatInvite(ctx, &tg.MessagesExportChatInviteRequest{Peer: peer, Title: "spike"})
			step("invite link created", err)
			if err == nil {
				if inv, ok := link.(*tg.ChatInviteExported); ok {
					mark("invite link created")
					_, err = api.MessagesEditExportedChatInvite(ctx, &tg.MessagesEditExportedChatInviteRequest{Peer: peer, Link: inv.Link, Revoked: true})
					step("invite link revoked", err)
					mark("invite link revoked")
				}
			}
			// forum topics, if the group has them
			if cv.kind != "" {
				topics, terr := a.ListTopics(ctx, acct, cv.id)
				if terr == nil {
					t.Logf("   topics: %d", len(topics))
					rid := time.Now().UnixNano()
					ct, err := api.MessagesCreateForumTopic(ctx, &tg.MessagesCreateForumTopicRequest{Peer: peer, Title: "spike topic", RandomID: rid})
					step("topic created", err)
					mark("topic created")
					topicID := 0
					if us, ok := ct.(*tg.Updates); ok {
						for _, up := range us.Updates {
							if m, ok := up.(*tg.UpdateMessageID); ok {
								topicID = m.ID
							}
						}
					}
					if topicID != 0 {
						title := "spike topic renamed"
						_, err = api.MessagesEditForumTopic(ctx, &tg.MessagesEditForumTopicRequest{Peer: peer, TopicID: topicID, Title: title})
						step("topic renamed", err)
						mark("topic renamed")
						_, err = api.MessagesEditForumTopic(ctx, &tg.MessagesEditForumTopicRequest{Peer: peer, TopicID: topicID, Closed: true})
						step("topic closed", err)
						mark("topic closed")
						_, err = api.MessagesEditForumTopic(ctx, &tg.MessagesEditForumTopicRequest{Peer: peer, TopicID: topicID, Closed: false})
						step("topic reopened", err)
						mark("topic reopened")
						_, err = api.MessagesDeleteTopicHistory(ctx, &tg.MessagesDeleteTopicHistoryRequest{Peer: peer, TopMsgID: topicID})
						step("topic deleted", err)
						mark("topic deleted")
					}
				} else {
					t.Logf("   not a forum: %v", terr)
				}
			}
		} else if chatID != 0 {
			full, err := api.MessagesGetFullChat(ctx, chatID)
			if err != nil {
				t.Fatal(err)
			}
			var oldTitle string
			for _, ch := range full.Chats {
				if cc, ok := ch.(*tg.Chat); ok && cc.ID == chatID {
					oldTitle = cc.Title
				}
			}
			_, err = api.MessagesEditChatTitle(ctx, &tg.MessagesEditChatTitleRequest{ChatID: chatID, Title: oldTitle + " 2"})
			step("title changed (basic group)", err)
			mark("title")
			_, err = api.MessagesEditChatTitle(ctx, &tg.MessagesEditChatTitleRequest{ChatID: chatID, Title: oldTitle})
			step("title put back (basic group)", err)
			mark("title back")
			about := ""
			if cf, ok := full.FullChat.(*tg.ChatFull); ok {
				about = cf.About
			}
			_, err = api.MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: "bridge spike"})
			step("about changed", err)
			mark("about")
			_, err = api.MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: about})
			step("about put back", err)
		}
		if gid != 0 {
			_, err = api.MessagesDeleteMessages(ctx, &tg.MessagesDeleteMessagesRequest{ID: []int{gid}, Revoke: true})
			step("delete the spike message (group)", err)
		}
	}

	// ---- structure and people, only on a group made for the test
	if conv := os.Getenv("BRIDGE_LIVE_FEATURES_INFO"); conv != "" {
		peer, err := c.inputPeer(ctx, conv)
		if err != nil {
			t.Fatal(err)
		}
		if ch, ok := peer.(*tg.InputPeerChannel); ok {
			in := &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash}
			full, err := api.ChannelsGetFullChannel(ctx, in)
			if err != nil {
				t.Fatal(err)
			}
			about := full.FullChat.(*tg.ChannelFull).About
			_, err = api.MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: "bridge spike"})
			step("about changed", err)
			mark("about")
			_, err = api.MessagesEditChatAbout(ctx, &tg.MessagesEditChatAboutRequest{Peer: peer, About: about})
			step("about put back", err)
			mark("about back")
		} else {
			t.Logf("BRIDGE_LIVE_FEATURES_INFO: %s is not a channel or supergroup; basic groups use other calls", conv)
		}
	}
	if target := os.Getenv("BRIDGE_LIVE_FEATURES_MEMBERS"); target != "" {
		conv, idText, _ := strings.Cut(target, "/")
		uid, _ := strconv.ParseInt(idText, 10, 64)
		peer, perr := c.inputPeer(ctx, conv)
		hash, known := c.hashes[uid]
		ch, isChannel := peer.(*tg.InputPeerChannel)
		if perr != nil || uid == 0 || !known || !isChannel {
			t.Fatalf("BRIDGE_LIVE_FEATURES_MEMBERS wants <supergroup>/<id of a person in the dialog list> (%v, known=%v)", perr, known)
		}
		in := &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash}
		user := &tg.InputUser{UserID: uid, AccessHash: hash}
		_, err := api.ChannelsInviteToChannel(ctx, &tg.ChannelsInviteToChannelRequest{Channel: in, Users: []tg.InputUserClass{user}})
		step("invite", err)
		mark("invite")
		_, err = api.ChannelsEditAdmin(ctx, &tg.ChannelsEditAdminRequest{Channel: in, UserID: user, Rank: "spike",
			AdminRights: tg.ChatAdminRights{PinMessages: true}})
		step("promote to admin (pin only)", err)
		mark("promote")
		_, err = api.ChannelsEditAdmin(ctx, &tg.ChannelsEditAdminRequest{Channel: in, UserID: user, AdminRights: tg.ChatAdminRights{}})
		step("demote", err)
		mark("demote")
		_, err = api.ChannelsEditBanned(ctx, &tg.ChannelsEditBannedRequest{Channel: in, Participant: &tg.InputPeerUser{UserID: uid, AccessHash: hash},
			BannedRights: tg.ChatBannedRights{ViewMessages: true}})
		step("remove (ban)", err)
		mark("remove")
		_, err = api.ChannelsEditBanned(ctx, &tg.ChannelsEditBannedRequest{Channel: in, Participant: &tg.InputPeerUser{UserID: uid, AccessHash: hash},
			BannedRights: tg.ChatBannedRights{}})
		step("lift the ban", err)
		mark("unban")
	}

	if watchFor > 0 {
		t.Logf("watching every update for %s: change things by hand in Telegram now (mute, pin a chat, mark unread, read, react, type…)", watchFor)
		select {
		case <-time.After(watchFor):
		case <-ctx.Done():
		}
		t.Logf("heard while watching: %v", heard)
	}
}

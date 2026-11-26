package chatmcp

import (
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

func userIDs(users []*appv1.User) []int64 {
	var ids []int64
	for _, u := range users {
		ids = append(ids, u.GetId())
	}
	return ids
}

func TestDropHiddenLeavesOutBotDeadLettersOfHiddenChats(t *testing.T) {
	r := &appv1.ListBotDeadLettersResponse{Total: 5, DeadLetters: []*appv1.BotDeadLetter{
		{UpdateId: 1, ChatId: 10}, {UpdateId: 2, ChatId: 20}, {UpdateId: 3, ChatId: 10},
	}}
	dropHidden(map[int64]bool{10: true}, 1, r)
	if len(r.DeadLetters) != 1 || r.DeadLetters[0].GetUpdateId() != 2 || r.Total != 3 {
		t.Fatalf("dead letters = %v, total %d", r.DeadLetters, r.Total)
	}
}

func TestDropHiddenLeavesOutThePeerOfAHiddenPrivateChatUnlessStillReferenced(t *testing.T) {
	const me, peer, referenced, groupMember = 1, 2, 3, 4
	dialogs := func() *appv1.GetDialogsResponse {
		return &appv1.GetDialogsResponse{
			Dialogs: []*appv1.Dialog{{ChatId: 10}, {ChatId: 11}, {ChatId: 20}},
			Chats: []*appv1.Chat{
				{Id: 10, Type: appv1.ChatType_CHAT_TYPE_PRIVATE, PeerUserId: peer},
				{Id: 11, Type: appv1.ChatType_CHAT_TYPE_PRIVATE, PeerUserId: referenced},
				{Id: 20, Type: appv1.ChatType_CHAT_TYPE_GROUP},
			},
			Messages: []*appv1.Message{
				{ChatId: 10, FromId: peer},
				{ChatId: 11, FromId: referenced},
				// The other hidden peer still speaks in a kept group.
				{ChatId: 20, FromId: groupMember, Entities: []*appv1.MessageEntity{{UserId: referenced}}},
			},
			Users:         []*appv1.User{{Id: me}, {Id: peer}, {Id: referenced}, {Id: groupMember}},
			PinnedChatIds: []int64{10, 20},
		}
	}
	r := dialogs()
	dropHidden(map[int64]bool{10: true, 11: true}, me, r)
	if got := userIDs(r.Users); !slices.Equal(got, []int64{me, referenced, groupMember}) {
		t.Fatalf("users = %v", got)
	}
	if len(r.Dialogs) != 1 || len(r.Chats) != 1 || len(r.Messages) != 1 || !slices.Equal(r.PinnedChatIds, []int64{20}) {
		t.Fatalf("dialogs = %v", r)
	}

	// The caller's own chat with itself never drops the caller.
	self := &appv1.SearchMessagesResponse{
		Chats:    []*appv1.Chat{{Id: 30, Type: appv1.ChatType_CHAT_TYPE_PRIVATE, PeerUserId: me}},
		Messages: []*appv1.Message{{ChatId: 30, FromId: me}},
		Users:    []*appv1.User{{Id: me}},
	}
	dropHidden(map[int64]bool{30: true}, me, self)
	if got := userIDs(self.Users); !slices.Equal(got, []int64{me}) || len(self.Messages) != 0 || len(self.Chats) != 0 {
		t.Fatalf("self = %v", self)
	}

	// Nothing hidden: the answer is untouched.
	r = dialogs()
	dropHidden(nil, me, r)
	if len(r.Users) != 4 || len(r.Chats) != 3 {
		t.Fatalf("untouched = %v", r)
	}
}

func TestDropHiddenLeavesOutUsersOnlyHiddenChatsReferenced(t *testing.T) {
	const me, hiddenSender, sharedSender, otherSender = 1, 2, 3, 4
	r := &appv1.SearchMessagesResponse{
		Chats: []*appv1.Chat{{Id: 10, Type: appv1.ChatType_CHAT_TYPE_GROUP}, {Id: 20, Type: appv1.ChatType_CHAT_TYPE_GROUP}},
		Messages: []*appv1.Message{
			{ChatId: 10, FromId: hiddenSender, ForwardFrom: &appv1.ForwardHeader{FromUserId: sharedSender}},
			{ChatId: 20, FromId: otherSender, Reactions: []*appv1.ReactionCount{{RecentUserIds: []int64{sharedSender}}}},
		},
		Users: []*appv1.User{{Id: me}, {Id: hiddenSender}, {Id: sharedSender}, {Id: otherSender}},
	}
	dropHidden(map[int64]bool{10: true}, me, r)
	if got := userIDs(r.Users); !slices.Equal(got, []int64{me, sharedSender, otherSender}) {
		t.Fatalf("users = %v", got)
	}
	if len(r.Chats) != 1 || len(r.Messages) != 1 {
		t.Fatalf("answer = %v", r)
	}
}

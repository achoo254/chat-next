package chatmcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// Chats the user hid from AI (Dialog.hidden_from_ai) do not exist for the
// tools: a tool naming one in its input (directly, through one of its
// incoming webhooks or through bot updates from it) or answering one is
// refused, and the tools that answer several chats leave them out, with the
// users only they referenced. Every tool goes through addTool, so this is the
// one place that enforces it; no tool changes the setting.

// errHiddenFromAI refuses a tool call that names a hidden chat.
var errHiddenFromAI = connect.NewError(connect.CodePermissionDenied,
	errors.New("chat_hidden_from_ai: the user hid this chat from AI; it cannot be read or written with these tools"))

// chatRefs are the input fields of the tools that name a chat.
type chatRefs struct {
	ChatID     int64   `json:"chat_id"`
	FromChatID int64   `json:"from_chat_id"`
	ToChatID   int64   `json:"to_chat_id"`
	HookID     string  `json:"hook_id"`
	BotID      int64   `json:"bot_id"`
	UpdateIDs  []int64 `json:"update_ids"`
}

// hiddenChats loads the chats the caller hid from AI; nil when the caller has
// no chat account (every tool then answers errNoChatAccount).
func (t *toolset) hiddenChats(ctx context.Context) (map[int64]bool, error) {
	if !t.c.hasAccount {
		return nil, nil
	}
	return t.h.cfg.Store.ChatsHiddenFromAI(ctx, t.h.cfg.TenantID, t.c.user.ID)
}

// refuseHidden returns errHiddenFromAI when the tool input in names a hidden
// chat, an incoming webhook that posts in one, or bot updates from one.
func (t *toolset) refuseHidden(ctx context.Context, hidden map[int64]bool, in any) error {
	if len(hidden) == 0 {
		return nil
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("chatmcp: read chat ids of the input: %w", err)
	}
	var refs chatRefs
	if err := json.Unmarshal(raw, &refs); err != nil {
		return fmt.Errorf("chatmcp: read chat ids of the input: %w", err)
	}
	ids := []int64{refs.ChatID, refs.FromChatID, refs.ToChatID}
	if refs.HookID != "" {
		// An unknown hook is left to the tool, which answers not found.
		hookChat, found, err := t.h.cfg.Store.IncomingHookChat(ctx, t.h.cfg.TenantID, refs.HookID)
		if err != nil {
			return err
		}
		if found {
			ids = append(ids, hookChat)
		}
	}
	if refs.BotID != 0 && len(refs.UpdateIDs) > 0 {
		// Unknown updates are left to the tool, which skips them.
		updateChats, err := t.h.cfg.Store.BotUpdateChats(ctx, t.h.cfg.TenantID, refs.BotID, refs.UpdateIDs)
		if err != nil {
			return err
		}
		ids = append(ids, updateChats...)
	}
	for _, id := range ids {
		if id != 0 && hidden[id] {
			return errHiddenFromAI
		}
	}
	return nil
}

// refuseHiddenResult returns errHiddenFromAI when a tool that takes no chat
// answers a hidden one (start_private_chat finds the existing chat).
func refuseHiddenResult(hidden map[int64]bool, out any) error {
	if r, ok := out.(*appv1.CreatePrivateResponse); ok && hidden[r.GetChat().GetId()] {
		return errHiddenFromAI
	}
	return nil
}

// dropHidden removes the hidden chats from the answers that span chats; me
// is the caller.
func dropHidden(hidden map[int64]bool, me int64, out any) {
	if len(hidden) == 0 {
		return
	}
	switch r := out.(type) {
	case *appv1.GetDialogsResponse:
		r.Dialogs = slices.DeleteFunc(r.Dialogs, func(d *appv1.Dialog) bool { return hidden[d.GetChatId()] })
		r.PinnedChatIds = slices.DeleteFunc(r.PinnedChatIds, func(id int64) bool { return hidden[id] })
		r.Chats, r.Messages, r.Users = dropHiddenChats(hidden, me, r.Chats, r.Messages, r.Users)
	case *appv1.SearchMessagesResponse:
		r.Chats, r.Messages, r.Users = dropHiddenChats(hidden, me, r.Chats, r.Messages, r.Users)
	case *appv1.GetCommonChatsResponse:
		before := len(r.Chats)
		r.Chats = slices.DeleteFunc(r.Chats, func(c *appv1.Chat) bool { return hidden[c.GetId()] })
		// count covers every page; only this page's hidden chats are known here.
		r.Count = max(0, r.Count-int32(before-len(r.Chats)))
	case *appv1.ListBotDeadLettersResponse:
		before := len(r.DeadLetters)
		r.DeadLetters = slices.DeleteFunc(r.DeadLetters, func(d *appv1.BotDeadLetter) bool { return hidden[d.GetChatId()] })
		// total covers more than the listed newest; only these are known here.
		r.Total = max(0, r.Total-int64(before-len(r.DeadLetters)))
	}
}

// dropHiddenChats removes the hidden chats and their messages from an answer,
// and the users only they referenced: a user stays while a kept chat or
// message references them. The caller always stays.
func dropHiddenChats(hidden map[int64]bool, me int64, chats []*appv1.Chat, messages []*appv1.Message, users []*appv1.User,
) ([]*appv1.Chat, []*appv1.Message, []*appv1.User) {
	gone := map[int64]bool{}
	var keptChats []*appv1.Chat
	for _, c := range chats {
		if hidden[c.GetId()] {
			gone[c.GetPeerUserId()] = true
		} else {
			keptChats = append(keptChats, c)
		}
	}
	var keptMessages []*appv1.Message
	for _, m := range messages {
		if hidden[m.GetChatId()] {
			for _, id := range chat.ReferencedUsers(m) {
				gone[id] = true
			}
		} else {
			keptMessages = append(keptMessages, m)
		}
	}
	delete(gone, 0)
	delete(gone, me)
	for _, c := range keptChats {
		delete(gone, c.GetPeerUserId())
	}
	for _, m := range keptMessages {
		for _, id := range chat.ReferencedUsers(m) {
			delete(gone, id)
		}
	}
	keptUsers := slices.DeleteFunc(users, func(u *appv1.User) bool { return gone[u.GetId()] })
	return keptChats, keptMessages, keptUsers
}

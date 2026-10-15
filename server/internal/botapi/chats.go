package botapi

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/chat"
	"app.local/server/internal/ratelimit"
)

// Group administration and chat actions: the chat's admins and members,
// ban, unban and restrict (as an admin of the chat), leaving, the title
// and description, and "typing…" style actions. The core applies the rules
// of an admin acting in the app.

// pathID parses an id path segment, optionally followed by ":<action>".
func pathID(raw, name string) (int64, string, error) {
	idText, action, _ := strings.Cut(raw, ":")
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil || id <= 0 || id >= maxSafeInt {
		return 0, "", errBadRequest("%s must be a positive integer", name)
	}
	return id, action, nil
}

// chatID reads the chat_id path segment of a method without an action.
func chatID(r *http.Request) (int64, error) {
	id, action, err := pathID(r.PathValue("chat_id"), "chat_id")
	if err != nil {
		return 0, err
	}
	if action != "" {
		return 0, errNotFound("unknown method")
	}
	return id, nil
}

type editChatRequest struct {
	Title *string `json:"title"`
	About *string `json:"about"`
}

// editChat changes the title and/or description of a group or channel
// where the bot may change the info (an admin, or a member when the group
// allows it).
func (s *Service) editChat(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := chatID(r)
	if err != nil {
		return nil, err
	}
	var req editChatRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if req.Title == nil && req.About == nil {
		return nil, errBadRequest("give title and/or about")
	}
	resp, err := s.chat.UpdateChatInfo(ctx, bot.ID, &appv1.UpdateChatInfoRequest{ChatId: id, Title: req.Title, About: req.About})
	if err != nil {
		return nil, err
	}
	return wire.FromChat(resp.GetChat(), nil), nil
}

// leaveChat is POST /chats/{chat_id}:leave: the bot leaves a group or
// channel; its pending updates of the chat are dropped.
func (s *Service) leaveChat(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, action, err := pathID(r.PathValue("chat_id"), "chat_id")
	if err != nil {
		return nil, err
	}
	if action != "leave" {
		return nil, errNotFound("unknown method")
	}
	if _, err := s.chat.LeaveChat(ctx, bot.ID, id, 0); err != nil {
		return nil, err
	}
	return true, nil
}

func memberResult(info chat.MemberInfo, users wire.Users) wire.ChatMember {
	return wire.ChatMember{User: users.UserOf(info.UserID), Status: info.Status, Permissions: info.Permissions}
}

// getAdmins lists the owner and admins of a group or channel the bot is in.
func (s *Service) getAdmins(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := chatID(r)
	if err != nil {
		return nil, err
	}
	list, users, err := s.chat.ChatAdmins(ctx, bot.ID, id)
	if err != nil {
		return nil, err
	}
	index := wire.IndexUsers(users)
	out := make([]wire.ChatMember, 0, len(list))
	for _, m := range list {
		out = append(out, memberResult(m, index))
	}
	return out, nil
}

// getMember returns one member of a group or channel the bot is in: a
// current member, one who left or one who is banned.
func (s *Service) getMember(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := chatID(r)
	if err != nil {
		return nil, err
	}
	userID, action, err := pathID(r.PathValue("member"), "user_id")
	if err != nil {
		return nil, err
	}
	if action != "" {
		return nil, errNotFound("unknown method")
	}
	info, users, err := s.chat.ChatMemberOf(ctx, bot.ID, id, userID)
	if err != nil {
		return nil, err
	}
	return memberResult(info, wire.IndexUsers(users)), nil
}

type restrictRequest struct {
	Permissions *uint32 `json:"permissions"`
}

// memberAction is POST /chats/{chat_id}/members/{user_id}:ban, :unban or
// :restrict, as an admin of the chat. ban removes the member and keeps them
// from coming back (invite links they made stop working); unban only lifts
// the ban; restrict sets the member's permission bits (within the chat's
// defaults).
func (s *Service) memberAction(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := chatID(r)
	if err != nil {
		return nil, err
	}
	userID, action, err := pathID(r.PathValue("member"), "user_id")
	if err != nil {
		return nil, err
	}
	if userID == bot.ID && action != "" {
		return nil, errBadRequest("a bot does not %s itself (POST /chats/{chat_id}:leave leaves)", action)
	}
	switch action {
	case "ban":
		if err := decode(r, &struct{}{}, true); err != nil {
			return nil, err
		}
		_, err = s.chat.RemoveMember(ctx, bot.ID, id, userID, true)
	case "unban":
		if err := decode(r, &struct{}{}, true); err != nil {
			return nil, err
		}
		err = s.chat.UnbanMember(ctx, bot.ID, id, userID)
	case "restrict":
		var req restrictRequest
		if err := decode(r, &req, false); err != nil {
			return nil, err
		}
		if req.Permissions == nil {
			return nil, errBadRequest("permissions is required (a bitmask of ChatPermission)")
		}
		_, err = s.chat.SetMemberPermissions(ctx, bot.ID, id, userID, *req.Permissions)
	default:
		return nil, errNotFound("unknown method")
	}
	if err != nil {
		return nil, err
	}
	return true, nil
}

// chatActions maps the Bot API's chat actions to typing frames.
var chatActions = map[string]appv1.TypingAction{
	"typing":          appv1.TypingAction_TYPING_ACTION_TYPING,
	"upload_photo":    appv1.TypingAction_TYPING_ACTION_UPLOADING_PHOTO,
	"upload_video":    appv1.TypingAction_TYPING_ACTION_UPLOADING_VIDEO,
	"upload_document": appv1.TypingAction_TYPING_ACTION_UPLOADING_DOCUMENT,
	"record_voice":    appv1.TypingAction_TYPING_ACTION_RECORDING_VOICE,
	"cancel":          appv1.TypingAction_TYPING_ACTION_CANCEL,
}

// chatActionRule merges repeated actions into one chat: clients show an
// action for about 5 seconds, so more than one a second adds nothing.
var chatActionRule = ratelimit.Rule{Rate: 1, Burst: 3}

type chatActionRequest struct {
	Action  string `json:"action"`
	TopicID int64  `json:"topic_id"`
}

// chatAction shows "typing…" (or uploading a photo, …) for the bot to the
// users who have the chat open, for about 5 seconds or until the bot's next
// message; repeat it while working. The bot must be allowed to post there.
func (s *Service) chatAction(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := chatID(r)
	if err != nil {
		return nil, err
	}
	var req chatActionRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	action, ok := chatActions[req.Action]
	if !ok {
		return nil, errBadRequest("action must be typing, upload_photo, upload_video, upload_document, record_voice or cancel")
	}
	topic, err := s.chat.CheckBotPost(ctx, bot.ID, id, req.TopicID)
	if err != nil {
		return nil, err
	}
	if s.typer != nil && s.limiter.Allow(chatActionRule, fmt.Sprintf("botaction:%d:%d", bot.ID, id)) {
		s.typer.BotTyping(bot.ID, id, topic, action)
	}
	return true, nil
}

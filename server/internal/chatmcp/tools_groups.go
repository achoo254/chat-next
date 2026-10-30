package chatmcp

import (
	"context"

	appv1 "app.local/server/gen/app/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// permissionBits documents the ChatPermission bitmask of the permission
// fields.
const permissionBits = "ChatPermission bitmask: 1 send messages, 2 send media, 4 add members, 8 pin messages, 16 change info, 32 manage topics"

type createGroupInput struct {
	Title   string  `json:"title" jsonschema:"the group's title"`
	UserIDs []int64 `json:"user_ids,omitempty" jsonschema:"users to add at once (optional)"`
	Forum   bool    `json:"forum,omitempty" jsonschema:"create the group with forum topics on"`
}

type createChannelInput struct {
	Title string `json:"title" jsonschema:"the channel's title"`
	About string `json:"about,omitempty" jsonschema:"the channel's description"`
}

type addMembersInput struct {
	ChatID  int64   `json:"chat_id" jsonschema:"the group or channel"`
	UserIDs []int64 `json:"user_ids" jsonschema:"users to add; those who cannot be added come back in failed_user_ids"`
}

type removeMemberInput struct {
	ChatID int64 `json:"chat_id" jsonschema:"the group or channel"`
	UserID int64 `json:"user_id" jsonschema:"the member to remove"`
	Ban    *bool `json:"ban,omitempty" jsonschema:"omitted or true also bans the user (no rejoining by link until unbanned); false only removes"`
}

type updateChatInfoInput struct {
	ChatID             int64   `json:"chat_id" jsonschema:"the group or channel"`
	Title              *string `json:"title,omitempty" jsonschema:"new title; omit to keep"`
	About              *string `json:"about,omitempty" jsonschema:"new description; omit to keep"`
	DefaultPermissions *uint32 `json:"default_permissions,omitempty" jsonschema:"permissions of ordinary members; omit to keep"`
	Forum              *bool   `json:"forum,omitempty" jsonschema:"groups: true turns forum topics on (cannot be turned off)"`
}

type leaveChatInput struct {
	ChatID     int64 `json:"chat_id" jsonschema:"the group or channel"`
	NewOwnerID int64 `json:"new_owner_id,omitempty" jsonschema:"owner only: the admin who becomes owner; 0 picks the longest-serving admin"`
}

type exportInviteInput struct {
	ChatID     int64 `json:"chat_id" jsonschema:"the group or channel"`
	ExpiresAt  int64 `json:"expires_at,omitempty" jsonschema:"unix seconds when the link stops working; 0 never expires"`
	UsageLimit int32 `json:"usage_limit,omitempty" jsonschema:"how many users may join with it; 0 unlimited"`
}

type revokeInviteInput struct {
	ChatID int64  `json:"chat_id" jsonschema:"the group or channel"`
	Link   string `json:"link" jsonschema:"the invite link, as returned by get_invite_links"`
}

type topicsInput struct {
	ChatID int64  `json:"chat_id" jsonschema:"the forum group"`
	Cursor string `json:"cursor,omitempty" jsonschema:"opaque cursor from the previous page; empty for the first page"`
	Limit  int32  `json:"limit,omitempty" jsonschema:"1 to 500; 0 means 100"`
}

type createTopicInput struct {
	ChatID    int64  `json:"chat_id" jsonschema:"the forum group"`
	Title     string `json:"title" jsonschema:"the topic's title"`
	IconColor int32  `json:"icon_color,omitempty" jsonschema:"0xRRGGBB of the topic icon as a number; 0 for the default"`
	Icon      string `json:"icon,omitempty" jsonschema:"icon glyph name from the client's icon set; empty for the default"`
}

type editTopicInput struct {
	ChatID    int64   `json:"chat_id" jsonschema:"the forum group"`
	TopicID   int64   `json:"topic_id" jsonschema:"the topic"`
	Title     *string `json:"title,omitempty" jsonschema:"new title; omit to keep"`
	IconColor *int32  `json:"icon_color,omitempty" jsonschema:"new icon color 0xRRGGBB; omit to keep"`
	Icon      *string `json:"icon,omitempty" jsonschema:"new icon glyph name; omit to keep"`
	Pinned    *bool   `json:"pinned,omitempty" jsonschema:"admins: pin or unpin the topic; omit to keep"`
}

type setAdminInput struct {
	ChatID int64 `json:"chat_id" jsonschema:"the group or channel"`
	UserID int64 `json:"user_id" jsonschema:"the member"`
	Admin  bool  `json:"admin" jsonschema:"true promotes to admin; false demotes to member"`
}

type memberPermissionsInput struct {
	ChatID      int64  `json:"chat_id" jsonschema:"the group"`
	UserID      int64  `json:"user_id" jsonschema:"the member"`
	Permissions uint32 `json:"permissions" jsonschema:"the member's permissions"`
}

type muteInput struct {
	ChatID          int64 `json:"chat_id" jsonschema:"the chat"`
	DurationSeconds int32 `json:"duration_seconds,omitempty" jsonschema:"mute for this many seconds, 1 to 31622400; 0 (without forever) unmutes"`
	Forever         bool  `json:"forever,omitempty" jsonschema:"mute until unmuted"`
}

type pinDialogInput struct {
	ChatID int64 `json:"chat_id" jsonschema:"the chat"`
	Pinned bool  `json:"pinned" jsonschema:"true pins the chat on top of the list (at most 5); false unpins"`
}

type unreadMarkInput struct {
	ChatID int64 `json:"chat_id" jsonschema:"the chat"`
	Unread bool  `json:"unread" jsonschema:"true marks the chat unread; false clears the mark"`
}

// groupTools manage groups, channels, invite links and forum topics, and
// the user's own dialog list (mute, pin, unread mark). Deleting a group or
// channel for every member is left to the app: it cannot be undone and
// chat:write carries no warning at consent (ADR 0012).
func groupTools() []toolDef {
	return []toolDef{
		{"create_group", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "create_group", Description: "Create a group owned by the user, optionally with members and forum topics.", Annotations: additive},
				func(ctx context.Context, in createGroupInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.CreateGroup, &appv1.CreateGroupRequest{Title: in.Title, UserIds: in.UserIDs, Forum: in.Forum})
				})
		}},
		{"create_channel", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "create_channel", Description: "Create a channel owned by the user.", Annotations: additive},
				func(ctx context.Context, in createChannelInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.CreateChannel, &appv1.CreateChannelRequest{Title: in.Title, About: in.About})
				})
		}},
		{"add_members", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "add_members", Description: "Add users to a group or channel (where the user may add members).", Annotations: additive},
				func(ctx context.Context, in addMembersInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.AddMembers, &appv1.AddMembersRequest{ChatId: in.ChatID, UserIds: in.UserIDs})
				})
		}},
		{"remove_member", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "remove_member", Description: "Remove a member from a group or channel (admins), banning them unless ban is false.", Annotations: destructive},
				func(ctx context.Context, in removeMemberInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.RemoveMember, &appv1.RemoveMemberRequest{ChatId: in.ChatID, UserId: in.UserID, Ban: in.Ban})
				})
		}},
		{"update_chat_info", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "update_chat_info", Description: "Change a group's or channel's title, description, default member permissions (" + permissionBits + ") or turn forum topics on; omitted fields stay.", Annotations: destructive},
				func(ctx context.Context, in updateChatInfoInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.UpdateChatInfo, &appv1.UpdateChatInfoRequest{
						ChatId: in.ChatID, Title: in.Title, About: in.About, DefaultPermissions: in.DefaultPermissions, Forum: in.Forum,
					})
				})
		}},
		{"leave_chat", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "leave_chat", Description: "Leave a group or channel. An owner leaving hands ownership to an admin.", Annotations: destructive},
				func(ctx context.Context, in leaveChatInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.LeaveChat, &appv1.LeaveChatRequest{ChatId: in.ChatID, NewOwnerId: in.NewOwnerID})
				})
		}},
		{"export_invite_link", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "export_invite_link", Description: "Create an invite link to a group or channel; anyone holding it can join.", Annotations: additive},
				func(ctx context.Context, in exportInviteInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.ExportInviteLink, &appv1.ExportInviteLinkRequest{ChatId: in.ChatID, ExpiresAt: in.ExpiresAt, UsageLimit: in.UsageLimit})
				})
		}},
		{"get_invite_links", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_invite_links", Description: "Invite links of a group or channel the user may see.", Annotations: readOnly},
				func(ctx context.Context, in chatInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.GetInviteLinks, &appv1.GetInviteLinksRequest{ChatId: in.ChatID})
				})
		}},
		{"revoke_invite_link", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "revoke_invite_link", Description: "Stop an invite link from working.", Annotations: destructive},
				func(ctx context.Context, in revokeInviteInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.RevokeInviteLink, &appv1.RevokeInviteLinkRequest{ChatId: in.ChatID, Link: in.Link})
				})
		}},
		{"get_forum_topics", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_forum_topics", Description: "Topics of a forum group.", Annotations: readOnly},
				func(ctx context.Context, in topicsInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.GetForumTopics, &appv1.GetForumTopicsRequest{ChatId: in.ChatID, Cursor: in.Cursor, Limit: in.Limit})
				})
		}},
		{"create_forum_topic", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "create_forum_topic", Description: "Create a topic in a forum group.", Annotations: additive},
				func(ctx context.Context, in createTopicInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.CreateForumTopic, &appv1.CreateForumTopicRequest{
						ChatId: in.ChatID, Title: in.Title, IconColor: in.IconColor, Icon: in.Icon,
					})
				})
		}},
		{"edit_forum_topic", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "edit_forum_topic", Description: "Change a forum topic's title, icon or pin; omitted fields stay.", Annotations: destructive},
				func(ctx context.Context, in editTopicInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.EditForumTopic, &appv1.EditForumTopicRequest{
						ChatId: in.ChatID, TopicId: in.TopicID, Title: in.Title, IconColor: in.IconColor, Icon: in.Icon, Pinned: in.Pinned,
					})
				})
		}},
		{"set_admin", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "set_admin", Description: "Promote a member to admin of a group or channel, or demote an admin to member.", Annotations: destructive},
				func(ctx context.Context, in setAdminInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.SetAdmin, &appv1.SetAdminRequest{ChatId: in.ChatID, UserId: in.UserID, Admin: in.Admin})
				})
		}},
		{"set_member_permissions", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "set_member_permissions", Description: "Set one member's permissions in a group (" + permissionBits + ").", Annotations: destructive},
				func(ctx context.Context, in memberPermissionsInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.SetMemberPermissions, &appv1.SetMemberPermissionsRequest{
						ChatId: in.ChatID, UserId: in.UserID, Permissions: in.Permissions,
					})
				})
		}},
		{"set_dialog_mute", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "set_dialog_mute", Description: "Mute or unmute the user's notifications of a chat.", Annotations: idempotent},
				func(ctx context.Context, in muteInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.SetDialogMute, &appv1.SetDialogMuteRequest{
						ChatId: in.ChatID, DurationSeconds: in.DurationSeconds, Forever: in.Forever,
					})
				})
		}},
		{"set_dialog_pinned", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "set_dialog_pinned", Description: "Pin a chat on top of the user's chat list, or unpin it.", Annotations: idempotent},
				func(ctx context.Context, in pinDialogInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.SetDialogPinned, &appv1.SetDialogPinnedRequest{ChatId: in.ChatID, Pinned: in.Pinned})
				})
		}},
		{"set_dialog_unread_mark", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "set_dialog_unread_mark", Description: "Mark a chat as unread for the user, or clear the mark.", Annotations: idempotent},
				func(ctx context.Context, in unreadMarkInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.SetDialogUnreadMark, &appv1.SetDialogUnreadMarkRequest{ChatId: in.ChatID, Unread: in.Unread})
				})
		}},
	}
}

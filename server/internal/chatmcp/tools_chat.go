package chatmcp

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tool annotations of the chat tools.
var (
	readOnly    = &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: ptr(false)}
	additive    = &mcp.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(false)}
	idempotent  = &mcp.ToolAnnotations{DestructiveHint: ptr(false), IdempotentHint: true, OpenWorldHint: ptr(false)}
	destructive = &mcp.ToolAnnotations{DestructiveHint: ptr(true), OpenWorldHint: ptr(false)}
)

type noInput struct{}

type pageInput struct {
	Cursor string `json:"cursor,omitempty" jsonschema:"opaque cursor from the previous page; empty for the first page"`
	Limit  int32  `json:"limit,omitempty" jsonschema:"page size; 0 uses the default"`
}

type chatInput struct {
	ChatID int64 `json:"chat_id" jsonschema:"the chat"`
}

type membersInput struct {
	ChatID int64  `json:"chat_id" jsonschema:"the chat"`
	Query  string `json:"query,omitempty" jsonschema:"optional filter on name or username"`
	Cursor string `json:"cursor,omitempty" jsonschema:"opaque cursor from the previous page; empty for the first page"`
	Limit  int32  `json:"limit,omitempty" jsonschema:"page size; 0 uses the default"`
}

type historyInput struct {
	ChatID    int64  `json:"chat_id" jsonschema:"the chat"`
	OffsetSeq int64  `json:"offset_seq,omitempty" jsonschema:"page from this seq; 0 starts at the newest message"`
	Direction string `json:"direction,omitempty" jsonschema:"older (default): seq below offset_seq; newer: above it; around: a window around it"`
	Limit     int32  `json:"limit,omitempty" jsonschema:"number of messages; 0 uses the default"`
	TopicID   int64  `json:"topic_id,omitempty" jsonschema:"forum groups: only this topic; 0 for the whole chat"`
}

type searchInput struct {
	Query   string `json:"query" jsonschema:"words to find (accents optional)"`
	ChatID  int64  `json:"chat_id,omitempty" jsonschema:"search only this chat; 0 searches every chat"`
	TopicID int64  `json:"topic_id,omitempty" jsonschema:"with chat_id in a forum group: only this topic"`
	Cursor  string `json:"cursor,omitempty" jsonschema:"opaque cursor from the previous page"`
	Limit   int32  `json:"limit,omitempty" jsonschema:"1 to 50; 0 means 20"`
}

type searchUsersInput struct {
	Query string `json:"query" jsonschema:"name or username to look for"`
	Limit int32  `json:"limit,omitempty" jsonschema:"number of users; 0 uses the default"`
}

type usernameInput struct {
	Username string `json:"username" jsonschema:"username, with or without @"`
}

type usersInput struct {
	UserIDs []int64 `json:"user_ids" jsonschema:"ids of the users"`
}

type sendInput struct {
	ChatID     int64  `json:"chat_id" jsonschema:"the chat to post in"`
	Text       string `json:"text" jsonschema:"plain text; links, e-mails, @mentions and #hashtags are detected"`
	ReplyToSeq int64  `json:"reply_to_seq,omitempty" jsonschema:"seq of the message this replies to"`
	TopicID    int64  `json:"topic_id,omitempty" jsonschema:"forum groups: topic to post in; 0 for General"`
	Silent     bool   `json:"silent,omitempty" jsonschema:"deliver without a notification sound"`
}

type userInput struct {
	UserID int64 `json:"user_id" jsonschema:"the other user"`
}

type editInput struct {
	ChatID int64  `json:"chat_id" jsonschema:"the chat"`
	Seq    int64  `json:"seq" jsonschema:"the message (one the user sent)"`
	Text   string `json:"text" jsonschema:"the new text"`
}

type deleteInput struct {
	ChatID      int64   `json:"chat_id" jsonschema:"the chat"`
	Seqs        []int64 `json:"seqs" jsonschema:"the messages"`
	ForEveryone bool    `json:"for_everyone,omitempty" jsonschema:"delete for everyone where allowed; false hides them for the user only"`
}

type readInput struct {
	ChatID  int64 `json:"chat_id" jsonschema:"the chat"`
	MaxSeq  int64 `json:"max_seq" jsonschema:"highest seq read"`
	TopicID int64 `json:"topic_id,omitempty" jsonschema:"forum groups: the topic read; 0 reads every topic"`
}

type reactionInput struct {
	ChatID int64  `json:"chat_id" jsonschema:"the chat"`
	Seq    int64  `json:"seq" jsonschema:"the message"`
	Emoji  string `json:"emoji" jsonschema:"one emoji; empty removes the user's reaction"`
}

var directions = map[string]appv1.HistoryDirection{
	"":       appv1.HistoryDirection_HISTORY_DIRECTION_OLDER,
	"older":  appv1.HistoryDirection_HISTORY_DIRECTION_OLDER,
	"newer":  appv1.HistoryDirection_HISTORY_DIRECTION_NEWER,
	"around": appv1.HistoryDirection_HISTORY_DIRECTION_AROUND,
}

// randomID returns a random_id below 2^53 (ADR 0001) for a new message.
func randomID() (int64, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, fmt.Errorf("chatmcp: random_id: %w", err)
	}
	return int64(binary.BigEndian.Uint64(b[:])>>11) | 1, nil
}

func chatTools() []toolDef {
	return []toolDef{
		{"get_me", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_me", Description: "The signed-in user's own profile.", Annotations: readOnly},
				func(ctx context.Context, _ noInput) (any, error) {
					return callSelf(ctx, t)
				})
		}},
		{"list_chats", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "list_chats", Description: "The user's chats (dialogs), most recent first, with their last message and unread count.", Annotations: readOnly},
				func(ctx context.Context, in pageInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.GetDialogs, &appv1.GetDialogsRequest{Cursor: in.Cursor, Limit: in.Limit})
				})
		}},
		{"get_chat", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_chat", Description: "One chat the user is in: title, type, settings and the users it mentions.", Annotations: readOnly},
				func(ctx context.Context, in chatInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.GetChat, &appv1.GetChatRequest{ChatId: in.ChatID})
				})
		}},
		{"get_chat_members", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_chat_members", Description: "Members of a group or channel the user can see.", Annotations: readOnly},
				func(ctx context.Context, in membersInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.GetMembers, &appv1.GetMembersRequest{
						ChatId: in.ChatID, Query: in.Query, Cursor: in.Cursor, Limit: in.Limit,
					})
				})
		}},
		{"get_messages", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_messages", Description: "Messages of a chat the user is in, paged by seq (newest first by default), with the users they mention.", Annotations: readOnly},
				func(ctx context.Context, in historyInput) (any, error) {
					dir, ok := directions[in.Direction]
					if !ok {
						return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("direction must be older, newer or around"))
					}
					return call(ctx, t, t.h.cfg.Services.Messages.GetHistory, &appv1.GetHistoryRequest{
						ChatId: in.ChatID, OffsetSeq: in.OffsetSeq, Direction: dir, Limit: in.Limit, TopicId: in.TopicID,
					})
				})
		}},
		{"search_messages", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "search_messages", Description: "Find messages by words across the user's chats, or in one chat with chat_id. Vietnamese accents are optional.", Annotations: readOnly},
				func(ctx context.Context, in searchInput) (any, error) {
					if in.ChatID != 0 {
						return call(ctx, t, t.h.cfg.Services.Search.SearchChatMessages, &appv1.SearchChatMessagesRequest{
							ChatId: in.ChatID, Query: in.Query, Cursor: in.Cursor, Limit: in.Limit, TopicId: in.TopicID,
						})
					}
					return call(ctx, t, t.h.cfg.Services.Search.SearchMessages, &appv1.SearchMessagesRequest{
						Query: in.Query, Cursor: in.Cursor, Limit: in.Limit,
					})
				})
		}},
		{"search_users", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "search_users", Description: "Find people by name or username (as the app's search does).", Annotations: readOnly},
				func(ctx context.Context, in searchUsersInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.SearchUsers, &appv1.SearchUsersRequest{Query: in.Query, Limit: in.Limit})
				})
		}},
		{"resolve_username", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "resolve_username", Description: "The user or bot with this exact username, when its privacy lets the user find it.", Annotations: readOnly},
				func(ctx context.Context, in usernameInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.ResolveUsername, &appv1.ResolveUsernameRequest{Username: in.Username})
				})
		}},
		{"get_users", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_users", Description: "Profiles of users by id.", Annotations: readOnly},
				func(ctx context.Context, in usersInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.GetUsers, &appv1.GetUsersRequest{UserIds: in.UserIDs})
				})
		}},
		{"send_message", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "send_message", Description: "Send a text message as the user. Everyone in the chat sees it as written by the user.", Annotations: additive},
				func(ctx context.Context, in sendInput) (any, error) {
					id, err := randomID()
					if err != nil {
						return nil, err
					}
					return call(ctx, t, t.h.cfg.Services.Messages.SendMessage, &appv1.SendMessageRequest{
						ChatId: in.ChatID, Text: in.Text, ReplyToSeq: in.ReplyToSeq, TopicId: in.TopicID, Silent: in.Silent, RandomId: id,
					})
				})
		}},
		{"start_private_chat", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "start_private_chat", Description: "Open (or find) the one-to-one chat with a user; send_message then posts in it.", Annotations: idempotent},
				func(ctx context.Context, in userInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.CreatePrivate, &appv1.CreatePrivateRequest{UserId: in.UserID})
				})
		}},
		{"edit_message", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "edit_message", Description: "Replace the text of a message the user sent.", Annotations: destructive},
				func(ctx context.Context, in editInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.EditMessage, &appv1.EditMessageRequest{ChatId: in.ChatID, Seq: in.Seq, Text: in.Text})
				})
		}},
		{"delete_messages", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "delete_messages", Description: "Delete messages for the user, or for everyone where the user may (own messages, or as an admin).", Annotations: destructive},
				func(ctx context.Context, in deleteInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.DeleteMessages, &appv1.DeleteMessagesRequest{
						ChatId: in.ChatID, Seqs: in.Seqs, ForEveryone: in.ForEveryone,
					})
				})
		}},
		{"mark_read", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "mark_read", Description: "Mark a chat read up to max_seq (others may see the user's read receipt).", Annotations: idempotent},
				func(ctx context.Context, in readInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.ReadHistory, &appv1.ReadHistoryRequest{ChatId: in.ChatID, MaxSeq: in.MaxSeq, TopicId: in.TopicID})
				})
		}},
		{"set_reaction", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "set_reaction", Description: "Set or remove the user's reaction to a message.", Annotations: idempotent},
				func(ctx context.Context, in reactionInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.SetReaction, &appv1.SetReactionRequest{ChatId: in.ChatID, Seq: in.Seq, Emoji: in.Emoji})
				})
		}},
	}
}

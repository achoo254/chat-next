package chatmcp

import (
	"context"

	appv1 "app.local/server/gen/app/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type forwardInput struct {
	FromChatID int64   `json:"from_chat_id" jsonschema:"the chat the messages are in"`
	Seqs       []int64 `json:"seqs" jsonschema:"the messages to forward, oldest first"`
	ToChatID   int64   `json:"to_chat_id" jsonschema:"the chat to forward to"`
	ToTopicID  int64   `json:"to_topic_id,omitempty" jsonschema:"forum groups: topic in to_chat_id; 0 for General"`
	Silent     bool    `json:"silent,omitempty" jsonschema:"deliver without a notification sound"`
}

type copyInput struct {
	FromChatID int64   `json:"from_chat_id" jsonschema:"the chat the message is in"`
	Seq        int64   `json:"seq" jsonschema:"the message to copy"`
	ToChatID   int64   `json:"to_chat_id" jsonschema:"the chat to post the copy in"`
	Text       *string `json:"text,omitempty" jsonschema:"replaces the text or caption; omit to keep it"`
	ReplyToSeq int64   `json:"reply_to_seq,omitempty" jsonschema:"seq in to_chat_id the copy replies to"`
	ToTopicID  int64   `json:"to_topic_id,omitempty" jsonschema:"forum groups: topic in to_chat_id; 0 for General"`
	Silent     bool    `json:"silent,omitempty" jsonschema:"deliver without a notification sound"`
}

type pinInput struct {
	ChatID int64 `json:"chat_id" jsonschema:"the chat"`
	Seq    int64 `json:"seq" jsonschema:"the message"`
	Silent bool  `json:"silent,omitempty" jsonschema:"pin without notifying the members"`
}

type messageRefInput struct {
	ChatID int64 `json:"chat_id" jsonschema:"the chat"`
	Seq    int64 `json:"seq" jsonschema:"the message"`
}

type topicScopeInput struct {
	ChatID  int64 `json:"chat_id" jsonschema:"the chat"`
	TopicID int64 `json:"topic_id,omitempty" jsonschema:"forum groups: only this topic; 0 for the whole chat"`
}

type pinnedInput struct {
	ChatID    int64 `json:"chat_id" jsonschema:"the chat"`
	TopicID   int64 `json:"topic_id,omitempty" jsonschema:"forum groups: only this topic; 0 for the whole chat"`
	OffsetSeq int64 `json:"offset_seq,omitempty" jsonschema:"pinned messages below this seq; 0 starts at the newest"`
	Limit     int32 `json:"limit,omitempty" jsonschema:"1 to 100; 0 means 50"`
}

type reactionsInput struct {
	ChatID int64  `json:"chat_id" jsonschema:"the chat"`
	Seq    int64  `json:"seq" jsonschema:"the message"`
	Emoji  string `json:"emoji,omitempty" jsonschema:"only this emoji; empty lists every reaction"`
	Cursor string `json:"cursor,omitempty" jsonschema:"opaque cursor from the previous page; empty for the first page"`
	Limit  int32  `json:"limit,omitempty" jsonschema:"1 to 100; 0 means 50"`
}

func messageTools() []toolDef {
	return []toolDef{
		{"forward_messages", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "forward_messages", Description: "Forward messages to another chat as the user, with the forward header naming the original sender.", Annotations: additive},
				func(ctx context.Context, in forwardInput) (any, error) {
					ids := make([]int64, len(in.Seqs))
					for i := range ids {
						id, err := randomID()
						if err != nil {
							return nil, err
						}
						ids[i] = id
					}
					return call(ctx, t, t.h.cfg.Services.Messages.ForwardMessages, &appv1.ForwardMessagesRequest{
						FromChatId: in.FromChatID, Seqs: in.Seqs, ToChatId: in.ToChatID, RandomIds: ids, Silent: in.Silent, ToTopicId: in.ToTopicID,
					})
				})
		}},
		{"copy_message", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "copy_message", Description: "Post a message's content again as the user's own message, without the forward header.", Annotations: additive},
				func(ctx context.Context, in copyInput) (any, error) {
					id, err := randomID()
					if err != nil {
						return nil, err
					}
					return call(ctx, t, t.h.cfg.Services.Messages.CopyMessage, &appv1.CopyMessageRequest{
						FromChatId: in.FromChatID, Seq: in.Seq, ToChatId: in.ToChatID, RandomId: id, ReplyToSeq: in.ReplyToSeq,
						Text: in.Text, Silent: in.Silent, ToTopicId: in.ToTopicID,
					})
				})
		}},
		{"pin_message", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "pin_message", Description: "Pin a message in a chat (where the user may pin); members are notified unless silent.", Annotations: idempotent},
				func(ctx context.Context, in pinInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.PinMessage, &appv1.PinMessageRequest{ChatId: in.ChatID, Seq: in.Seq, Silent: in.Silent})
				})
		}},
		{"unpin_message", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "unpin_message", Description: "Unpin one pinned message.", Annotations: idempotent},
				func(ctx context.Context, in messageRefInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.UnpinMessage, &appv1.UnpinMessageRequest{ChatId: in.ChatID, Seq: in.Seq})
				})
		}},
		{"unpin_all_messages", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "unpin_all_messages", Description: "Unpin every pinned message of a chat, or of one forum topic.", Annotations: destructive},
				func(ctx context.Context, in topicScopeInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.UnpinAllMessages, &appv1.UnpinAllMessagesRequest{ChatId: in.ChatID, TopicId: in.TopicID})
				})
		}},
		{"get_pinned_messages", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_pinned_messages", Description: "Pinned messages of a chat the user can see, newest first.", Annotations: readOnly},
				func(ctx context.Context, in pinnedInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.GetPinnedMessages, &appv1.GetPinnedMessagesRequest{
						ChatId: in.ChatID, TopicId: in.TopicID, OffsetSeq: in.OffsetSeq, Limit: in.Limit,
					})
				})
		}},
		{"get_message_reactions", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_message_reactions", Description: "Who reacted to a message, newest first (in channels admins only).", Annotations: readOnly},
				func(ctx context.Context, in reactionsInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.GetMessageReactions, &appv1.GetMessageReactionsRequest{
						ChatId: in.ChatID, Seq: in.Seq, Emoji: in.Emoji, Cursor: in.Cursor, Limit: in.Limit,
					})
				})
		}},
		{"get_message_readers", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_message_readers", Description: "Members who read a message; only in small groups and for recent messages (failed_precondition otherwise).", Annotations: readOnly},
				func(ctx context.Context, in messageRefInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Messages.GetMessageReaders, &appv1.GetMessageReadersRequest{ChatId: in.ChatID, Seq: in.Seq})
				})
		}},
	}
}

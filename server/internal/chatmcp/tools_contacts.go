package chatmcp

import (
	"context"
	"errors"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type addContactInput struct {
	UserID   int64  `json:"user_id,omitempty" jsonschema:"a user the user can already see; set exactly one of user_id, username, email"`
	Username string `json:"username,omitempty" jsonschema:"exact username, with or without @"`
	Email    string `json:"email,omitempty" jsonschema:"exact e-mail address (found only when that user allows it)"`
}

type commonChatsInput struct {
	UserID int64  `json:"user_id" jsonschema:"the other user"`
	Cursor string `json:"cursor,omitempty" jsonschema:"opaque cursor from the previous page; empty for the first page"`
	Limit  int32  `json:"limit,omitempty" jsonschema:"1 to 100; 0 means 50"`
}

// contactTarget turns the one target of add_contact into its request.
func contactTarget(in addContactInput) (*appv1.AddContactRequest, error) {
	var req []*appv1.AddContactRequest
	if in.UserID != 0 {
		req = append(req, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: in.UserID}})
	}
	if in.Username != "" {
		req = append(req, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: in.Username}})
	}
	if in.Email != "" {
		req = append(req, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Email{Email: in.Email}})
	}
	if len(req) != 1 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("set exactly one of user_id, username and email"))
	}
	return req[0], nil
}

func contactTools() []toolDef {
	return []toolDef{
		{"get_contacts", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_contacts", Description: "The user's contact list.", Annotations: readOnly},
				func(ctx context.Context, in pageInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.GetContacts, &appv1.GetContactsRequest{Cursor: in.Cursor, Limit: in.Limit})
				})
		}},
		{"add_contact", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "add_contact", Description: "Add a user to the user's contacts (by id, username or e-mail). Contacts may see what the user's privacy settings show to contacts.", Annotations: idempotent},
				func(ctx context.Context, in addContactInput) (any, error) {
					req, err := contactTarget(in)
					if err != nil {
						return nil, err
					}
					return call(ctx, t, t.h.cfg.Services.Users.AddContact, req)
				})
		}},
		{"delete_contact", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "delete_contact", Description: "Remove a user from the user's contacts.", Annotations: destructive},
				func(ctx context.Context, in userInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.DeleteContact, &appv1.DeleteContactRequest{UserId: in.UserID})
				})
		}},
		{"block_user", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "block_user", Description: "Block a user: they can no longer write to the user in private.", Annotations: idempotent},
				func(ctx context.Context, in userInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.Block, &appv1.BlockRequest{UserId: in.UserID})
				})
		}},
		{"unblock_user", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "unblock_user", Description: "Unblock a user.", Annotations: idempotent},
				func(ctx context.Context, in userInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.Unblock, &appv1.UnblockRequest{UserId: in.UserID})
				})
		}},
		{"get_blocked_users", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_blocked_users", Description: "Users the user blocked, most recent first.", Annotations: readOnly},
				func(ctx context.Context, in pageInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Users.GetBlockedUsers, &appv1.GetBlockedUsersRequest{Cursor: in.Cursor, Limit: in.Limit})
				})
		}},
		{"get_common_chats", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_common_chats", Description: "Groups (and channels the user administers) that the user shares with another user.", Annotations: readOnly},
				func(ctx context.Context, in commonChatsInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Chats.GetCommonChats, &appv1.GetCommonChatsRequest{UserId: in.UserID, Cursor: in.Cursor, Limit: in.Limit})
				})
		}},
	}
}

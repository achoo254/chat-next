package rpc

import (
	"context"
	"errors"
	"fmt"

	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/protoids"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// InProcess holds the service handlers that act for a signed-in user. /rpc
// serves them behind its interceptors; the MCP endpoint calls them in
// process for a user it authenticated itself, so ownership checks, limits
// and validation live in one place for both.
type InProcess struct {
	Users    appv1connect.UsersServiceHandler
	Chats    appv1connect.ChatsServiceHandler
	Messages appv1connect.MessagesServiceHandler
	Search   appv1connect.SearchServiceHandler
	BotAdmin appv1connect.BotAdminServiceHandler
}

// NewInProcess builds the handlers from the same collaborators as /rpc.
func NewInProcess(d Deps) *InProcess {
	return &InProcess{
		Users:    &usersService{store: d.Store, chat: d.Chat, tenantID: d.TenantID, logger: d.Logger},
		Chats:    &chatsService{chat: d.Chat, logger: d.Logger},
		Messages: &messagesService{chat: d.Chat, bots: d.BotUpdates, logger: d.Logger},
		Search:   &searchService{chat: d.Chat, logger: d.Logger},
		BotAdmin: &botAdminService{bots: d.Bots, updates: d.BotUpdates, logger: d.Logger},
	}
}

// Invoke runs one handler method for the caller of sess, with the checks
// the /rpc interceptors would apply after authentication: an account
// waiting for deletion is refused, and the request and the response must
// keep the id contract (ADR 0001). Errors are connect errors, as /rpc
// would answer them.
func Invoke[Req, Resp any](ctx context.Context, sess store.Session,
	method func(context.Context, *connect.Request[Req]) (*connect.Response[Resp], error), msg *Req,
) (*Resp, error) {
	if sess.AccountLocked {
		return nil, errAccountPendingDeletion()
	}
	if err := checkIDs(msg); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	resp, err := method(context.WithValue(ctx, sessionKey{}, sess), connect.NewRequest(msg))
	if err != nil {
		return nil, err
	}
	if err := checkIDs(resp.Msg); err != nil {
		// Not a connect error: the caller logs it and answers an opaque
		// internal error, as idsInterceptor does.
		return nil, fmt.Errorf("rpc: response violates the id contract: %w", err)
	}
	return resp.Msg, nil
}

// checkIDs applies protoids.Check to a generated message.
func checkIDs(v any) error {
	msg, ok := v.(proto.Message)
	if !ok {
		return errors.New("rpc: not a protobuf message")
	}
	return protoids.Check(msg)
}

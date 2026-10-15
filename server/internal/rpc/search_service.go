package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// searchService implements SearchService on the chat core.
type searchService struct {
	appv1connect.UnimplementedSearchServiceHandler
	chat   *chat.Service
	logger *slog.Logger
}

func (s *searchService) SearchMessages(ctx context.Context, req *connect.Request[appv1.SearchMessagesRequest]) (*connect.Response[appv1.SearchMessagesResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SearchMessagesRequest) (*appv1.SearchMessagesResponse, error) {
		return s.chat.SearchMessages(ctx, me, m)
	})
}

func (s *searchService) SearchChatMessages(ctx context.Context, req *connect.Request[appv1.SearchChatMessagesRequest]) (*connect.Response[appv1.SearchChatMessagesResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SearchChatMessagesRequest) (*appv1.SearchChatMessagesResponse, error) {
		return s.chat.SearchChatMessages(ctx, me, m)
	})
}

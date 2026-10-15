package rpc

import (
	"context"
	"errors"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// messagesService implements MessagesService on the chat core. Inline
// buttons wait for the bot phase and stay Unimplemented.
type messagesService struct {
	appv1connect.UnimplementedMessagesServiceHandler
	chat   *chat.Service
	logger *slog.Logger
}

func (s *messagesService) SendMessage(ctx context.Context, req *connect.Request[appv1.SendMessageRequest]) (*connect.Response[appv1.SendMessageResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SendMessageRequest) (*appv1.SendMessageResponse, error) {
		return s.chat.SendMessage(ctx, me, m)
	})
}

func (s *messagesService) SendMedia(ctx context.Context, req *connect.Request[appv1.SendMediaRequest]) (*connect.Response[appv1.SendMediaResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SendMediaRequest) (*appv1.SendMediaResponse, error) {
		return s.chat.SendMedia(ctx, me, m)
	})
}

func (s *messagesService) SendAlbum(ctx context.Context, req *connect.Request[appv1.SendAlbumRequest]) (*connect.Response[appv1.SendAlbumResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SendAlbumRequest) (*appv1.SendAlbumResponse, error) {
		return s.chat.SendAlbum(ctx, me, m)
	})
}

func (s *messagesService) ForwardMessages(ctx context.Context, req *connect.Request[appv1.ForwardMessagesRequest]) (*connect.Response[appv1.ForwardMessagesResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ForwardMessagesRequest) (*appv1.ForwardMessagesResponse, error) {
		return s.chat.ForwardMessages(ctx, me, m)
	})
}

func (s *messagesService) CopyMessage(ctx context.Context, req *connect.Request[appv1.CopyMessageRequest]) (*connect.Response[appv1.CopyMessageResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CopyMessageRequest) (*appv1.CopyMessageResponse, error) {
		return s.chat.CopyMessage(ctx, me, m)
	})
}

func (s *messagesService) EditMessage(ctx context.Context, req *connect.Request[appv1.EditMessageRequest]) (*connect.Response[appv1.EditMessageResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.EditMessageRequest) (*appv1.EditMessageResponse, error) {
		return s.chat.EditMessage(ctx, me, m)
	})
}

func (s *messagesService) DeleteMessages(ctx context.Context, req *connect.Request[appv1.DeleteMessagesRequest]) (*connect.Response[appv1.DeleteMessagesResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.DeleteMessagesRequest) (*appv1.DeleteMessagesResponse, error) {
		ack, err := s.chat.DeleteMessages(ctx, me, m.GetChatId(), m.GetSeqs(), m.GetForEveryone())
		if err != nil {
			return nil, err
		}
		return &appv1.DeleteMessagesResponse{Ack: ack}, nil
	})
}

func (s *messagesService) ReadHistory(ctx context.Context, req *connect.Request[appv1.ReadHistoryRequest]) (*connect.Response[appv1.ReadHistoryResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ReadHistoryRequest) (*appv1.ReadHistoryResponse, error) {
		ack, err := s.chat.ReadHistory(ctx, me, m.GetChatId(), m.GetMaxSeq(), m.GetTopicId())
		if err != nil {
			return nil, err
		}
		return &appv1.ReadHistoryResponse{Ack: ack}, nil
	})
}

func (s *messagesService) PinMessage(ctx context.Context, req *connect.Request[appv1.PinMessageRequest]) (*connect.Response[appv1.PinMessageResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.PinMessageRequest) (*appv1.PinMessageResponse, error) {
		ack, err := s.chat.PinMessage(ctx, me, m.GetChatId(), m.GetSeq())
		if err != nil {
			return nil, err
		}
		return &appv1.PinMessageResponse{Ack: ack}, nil
	})
}

func (s *messagesService) UnpinMessage(ctx context.Context, req *connect.Request[appv1.UnpinMessageRequest]) (*connect.Response[appv1.UnpinMessageResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.UnpinMessageRequest) (*appv1.UnpinMessageResponse, error) {
		ack, err := s.chat.UnpinMessage(ctx, me, m.GetChatId(), m.GetSeq())
		if err != nil {
			return nil, err
		}
		return &appv1.UnpinMessageResponse{Ack: ack}, nil
	})
}

func (s *messagesService) SetReaction(ctx context.Context, req *connect.Request[appv1.SetReactionRequest]) (*connect.Response[appv1.SetReactionResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetReactionRequest) (*appv1.SetReactionResponse, error) {
		return s.chat.SetReaction(ctx, me, m.GetChatId(), m.GetSeq(), m.GetEmoji())
	})
}

func (s *messagesService) GetHistory(ctx context.Context, req *connect.Request[appv1.GetHistoryRequest]) (*connect.Response[appv1.GetHistoryResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetHistoryRequest) (*appv1.GetHistoryResponse, error) {
		return s.chat.GetHistory(ctx, me, m)
	})
}

func (s *messagesService) PressInlineButton(context.Context, *connect.Request[appv1.PressInlineButtonRequest]) (*connect.Response[appv1.PressInlineButtonResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("bots are not available yet"))
}

func (s *messagesService) GetLinkPreview(ctx context.Context, req *connect.Request[appv1.GetLinkPreviewRequest]) (*connect.Response[appv1.GetLinkPreviewResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetLinkPreviewRequest) (*appv1.GetLinkPreviewResponse, error) {
		return s.chat.GetLinkPreview(ctx, me, m.GetUrl())
	})
}

func (s *messagesService) GetMessageReaders(ctx context.Context, req *connect.Request[appv1.GetMessageReadersRequest]) (*connect.Response[appv1.GetMessageReadersResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetMessageReadersRequest) (*appv1.GetMessageReadersResponse, error) {
		return s.chat.GetMessageReaders(ctx, me, m.GetChatId(), m.GetSeq())
	})
}

func (s *messagesService) GetMessageReactions(ctx context.Context, req *connect.Request[appv1.GetMessageReactionsRequest]) (*connect.Response[appv1.GetMessageReactionsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetMessageReactionsRequest) (*appv1.GetMessageReactionsResponse, error) {
		return s.chat.GetMessageReactions(ctx, me, m)
	})
}

func (s *messagesService) UnpinAllMessages(ctx context.Context, req *connect.Request[appv1.UnpinAllMessagesRequest]) (*connect.Response[appv1.UnpinAllMessagesResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.UnpinAllMessagesRequest) (*appv1.UnpinAllMessagesResponse, error) {
		ack, err := s.chat.UnpinAllMessages(ctx, me, m.GetChatId(), m.GetTopicId())
		if err != nil {
			return nil, err
		}
		return &appv1.UnpinAllMessagesResponse{Ack: ack}, nil
	})
}

func (s *messagesService) GetPinnedMessages(ctx context.Context, req *connect.Request[appv1.GetPinnedMessagesRequest]) (*connect.Response[appv1.GetPinnedMessagesResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetPinnedMessagesRequest) (*appv1.GetPinnedMessagesResponse, error) {
		return s.chat.GetPinnedMessages(ctx, me, m)
	})
}

package rpc

import (
	"context"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/chat"
	"app.local/server/internal/media"
	"connectrpc.com/connect"
)

// mediaService implements MediaService. Without configured storage every
// call answers failed_precondition media_disabled.
type mediaService struct {
	appv1connect.UnimplementedMediaServiceHandler
	media  *media.Service
	chat   *chat.Service
	logger *slog.Logger
}

func (s *mediaService) enabled() error {
	if s.media == nil {
		return connect.NewError(connect.CodeFailedPrecondition, errMediaDisabled)
	}
	return nil
}

func (s *mediaService) CreateUpload(ctx context.Context, req *connect.Request[appv1.CreateUploadRequest]) (*connect.Response[appv1.CreateUploadResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CreateUploadRequest) (*appv1.CreateUploadResponse, error) {
		if err := s.enabled(); err != nil {
			return nil, err
		}
		return s.media.CreateUpload(ctx, me, m)
	})
}

func (s *mediaService) CompleteUpload(ctx context.Context, req *connect.Request[appv1.CompleteUploadRequest]) (*connect.Response[appv1.CompleteUploadResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.CompleteUploadRequest) (*appv1.CompleteUploadResponse, error) {
		if err := s.enabled(); err != nil {
			return nil, err
		}
		return s.media.CompleteUpload(ctx, me, m)
	})
}

func (s *mediaService) AbortUpload(ctx context.Context, req *connect.Request[appv1.AbortUploadRequest]) (*connect.Response[appv1.AbortUploadResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.AbortUploadRequest) (*appv1.AbortUploadResponse, error) {
		if err := s.enabled(); err != nil {
			return nil, err
		}
		if err := s.media.AbortUpload(ctx, me, m.GetUploadId()); err != nil {
			return nil, err
		}
		return &appv1.AbortUploadResponse{}, nil
	})
}

// urls authorizes and signs a batch; nil entries are unavailable.
func (s *mediaService) urls(ctx context.Context, me int64, reqs []*appv1.GetFileUrlRequest) ([]*appv1.FileUrlResult, error) {
	if err := s.enabled(); err != nil {
		return nil, err
	}
	if len(reqs) == 0 || len(reqs) > media.FileURLsMax {
		return nil, connect.NewError(connect.CodeInvalidArgument, errBadURLBatch)
	}
	if err := s.media.AllowURLs(me); err != nil {
		return nil, err
	}
	grants, err := s.chat.AuthorizeFiles(ctx, me, reqs)
	if err != nil {
		return nil, err
	}
	out := make([]*appv1.FileUrlResult, len(reqs))
	for i, g := range grants {
		if g == nil {
			out[i] = &appv1.FileUrlResult{Unavailable: true}
			continue
		}
		out[i] = s.media.SignURL(me, *g, reqs[i].GetSize())
	}
	return out, nil
}

func (s *mediaService) GetFileUrl(ctx context.Context, req *connect.Request[appv1.GetFileUrlRequest]) (*connect.Response[appv1.GetFileUrlResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetFileUrlRequest) (*appv1.GetFileUrlResponse, error) {
		res, err := s.urls(ctx, me, []*appv1.GetFileUrlRequest{m})
		if err != nil {
			return nil, err
		}
		if res[0].GetUnavailable() {
			return nil, media.ErrFileNotFound
		}
		return &appv1.GetFileUrlResponse{Url: res[0].GetUrl(), ExpiresAt: res[0].GetExpiresAt(), Size: res[0].GetSize()}, nil
	})
}

func (s *mediaService) GetFileUrls(ctx context.Context, req *connect.Request[appv1.GetFileUrlsRequest]) (*connect.Response[appv1.GetFileUrlsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetFileUrlsRequest) (*appv1.GetFileUrlsResponse, error) {
		res, err := s.urls(ctx, me, m.GetRequests())
		if err != nil {
			return nil, err
		}
		return &appv1.GetFileUrlsResponse{Results: res}, nil
	})
}

package rpc

import (
	"context"
	"log/slog"
	"strconv"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
)

// feedbackService implements FeedbackService: feedback from Settings and
// the web app's error reports.
type feedbackService struct {
	appv1connect.UnimplementedFeedbackServiceHandler
	chat   *chat.Service
	logger *slog.Logger
}

func (s *feedbackService) SendFeedback(ctx context.Context, req *connect.Request[appv1.SendFeedbackRequest]) (*connect.Response[appv1.SendFeedbackResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SendFeedbackRequest) (*appv1.SendFeedbackResponse, error) {
		return &appv1.SendFeedbackResponse{}, s.chat.SendFeedback(ctx, me, m)
	})
}

// ReportClientError runs with or without a session (signedOutProcedures):
// the rate limit is per user when signed in, else per client address.
func (s *feedbackService) ReportClientError(ctx context.Context, req *connect.Request[appv1.ReportClientErrorRequest]) (*connect.Response[appv1.ReportClientErrorResponse], error) {
	key := "ip:" + auth.ClientIP(req.Peer().Addr, req.Header())
	if sess, ok := sessionFrom(ctx); ok {
		key = "user:" + strconv.FormatInt(sess.UserID, 10)
	}
	if err := s.chat.RecordClientError(ctx, key, req.Msg); err != nil {
		return nil, fail(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.ReportClientErrorResponse{}), nil
}

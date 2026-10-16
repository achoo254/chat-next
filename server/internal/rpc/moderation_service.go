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

// moderationService implements ModerationService on the chat core, which
// checks that the caller is an operator.
type moderationService struct {
	appv1connect.UnimplementedModerationServiceHandler
	chat     *chat.Service
	feedback FeedbackReplier
	logger   *slog.Logger
}

// FeedbackReplier sends an operator's answer to a feedback item (the
// assistant bot).
type FeedbackReplier interface {
	Reply(ctx context.Context, operator, feedbackID int64, text string) (*appv1.Feedback, error)
}

func (s *moderationService) GetReports(ctx context.Context, req *connect.Request[appv1.GetReportsRequest]) (*connect.Response[appv1.GetReportsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetReportsRequest) (*appv1.GetReportsResponse, error) {
		return s.chat.GetReports(ctx, me, m)
	})
}

func (s *moderationService) GetReport(ctx context.Context, req *connect.Request[appv1.GetReportRequest]) (*connect.Response[appv1.GetReportResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetReportRequest) (*appv1.GetReportResponse, error) {
		return s.chat.GetReport(ctx, me, m.GetReportId())
	})
}

func (s *moderationService) ResolveReport(ctx context.Context, req *connect.Request[appv1.ResolveReportRequest]) (*connect.Response[appv1.ResolveReportResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ResolveReportRequest) (*appv1.ResolveReportResponse, error) {
		return s.chat.ResolveReport(ctx, me, m)
	})
}

func (s *moderationService) LiftRestriction(ctx context.Context, req *connect.Request[appv1.LiftRestrictionRequest]) (*connect.Response[appv1.LiftRestrictionResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.LiftRestrictionRequest) (*appv1.LiftRestrictionResponse, error) {
		return &appv1.LiftRestrictionResponse{}, s.chat.LiftRestriction(ctx, me, m.GetUserId(), m.GetNote())
	})
}

func (s *moderationService) GetFeedback(ctx context.Context, req *connect.Request[appv1.GetFeedbackRequest]) (*connect.Response[appv1.GetFeedbackResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetFeedbackRequest) (*appv1.GetFeedbackResponse, error) {
		return s.chat.GetFeedback(ctx, me, m)
	})
}

func (s *moderationService) ResolveFeedback(ctx context.Context, req *connect.Request[appv1.ResolveFeedbackRequest]) (*connect.Response[appv1.ResolveFeedbackResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ResolveFeedbackRequest) (*appv1.ResolveFeedbackResponse, error) {
		f, err := s.chat.ResolveFeedback(ctx, me, m.GetFeedbackId())
		if err != nil {
			return nil, err
		}
		return &appv1.ResolveFeedbackResponse{Feedback: f}, nil
	})
}

func (s *moderationService) ReplyFeedback(ctx context.Context, req *connect.Request[appv1.ReplyFeedbackRequest]) (*connect.Response[appv1.ReplyFeedbackResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ReplyFeedbackRequest) (*appv1.ReplyFeedbackResponse, error) {
		if s.feedback == nil {
			if !s.chat.IsOperator(me) {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("moderation is for operators only"))
			}
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("assistant_unavailable: the assistant bot is off"))
		}
		f, err := s.feedback.Reply(ctx, me, m.GetFeedbackId(), m.GetText())
		if err != nil {
			return nil, err
		}
		return &appv1.ReplyFeedbackResponse{Feedback: f}, nil
	})
}

func (s *moderationService) GetReportGroups(ctx context.Context, req *connect.Request[appv1.GetReportGroupsRequest]) (*connect.Response[appv1.GetReportGroupsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetReportGroupsRequest) (*appv1.GetReportGroupsResponse, error) {
		return s.chat.GetReportGroups(ctx, me, m)
	})
}

func (s *moderationService) GetModerationLog(ctx context.Context, req *connect.Request[appv1.GetModerationLogRequest]) (*connect.Response[appv1.GetModerationLogResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetModerationLogRequest) (*appv1.GetModerationLogResponse, error) {
		return s.chat.GetModerationLog(ctx, me, m)
	})
}

func (s *moderationService) GetBotReview(ctx context.Context, req *connect.Request[appv1.GetBotReviewRequest]) (*connect.Response[appv1.GetBotReviewResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.GetBotReviewRequest) (*appv1.GetBotReviewResponse, error) {
		return s.chat.GetBotReview(ctx, me, m.GetBotId())
	})
}

func (s *moderationService) GetBotReviews(ctx context.Context, req *connect.Request[appv1.GetBotReviewsRequest]) (*connect.Response[appv1.GetBotReviewsResponse], error) {
	return call(ctx, s.logger, req, func(me int64, _ *appv1.GetBotReviewsRequest) (*appv1.GetBotReviewsResponse, error) {
		return s.chat.GetBotReviews(ctx, me)
	})
}

func (s *moderationService) SetBotVerified(ctx context.Context, req *connect.Request[appv1.SetBotVerifiedRequest]) (*connect.Response[appv1.SetBotVerifiedResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.SetBotVerifiedRequest) (*appv1.SetBotVerifiedResponse, error) {
		review, err := s.chat.SetBotVerified(ctx, me, m)
		if err != nil {
			return nil, err
		}
		return &appv1.SetBotVerifiedResponse{Review: review}, nil
	})
}

func (s *moderationService) ReviewBotRestriction(ctx context.Context, req *connect.Request[appv1.ReviewBotRestrictionRequest]) (*connect.Response[appv1.ReviewBotRestrictionResponse], error) {
	return call(ctx, s.logger, req, func(me int64, m *appv1.ReviewBotRestrictionRequest) (*appv1.ReviewBotRestrictionResponse, error) {
		review, err := s.chat.ReviewBotRestriction(ctx, me, m)
		if err != nil {
			return nil, err
		}
		return &appv1.ReviewBotRestrictionResponse{Review: review}, nil
	})
}

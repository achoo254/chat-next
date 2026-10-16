package botapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/botupdates"
	"connectrpc.com/connect"
)

// The tenant's assistant bot (botadmin.EnsureSystemBot) has no token: its
// logic runs inside the api process and calls the Bot API methods below
// directly. They are the HTTP methods without HTTP: the same checks, the
// same rate limit tier and the same core send path, so consent, privacy
// and blocks apply to the assistant as to any bot.

// OutgoingMessage is a message the assistant sends (POST /messages fields).
type OutgoingMessage struct {
	ChatID      int64
	Text        string
	ReplyToSeq  int64
	ReplyMarkup *wire.ReplyMarkup
	// RandomID makes a retry return the first message instead of sending
	// again; derive it from what caused the message.
	RandomID int64
}

// errNotSystem refuses in-process calls for any bot but the assistant.
var errNotSystem = errors.New("botapi: only the system bot calls the Bot API in process")

// systemBot loads the assistant and applies its call budget.
func (s *Service) systemBot(ctx context.Context, botID int64) (*botadmin.Bot, error) {
	bot, err := s.admin.Live(ctx, botID)
	if err != nil {
		return nil, err
	}
	if !bot.System {
		return nil, errNotSystem
	}
	rules := tiers[bot.Tier()]
	if !s.limiter.Allow(rules.calls, fmt.Sprintf("botcall:%d", bot.ID)) {
		return nil, asConnect(errRateLimited(rules.calls))
	}
	return bot, nil
}

// SendAsSystemBot sends m as the assistant (sendMessage). Errors are
// Connect errors: no_consent is permission_denied, rate limits are
// resource_exhausted.
func (s *Service) SendAsSystemBot(ctx context.Context, botID int64, m OutgoingMessage) (*appv1.Message, error) {
	bot, err := s.systemBot(ctx, botID)
	if err != nil {
		return nil, err
	}
	msg, err := s.send(ctx, bot, sendMessageRequest{
		ChatID: m.ChatID, Text: m.Text, ReplyToSeq: m.ReplyToSeq, ReplyMarkup: m.ReplyMarkup, RandomID: m.RandomID,
		DisableLinkPreview: true,
	})
	if err != nil {
		return nil, asConnect(err)
	}
	return msg, nil
}

// AnswerAsSystemBot answers a button press of the assistant
// (answerCallback); answering twice is not an error.
func (s *Service) AnswerAsSystemBot(ctx context.Context, botID int64, callbackID, text string) error {
	bot, err := s.systemBot(ctx, botID)
	if err != nil {
		return err
	}
	err = s.updates.Answer(ctx, bot.ID, callbackID, botupdates.Answer{Text: text})
	if errors.Is(err, botupdates.ErrAnswered) {
		return nil
	}
	return err
}

// asConnect turns a Bot API error answer into the Connect error of the same
// meaning; other errors (already from the core) pass through.
func asConnect(err error) error {
	var ae *apiError
	if !errors.As(err, &ae) {
		return err
	}
	code := connect.CodeInternal
	switch ae.status {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnsupportedMediaType:
		code = connect.CodeInvalidArgument
	case http.StatusForbidden:
		code = connect.CodePermissionDenied
	case http.StatusNotFound:
		code = connect.CodeNotFound
	case http.StatusConflict:
		code = connect.CodeFailedPrecondition
	case http.StatusTooManyRequests:
		code = connect.CodeResourceExhausted
	case http.StatusServiceUnavailable:
		code = connect.CodeUnavailable
	}
	return connect.NewError(code, errors.New(ae.description))
}

// ParseMarkdown parses text written in the Bot API's markdown (an
// operator's announcement); a syntax error is invalid_argument.
func (s *Service) ParseMarkdown(text string) (string, []*appv1.MessageEntity, error) {
	out, ents, err := s.parseText(text, nil, "markdown")
	var ae *apiError
	if errors.As(err, &ae) {
		return "", nil, connect.NewError(connect.CodeInvalidArgument, errors.New(ae.description))
	}
	return out, ents, err
}

// InternalBulk is the bulk pace and daily cap of the internal tier (the
// assistant's announcements).
func InternalBulk() (pace, daily int) {
	r := bulkTiers[botadmin.TierInternal]
	return r.pace, r.daily
}

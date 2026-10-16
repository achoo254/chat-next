package botapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/chat"
)

// inlineResultRequest is one result of an inline answer: an article posts
// text, a photo, video or document the bot's file_id with an optional
// caption.
type inlineResultRequest struct {
	Type               string            `json:"type"`
	ID                 string            `json:"id"`
	Title              string            `json:"title"`
	Description        string            `json:"description"`
	ThumbnailFileID    string            `json:"thumbnail_file_id"`
	FileID             string            `json:"file_id"`
	Text               string            `json:"text"`
	Caption            string            `json:"caption"`
	Entities           []wire.Entity     `json:"entities"`
	ParseMode          string            `json:"parse_mode"`
	ReplyMarkup        *wire.ReplyMarkup `json:"reply_markup"`
	DisableLinkPreview bool              `json:"disable_link_preview"`
}

type inlineAnswerRequest struct {
	Results    []inlineResultRequest `json:"results"`
	CacheTime  int                   `json:"cache_time"`
	IsPersonal bool                  `json:"is_personal"`
	NextOffset string                `json:"next_offset"`
	Gallery    bool                  `json:"gallery"`
}

// answerInline answers an inline query (POST /inline/{id}:answer) within a
// minute of the update; the user waits up to 10 seconds for it.
func (s *Service) answerInline(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, ok := strings.CutSuffix(r.PathValue("action"), ":answer")
	if !ok || id == "" {
		return nil, errNotFound("unknown method")
	}
	var req inlineAnswerRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if req.Results == nil {
		return nil, errBadRequest("results is required (an empty list answers with no results)")
	}
	if len(req.Results) > chat.InlineResultsMax {
		return nil, errBadRequest("at most %d results", chat.InlineResultsMax)
	}
	answer := chat.InlineAnswer{NextOffset: req.NextOffset, Gallery: req.Gallery, CacheTime: req.CacheTime, Personal: req.IsPersonal}
	for i, res := range req.Results {
		body := res.Text
		if res.Type != chat.InlineArticle {
			if res.Text != "" {
				return nil, errBadRequest("results[%d]: a %s takes caption, not text", i, res.Type)
			}
			body = res.Caption
		} else if res.Caption != "" {
			return nil, errBadRequest("results[%d]: an article takes text, not caption", i)
		}
		text, ents, err := s.parseText(body, res.Entities, res.ParseMode)
		if err != nil {
			return nil, errBadRequest("results[%d]: %v", i, errorDescription(err))
		}
		markup, err := wire.ToMarkup(res.ReplyMarkup)
		if err != nil {
			return nil, errBadRequest("results[%d]: %v", i, err)
		}
		answer.Results = append(answer.Results, chat.InlineResult{
			ID: res.ID, Kind: res.Type, Title: res.Title, Description: res.Description, ThumbFileID: res.ThumbnailFileID,
			FileID: res.FileID, Text: text, Entities: ents, Markup: markup, NoLinkPreview: res.DisableLinkPreview,
		})
	}
	err := s.chat.AnswerInlineQuery(ctx, bot.ID, id, answer)
	if errors.Is(err, chat.ErrInlineQueryGone) {
		return nil, errBadRequest("the inline query is unknown, older than a minute or already answered")
	}
	if err != nil {
		return nil, err
	}
	s.updates.Wake(id)
	return true, nil
}

// errorDescription is the text of a Bot API error, or the error itself.
func errorDescription(err error) string {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.description
	}
	return err.Error()
}

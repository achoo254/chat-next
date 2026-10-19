package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// Inline mode of bots: a user types @bot query in a chat's composer. The
// query (with the user and the kind of chat, never its messages) reaches
// the bot as an inline_query update through the outbox, like a button
// press; the bot answers with results, which the client shows; the pick is
// posted by the user with via_bot_id. A query and its answer live
// InlineQueryTTL: the pick, and the downloads of the results' media
// (Access with ChatID 0, Seq the query's number), must happen meanwhile.

const (
	// BotUpdateInlineQuery is the update of an inline query.
	BotUpdateInlineQuery = "inline_query"
	kindInlineQuery      = "inline_query"

	// InlineQueryTTL bounds picking a result and fetching its media.
	InlineQueryTTL = media.InlineQueryTTL
	// InlineResultsMax bounds the results of one answer.
	InlineResultsMax = 50

	inlineQueryMax       = 256 // characters
	inlineOffsetMax      = 64  // bytes
	inlineResultIDMax    = 64  // bytes
	inlineTitleMax       = 128 // characters
	inlineDescriptionMax = 256 // characters
	inlineCacheDefault   = 300 // seconds
	inlineCacheMax       = 3600
	// inlineAnswerWithin bounds how late a bot may answer.
	inlineAnswerWithin = time.Minute
)

// Inline result kinds (Bot API "type").
const (
	InlineArticle  = "article"
	InlinePhoto    = "photo"
	InlineVideo    = "video"
	InlineDocument = "document"
)

var inlineMediaKinds = map[string]appv1.MediaKind{
	InlinePhoto:    appv1.MediaKind_MEDIA_KIND_PHOTO,
	InlineVideo:    appv1.MediaKind_MEDIA_KIND_VIDEO,
	InlineDocument: appv1.MediaKind_MEDIA_KIND_DOCUMENT,
}

var inlineKinds = map[string]appv1.InlineResultKind{
	InlineArticle:  appv1.InlineResultKind_INLINE_RESULT_KIND_ARTICLE,
	InlinePhoto:    appv1.InlineResultKind_INLINE_RESULT_KIND_PHOTO,
	InlineVideo:    appv1.InlineResultKind_INLINE_RESULT_KIND_VIDEO,
	InlineDocument: appv1.InlineResultKind_INLINE_RESULT_KIND_DOCUMENT,
}

var (
	// ErrInlineQueryGone reports an unknown, expired or answered query.
	ErrInlineQueryGone = errors.New("chat: unknown, expired or already answered inline query")
)

// BotInlineQuery is an inline query handed to the bot.
type BotInlineQuery struct {
	ID       string
	FromID   int64
	Query    string
	Offset   string
	ChatType string
}

// InlineAsk is a query waiting for the bot's answer, or holding it
// already (a cached answer).
type InlineAsk struct {
	ID       string
	BotID    int64
	Answered bool
}

// InlineQuery records me's query to a bot with inline mode on, typed in
// chatID, and hands it to the bot; an answer the bot let be reused is
// copied for me instead.
func (s *Service) InlineQuery(ctx context.Context, me int64, req *appv1.InlineQueryRequest) (*InlineAsk, error) {
	query, offset := req.GetQuery(), req.GetOffset()
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) > inlineQueryMax {
		return nil, errInvalid("query has more than %d characters", inlineQueryMax)
	}
	if !utf8.ValidString(offset) || len(offset) > inlineOffsetMax {
		return nil, errInvalid("offset has more than %d bytes", inlineOffsetMax)
	}
	botID := req.GetBotId()
	if err := s.allow(ctx, limitInline, "inline", me); err != nil {
		return nil, err
	}
	var placeholder string
	err := s.pool.QueryRow(ctx, `SELECT inline_placeholder FROM bots WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
		botID, s.cfg.TenantID).Scan(&placeholder)
	if isNoRows(err) {
		return nil, errNotFound("bot")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: inline bot: %w", err)
	}
	if placeholder == "" {
		return nil, errPrecondition("inline_off: the bot does not use inline mode")
	}
	var chatType string
	if err := func() error {
		c, m, err := s.activeChatFor(ctx, s.pool, req.GetChatId(), me, false)
		if err != nil {
			return err
		}
		if !c.can(m, permSend) {
			return errDenied("you cannot send messages in this chat")
		}
		chatType = c.Type
		if c.Type == typePrivate && c.peerOf(me) == botID {
			chatType = "sender"
		}
		return nil
	}(); err != nil {
		return nil, err
	}
	id, err := newCallbackID()
	if err != nil {
		return nil, err
	}
	// A reusable answer of the same query: a copy for me.
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO bot_inline_queries (id, tenant_id, bot_id, user_id, chat_id, chat_type, query, "offset", answered_at, results,
			file_ids, personal, cache_until)
		SELECT $1, tenant_id, bot_id, $2, $3, $4, query, "offset", now(), results, file_ids, personal, cache_until
		FROM bot_inline_queries
		WHERE bot_id = $5 AND tenant_id = $6 AND query = $7 AND "offset" = $8 AND answered_at IS NOT NULL
			AND cache_until > now() AND (NOT personal OR user_id = $2)
		ORDER BY created_at DESC LIMIT 1`,
		id, me, req.GetChatId(), chatType, botID, s.cfg.TenantID, query, offset)
	if err != nil {
		return nil, fmt.Errorf("chat: reuse inline answer: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return &InlineAsk{ID: id, BotID: botID, Answered: true}, nil
	}
	_, err = s.inTx(ctx, func(t *txn) error {
		ev := t.event(kindInlineQuery, req.GetChatId(), me)
		t.afterOutbox = append(t.afterOutbox, func(ctx context.Context) error {
			if _, err := t.tx.Exec(ctx, `
				INSERT INTO bot_inline_queries (id, tenant_id, bot_id, user_id, chat_id, chat_type, query, "offset", outbox_id)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				id, s.cfg.TenantID, botID, me, req.GetChatId(), chatType, query, offset, ev.OutboxID); err != nil {
				return fmt.Errorf("chat: record inline query: %w", err)
			}
			return nil
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &InlineAsk{ID: id, BotID: botID}, nil
}

// InlineAnswered reports whether the bot answered the query.
func (s *Service) InlineAnswered(ctx context.Context, queryID string) (bool, error) {
	var answered bool
	err := s.pool.QueryRow(ctx, `SELECT answered_at IS NOT NULL FROM bot_inline_queries WHERE id = $1`, queryID).Scan(&answered)
	if err != nil && !isNoRows(err) {
		return false, fmt.Errorf("chat: inline answer: %w", err)
	}
	return answered, nil
}

// InlineAnswer is a bot's answer to an inline query.
type InlineAnswer struct {
	Results    []InlineResult
	NextOffset string
	Gallery    bool
	// CacheTime is how long the answer may be reused for the same query
	// (seconds; 0 is the default, 300); Personal limits reuse to the user.
	CacheTime int
	Personal  bool
}

// InlineResult is one result as the bot gives it. Files are named by the
// bot's file ids; Text is the message text (article) or caption (media).
type InlineResult struct {
	ID, Kind, Title, Description string
	ThumbFileID                  string
	FileID                       string
	Text                         string
	Entities                     []*appv1.MessageEntity
	Markup                       *appv1.ReplyMarkup
	NoLinkPreview                bool
}

// storedResult is a result as kept with the query: what the client shows
// and what posting it sends.
type storedResult struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	Description string `json:"description"`
	// Thumb and Media are app.v1.MediaRef; Content an app.v1.Message
	// (entities, keyboard).
	Thumb         []byte `json:"thumb,omitempty"`
	Media         []byte `json:"media,omitempty"`
	FilePublicID  string `json:"file,omitempty"`
	Text          string `json:"text"`
	Content       []byte `json:"content,omitempty"`
	NoLinkPreview bool   `json:"no_link_preview,omitempty"`
}

type storedAnswer struct {
	Results    []storedResult `json:"results"`
	NextOffset string         `json:"next_offset,omitempty"`
	Gallery    bool           `json:"gallery,omitempty"`
}

// AnswerInlineQuery checks and stores the bot's answer to its query, asked
// at most a minute ago and not answered yet.
func (s *Service) AnswerInlineQuery(ctx context.Context, botID int64, queryID string, a InlineAnswer) error {
	if len(a.Results) > InlineResultsMax {
		return errInvalid("at most %d results", InlineResultsMax)
	}
	if !utf8.ValidString(a.NextOffset) || len(a.NextOffset) > inlineOffsetMax {
		return errInvalid("next_offset has more than %d bytes", inlineOffsetMax)
	}
	cache := a.CacheTime
	switch {
	case cache < 0 || cache > inlineCacheMax:
		return errInvalid("cache_time must be 0 to %d seconds", inlineCacheMax)
	case cache == 0:
		cache = inlineCacheDefault
	}
	_, err := s.inTx(ctx, func(t *txn) error {
		var pending bool
		err := t.tx.QueryRow(ctx, `
			SELECT answered_at IS NULL FROM bot_inline_queries
			WHERE id = $1 AND bot_id = $2 AND tenant_id = $3 AND created_at > now() - $4::interval FOR UPDATE`,
			queryID, botID, s.cfg.TenantID, inlineAnswerWithin.String()).Scan(&pending)
		if isNoRows(err) || (err == nil && !pending) {
			return ErrInlineQueryGone
		}
		if err != nil {
			return fmt.Errorf("chat: inline query: %w", err)
		}
		stored := storedAnswer{NextOffset: a.NextOffset, Gallery: a.Gallery}
		fileIDs := []int64{} // never NULL: the column is NOT NULL
		seen := map[string]bool{}
		for i, r := range a.Results {
			sr, files, err := s.checkInlineResult(ctx, t, botID, r)
			if err != nil {
				return errInvalid("results[%d]: %v", i, connectMessage(err))
			}
			if seen[sr.ID] {
				return errInvalid("results[%d]: id %q is used twice", i, sr.ID)
			}
			seen[sr.ID] = true
			stored.Results = append(stored.Results, sr)
			fileIDs = append(fileIDs, files...)
		}
		raw, err := json.Marshal(stored)
		if err != nil {
			return fmt.Errorf("chat: encode inline answer: %w", err)
		}
		slices.Sort(fileIDs)
		if _, err := t.tx.Exec(ctx, `
			UPDATE bot_inline_queries SET answered_at = now(), results = $2, file_ids = $3, personal = $4,
				cache_until = now() + $5::interval
			WHERE id = $1`, queryID, raw, slices.Compact(fileIDs), a.Personal, (time.Duration(cache) * time.Second).String()); err != nil {
			return fmt.Errorf("chat: store inline answer: %w", err)
		}
		return nil
	})
	return err
}

// connectMessage is an error's message without its connect code.
func connectMessage(err error) string {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Message()
	}
	return err.Error()
}

// checkInlineResult validates one result and returns it as stored, with
// the internal ids of its files.
func (s *Service) checkInlineResult(ctx context.Context, t *txn, botID int64, r InlineResult) (storedResult, []int64, error) {
	out := storedResult{ID: r.ID, Kind: r.Kind, NoLinkPreview: r.NoLinkPreview}
	switch {
	case r.ID == "" || len(r.ID) > inlineResultIDMax || !utf8.ValidString(r.ID):
		return out, nil, errInvalid("id must have 1 to %d bytes", inlineResultIDMax)
	case inlineKinds[r.Kind] == appv1.InlineResultKind_INLINE_RESULT_KIND_UNSPECIFIED:
		return out, nil, errInvalid("type must be article, photo, video or document")
	}
	title, err := cleanInlineText(r.Title, inlineTitleMax, "title")
	if err != nil {
		return out, nil, err
	}
	desc, err := cleanInlineText(r.Description, inlineDescriptionMax, "description")
	if err != nil {
		return out, nil, err
	}
	if r.Kind == InlineArticle && title == "" {
		return out, nil, errInvalid("an article needs a title")
	}
	out.Title, out.Description = title, desc
	text, ents, err := s.validateText(r.Text, r.Entities, r.Kind != InlineArticle)
	if err != nil {
		return out, nil, err
	}
	if err := s.checkMentions(ctx, botID, ents); err != nil {
		return out, nil, err
	}
	if r.Markup != nil {
		if r.Markup.GetInlineKeyboard() == nil {
			return out, nil, errInvalid("reply_markup must be an inline keyboard")
		}
		// The posted message is the user's, in a chat the bot need not be in:
		// a press could not reach the bot without telling it about the chat.
		for _, row := range r.Markup.GetInlineKeyboard().GetRows() {
			for _, b := range row.GetButtons() {
				if b.GetUrl() == "" {
					return out, nil, errInvalid("an inline result takes URL buttons only")
				}
			}
		}
		if err := s.validateBotMarkup(ctx, r.Markup); err != nil {
			return out, nil, err
		}
	}
	out.Text = text
	if c := (&appv1.Message{Entities: ents, ReplyMarkup: r.Markup}); proto.Size(c) > 0 {
		if out.Content, err = proto.Marshal(c); err != nil {
			return out, nil, fmt.Errorf("chat: encode inline result: %w", err)
		}
	}
	var files []int64
	attach := func(publicID string, want appv1.MediaKind) ([]byte, error) {
		f, err := t.attachableFile(ctx, botID, publicID)
		if err != nil {
			return nil, errInvalid("file %q is not a file of the bot", publicID)
		}
		if f.Ref().GetKind() != want {
			return nil, errInvalid("file %q is not a %s", publicID, strings.ToLower(strings.TrimPrefix(want.String(), "MEDIA_KIND_")))
		}
		files = append(files, f.ID)
		return proto.Marshal(f.Ref())
	}
	if want, ok := inlineMediaKinds[r.Kind]; ok {
		if r.FileID == "" {
			return out, nil, errInvalid("a %s needs file_id", r.Kind)
		}
		if out.Media, err = attach(r.FileID, want); err != nil {
			return out, nil, err
		}
		out.FilePublicID = r.FileID
	} else if r.FileID != "" {
		return out, nil, errInvalid("an article has no file_id")
	}
	if r.ThumbFileID != "" {
		if out.Thumb, err = attach(r.ThumbFileID, appv1.MediaKind_MEDIA_KIND_PHOTO); err != nil {
			return out, nil, err
		}
	}
	return out, files, nil
}

func cleanInlineText(s string, maxLen int, field string) (string, error) {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > maxLen || strings.ContainsAny(s, "\n\r") {
		return "", errInvalid("%s must be one line of at most %d characters", field, maxLen)
	}
	return s, nil
}

// loadInline returns me's answered query, at most InlineQueryTTL old.
func (s *Service) loadInline(ctx context.Context, q querier, me int64, queryID string) (int64, *storedAnswer, error) {
	var botID int64
	var raw []byte
	err := q.QueryRow(ctx, `
		SELECT bot_id, results FROM bot_inline_queries
		WHERE id = $1 AND user_id = $2 AND tenant_id = $3 AND answered_at IS NOT NULL AND created_at > now() - $4::interval`,
		queryID, me, s.cfg.TenantID, InlineQueryTTL.String()).Scan(&botID, &raw)
	if isNoRows(err) {
		return 0, nil, errNotFound("inline query")
	}
	if err != nil {
		return 0, nil, fmt.Errorf("chat: inline query: %w", err)
	}
	var a storedAnswer
	if err := json.Unmarshal(raw, &a); err != nil {
		return 0, nil, fmt.Errorf("chat: decode inline answer: %w", err)
	}
	return botID, &a, nil
}

// InlineResults is the answer to me's query as the client shows it.
func (s *Service) InlineResults(ctx context.Context, me int64, queryID string) (*appv1.InlineQueryResponse, error) {
	_, a, err := s.loadInline(ctx, s.pool, me, queryID)
	if err != nil {
		return nil, err
	}
	out := &appv1.InlineQueryResponse{QueryId: queryID, NextOffset: a.NextOffset, Gallery: a.Gallery}
	for _, r := range a.Results {
		res := &appv1.InlineResult{Id: r.ID, Kind: inlineKinds[r.Kind], Title: r.Title, Description: r.Description}
		for _, part := range []struct {
			raw []byte
			dst **appv1.MediaRef
		}{{r.Media, &res.Media}, {r.Thumb, &res.Thumbnail}} {
			if len(part.raw) == 0 {
				continue
			}
			ref := &appv1.MediaRef{}
			if err := proto.Unmarshal(part.raw, ref); err != nil {
				return nil, fmt.Errorf("chat: decode inline media: %w", err)
			}
			*part.dst = ref
		}
		out.Results = append(out.Results, res)
	}
	return out, nil
}

// SendInlineResult posts the result of me's inline query as me's message
// via the bot.
func (s *Service) SendInlineResult(ctx context.Context, me int64, req *appv1.SendInlineResultRequest) (*appv1.SendInlineResultResponse, error) {
	if req.GetRandomId() < 0 {
		return nil, errInvalid("random_id must not be negative")
	}
	botID, a, err := s.loadInline(ctx, s.pool, me, req.GetQueryId())
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(a.Results, func(r storedResult) bool { return r.ID == req.GetResultId() })
	if i < 0 {
		return nil, errNotFound("inline result")
	}
	r := a.Results[i]
	var content appv1.Message
	if len(r.Content) > 0 {
		if err := proto.Unmarshal(r.Content, &content); err != nil {
			return nil, fmt.Errorf("chat: decode inline result: %w", err)
		}
	}
	// The message is the user's: mentions must be the user's to make.
	if err := s.checkMentions(ctx, me, content.GetEntities()); err != nil {
		return nil, err
	}
	if err := s.allow(ctx, limitSend, "send", me); err != nil {
		return nil, err
	}
	if r.FilePublicID == "" {
		resp, err := s.postText(ctx, me, textPost{
			chatID: req.GetChatId(), topicID: req.GetTopicId(), randomID: req.GetRandomId(), replyTo: req.GetReplyToSeq(),
			text: r.Text, ents: content.GetEntities(), noPreview: r.NoLinkPreview, markup: content.GetReplyMarkup(), viaBot: botID,
		})
		if err != nil {
			return nil, err
		}
		return &appv1.SendInlineResultResponse{Message: resp.GetMessage(), Ack: resp.GetAck()}, nil
	}
	if !s.mediaEnabled() {
		return nil, errMediaDisabled
	}
	resp, err := s.postMedia(ctx, me, mediaPost{
		chatID: req.GetChatId(), topicID: req.GetTopicId(), replyTo: req.GetReplyToSeq(), randomID: req.GetRandomId(),
		text: r.Text, ents: content.GetEntities(), markup: content.GetReplyMarkup(), viaBot: botID,
		// The bot's file, which the bot could attach when it answered.
		file: func(t *txn) (*media.File, error) { return media.LockFile(ctx, t.tx, s.cfg.TenantID, r.FilePublicID) },
	})
	if err != nil {
		return nil, err
	}
	return &appv1.SendInlineResultResponse{Message: resp.GetMessage(), Ack: resp.GetAck()}, nil
}

// inlineFileAccess finds, for the files of the requests in the
// inline_query_id context, me's live query that shows them.
func (s *Service) inlineFileAccess(ctx context.Context, me int64, reqs []*appv1.GetFileUrlRequest, out []*media.Access) error {
	var ids, queries []string
	var index []int64
	for i, r := range reqs {
		if q := r.GetInlineQueryId(); q != "" && media.ValidPublicID(r.GetFileId()) {
			ids, queries, index = append(ids, r.GetFileId()), append(queries, q), append(index, int64(i))
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT x.i, q.num, `+media.FileColumns+`
		FROM unnest($1::text[], $2::text[], $3::bigint[]) AS x(public_id, query_id, i)
		JOIN bot_inline_queries q ON q.id = x.query_id AND q.user_id = $4 AND q.tenant_id = $5 AND q.answered_at IS NOT NULL
			AND q.created_at > now() - $6::interval
		JOIN files f ON f.public_id = x.public_id AND f.tenant_id = $5 AND f.id = ANY(q.file_ids)`,
		ids, queries, index, me, s.cfg.TenantID, InlineQueryTTL.String())
	if err != nil {
		return fmt.Errorf("chat: authorize inline files: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var i, num int64
		f, err := media.ScanFile(prefixedRow{row: rows, head: []any{&i, &num}})
		if err != nil {
			return fmt.Errorf("chat: authorize inline files: %w", err)
		}
		if i >= 0 && int(i) < len(out) {
			out[i] = &media.Access{File: f, ChatID: 0, Seq: num}
		}
	}
	return rows.Err()
}

// botInlineUpdates builds the inline_query updates of the outbox rows ids.
func (s *Service) botInlineUpdates(ctx context.Context, rows []OutboxRow, ids []int64) ([]BotUpdate, error) {
	at := map[int64]time.Time{}
	for _, r := range rows {
		at[r.ID] = r.CreatedAt
	}
	list, err := s.pool.Query(ctx, `
		SELECT q.id, q.bot_id, q.user_id, q.query, q."offset", q.chat_type, q.outbox_id FROM bot_inline_queries q
		JOIN bots b ON b.user_id = q.bot_id
		WHERE q.outbox_id = ANY($1) AND b.deleted_at IS NULL AND b.tenant_id = $2 ORDER BY q.outbox_id`, ids, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: inline queries: %w", err)
	}
	type ask struct {
		q         BotInlineQuery
		bot, outb int64
	}
	asks, err := pgx.CollectRows(list, func(r pgx.CollectableRow) (ask, error) {
		var a ask
		err := r.Scan(&a.q.ID, &a.bot, &a.q.FromID, &a.q.Query, &a.q.Offset, &a.q.ChatType, &a.outb)
		return a, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: inline queries: %w", err)
	}
	if len(asks) == 0 {
		return nil, nil
	}
	var users []int64
	for _, a := range asks {
		users = append(users, a.q.FromID)
	}
	loaded, err := loadUsers(ctx, s.pool, s.cfg.TenantID, uniqueSorted(users))
	if err != nil {
		return nil, err
	}
	out := make([]BotUpdate, 0, len(asks))
	for _, a := range asks {
		u := loaded[a.q.FromID]
		if u == nil {
			continue
		}
		q := a.q
		out = append(out, BotUpdate{BotID: a.bot, OutboxID: a.outb, Kind: BotUpdateInlineQuery, At: at[a.outb],
			Users: []*appv1.User{u.render(a.bot, false)}, Inline: &q})
	}
	return out, nil
}

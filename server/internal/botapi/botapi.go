// Package botapi serves the HTTP Bot API v1 (spec/bot-api/openapi.yaml) at
// https://chat.<domain>/bot/v1/... inside the api process: JSON bodies,
// "Authorization: Bearer <bot_id>:<secret>", and one envelope for every
// answer, {"ok": true, "result": ...} or {"ok": false, "error": {"code",
// "description", "retry_after"}}. It only translates HTTP to the chat core,
// which enforces the bot rules (consent, membership, permissions); the
// gateway adds token checks and the rate limit tiers.
//
// Tokens never reach a log: they travel in a header only, and failures log
// the bot id at most. Failed authentications are limited per client
// address; a valid token is never refused by that limit.
package botapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/auth"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/format"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/botbulk"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/chat"
	"app.local/server/internal/media"
	"app.local/server/internal/ratelimit"
	"connectrpc.com/connect"
)

// Prefix is where the Bot API is mounted.
const Prefix = "/bot/"

// Limits and timings.
const (
	// BodyMax bounds a request body.
	BodyMax        = 1 << 20
	requestTimeout = 15 * time.Second
	updatesMax     = 100
	// authBlock is how long an address that used up its failed-auth budget
	// is refused.
	authBlock = time.Minute
	// maxSafeInt is 2^53: ids and random_id stay below it (ADR 0001).
	maxSafeInt = 1 << 53
)

// tierRules are the rate limits of one tier: every call, sends, and sends
// into one chat.
type tierRules struct {
	calls, send, perChat ratelimit.Rule
}

var tiers = map[string]tierRules{
	botadmin.TierDefault: {
		calls: ratelimit.Rule{Rate: 30, Burst: 60}, send: ratelimit.Rule{Rate: 30, Burst: 30},
		perChat: ratelimit.Rule{Rate: 1, Burst: 20},
	},
	botadmin.TierVerified: {
		calls: ratelimit.Rule{Rate: 100, Burst: 200}, send: ratelimit.Rule{Rate: 100, Burst: 100},
		perChat: ratelimit.Rule{Rate: 5, Burst: 50},
	},
	botadmin.TierInternal: {
		calls: ratelimit.Rule{Rate: 500, Burst: 1000}, send: ratelimit.Rule{Rate: 500, Burst: 500},
		perChat: ratelimit.Rule{Rate: 20, Burst: 200},
	},
	// A bot younger than 14 days, until it is verified.
	botadmin.TierNew: {
		calls: ratelimit.Rule{Rate: 10, Burst: 20}, send: ratelimit.Rule{Rate: 5, Burst: 10},
		perChat: ratelimit.Rule{Rate: 1, Burst: 10},
	},
	// Lowered by the anti-abuse rule or an operator.
	botadmin.TierRestricted: {
		calls: ratelimit.Rule{Rate: 5, Burst: 10}, send: ratelimit.Rule{Rate: 1, Burst: 3},
		perChat: ratelimit.Rule{Rate: 0.2, Burst: 3},
	},
}

// limitAuthFailures is the failed-auth budget of one client address.
var limitAuthFailures = ratelimit.Rule{Rate: 0.2, Burst: 20}

// Config holds the tenant settings.
type Config struct {
	TenantID string
	// PublicOrigin is the tenant's web origin (https://chat.<domain>); the
	// Bot API answers only on its host.
	PublicOrigin string
	// AppScheme is the app's own URL scheme allowed in links (ADR 0004).
	AppScheme string
}

// Typer relays a bot's chat action to the users viewing the chat (the
// realtime gateway's typing frames).
type Typer interface {
	BotTyping(botID, chatID, topicID int64, action appv1.TypingAction)
}

// Service is the Bot API handler.
type Service struct {
	cfg     Config
	host    string
	chat    *chat.Service
	admin   *botadmin.Service
	updates *botupdates.Service
	limiter ratelimit.Limiter
	logger  *slog.Logger
	mux     *http.ServeMux
	// media stores uploaded files and signs download URLs; nil when the
	// server has no media storage. typer relays chat actions; nil drops
	// them. Both are set before serving (UseMedia, UseTyper).
	media *media.Service
	typer Typer
	// bulk sends messages:bulk; nil answers 503 (UseBulk).
	bulk *botbulk.Service

	blockMu sync.Mutex
	blocked map[string]time.Time
}

// New returns the handler; mount it at Prefix.
func New(cfg Config, chatSvc *chat.Service, admin *botadmin.Service, updates *botupdates.Service, limiter ratelimit.Limiter, logger *slog.Logger) (*Service, error) {
	if chatSvc == nil || admin == nil || updates == nil || limiter == nil || logger == nil {
		return nil, errors.New("botapi: missing dependency")
	}
	u, err := url.Parse(cfg.PublicOrigin)
	if err != nil || u.Host == "" {
		return nil, errors.New("botapi: PublicOrigin must be an absolute URL")
	}
	s := &Service{
		cfg: cfg, host: strings.ToLower(u.Host), chat: chatSvc, admin: admin, updates: updates, limiter: limiter,
		logger: logger, mux: http.NewServeMux(), blocked: map[string]time.Time{},
	}
	s.mux.Handle("/bot/v1/me", s.method(http.MethodGet, s.getMe))
	s.mux.Handle("/bot/v1/messages", s.method(http.MethodPost, s.sendMessage))
	s.mux.Handle("/bot/v1/messages:edit", s.method(http.MethodPost, s.editMessage))
	s.mux.Handle("/bot/v1/messages:editMarkup", s.method(http.MethodPost, s.editMarkup))
	s.mux.Handle("/bot/v1/messages:delete", s.method(http.MethodPost, s.deleteMessages))
	s.mux.Handle("/bot/v1/messages:forward", s.method(http.MethodPost, s.forwardMessages))
	s.mux.Handle("/bot/v1/messages:copy", s.method(http.MethodPost, s.copyMessage))
	s.mux.Handle("/bot/v1/messages:react", s.method(http.MethodPost, s.react))
	s.mux.Handle("/bot/v1/messages:pin", s.method(http.MethodPost, s.pin))
	s.mux.Handle("/bot/v1/messages:unpin", s.method(http.MethodPost, s.unpin))
	s.mux.Handle("/bot/v1/messages:sendMedia", s.method(http.MethodPost, s.sendMedia))
	s.mux.Handle("/bot/v1/messages:sendAlbum", s.method(http.MethodPost, s.sendAlbum))
	s.mux.Handle("/bot/v1/messages:bulk", s.method(http.MethodPost, s.sendBulk))
	s.mux.Handle("/bot/v1/bulk/{bulk_id}", s.methods(map[string]call{
		http.MethodGet: s.getBulk, http.MethodDelete: s.cancelBulk,
	}))
	s.mux.Handle("/bot/v1/files/{file_id}", s.method(http.MethodGet, s.getFile))
	s.mux.Handle("/bot/v1/updates", s.method(http.MethodGet, s.getUpdates))
	s.mux.Handle("/bot/v1/callbacks/{action}", s.method(http.MethodPost, s.answerCallback))
	s.mux.Handle("/bot/v1/commands", s.method(http.MethodPut, s.setCommands))
	s.mux.Handle("/bot/v1/chats/{chat_id}", s.methods(map[string]call{
		http.MethodGet: s.getChat, http.MethodPatch: s.editChat, http.MethodPost: s.leaveChat,
	}))
	s.mux.Handle("/bot/v1/chats/{chat_id}/admins", s.method(http.MethodGet, s.getAdmins))
	s.mux.Handle("/bot/v1/chats/{chat_id}/members/{member}", s.methods(map[string]call{
		http.MethodGet: s.getMember, http.MethodPost: s.memberAction,
	}))
	s.mux.Handle("/bot/v1/chats/{chat_id}/actions", s.method(http.MethodPost, s.chatAction))
	s.mux.Handle("/bot/v1/webhook", s.methods(map[string]call{
		http.MethodGet: s.getWebhook, http.MethodPut: s.setWebhook, http.MethodDelete: s.deleteWebhook,
	}))
	s.mux.HandleFunc(Prefix, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, errNotFound("unknown method"))
	})
	return s, nil
}

// UseMedia connects the media service (file sends and downloads); call it
// before serving.
func (s *Service) UseMedia(m *media.Service) { s.media = m }

// UseTyper connects the realtime gateway for chat actions; call it before
// serving.
func (s *Service) UseTyper(t Typer) { s.typer = t }

// ServeHTTP implements http.Handler.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.onTenantHost(r) {
		writeError(w, errNotFound("unknown method"))
		return
	}
	s.mux.ServeHTTP(w, r)
}

// onTenantHost: the Bot API answers only on the tenant's chat host.
func (s *Service) onTenantHost(r *http.Request) bool {
	host := strings.ToLower(r.Host)
	if host == s.host {
		return true
	}
	if h, port, err := net.SplitHostPort(host); err == nil && (port == "443" || port == "80") {
		return h == s.host
	}
	return false
}

// ----------------------------------------------------------------- errors

// apiError is an error answer.
type apiError struct {
	status      int
	code        string
	description string
	retryAfter  int
}

func (e *apiError) Error() string { return e.code + ": " + e.description }

func errBadRequest(format string, args ...any) error {
	return &apiError{status: http.StatusBadRequest, code: "bad_request", description: fmt.Sprintf(format, args...)}
}

func errNotFound(description string) error {
	return &apiError{status: http.StatusNotFound, code: "not_found", description: description}
}

func errRateLimited(rule ratelimit.Rule) error {
	return &apiError{status: http.StatusTooManyRequests, code: "rate_limited", description: "too many requests; retry later",
		retryAfter: max(1, int(math.Ceil(1/rule.Rate)))}
}

var errInternal = &apiError{status: http.StatusInternalServerError, code: "internal", description: "internal error"}

// fromCore maps an error of the chat core or the bot services.
func (s *Service) fromCore(ctx context.Context, botID int64, err error) *apiError {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae
	}
	var ce *connect.Error
	if errors.As(err, &ce) {
		msg := ce.Message()
		switch ce.Code() {
		case connect.CodeInvalidArgument, connect.CodeFailedPrecondition, connect.CodeAlreadyExists:
			return &apiError{status: http.StatusBadRequest, code: "bad_request", description: msg}
		case connect.CodeNotFound:
			return &apiError{status: http.StatusNotFound, code: "not_found", description: msg}
		case connect.CodePermissionDenied:
			if rest, ok := strings.CutPrefix(msg, "no_consent: "); ok {
				return &apiError{status: http.StatusForbidden, code: "no_consent", description: rest}
			}
			return &apiError{status: http.StatusForbidden, code: "forbidden", description: msg}
		case connect.CodeResourceExhausted:
			return &apiError{status: http.StatusTooManyRequests, code: "rate_limited", description: msg, retryAfter: 1}
		default:
		}
	}
	if ctx.Err() != nil {
		return &apiError{status: http.StatusServiceUnavailable, code: "unavailable", description: "the request was cancelled"}
	}
	s.logger.Error("bot api call failed", "bot_id", botID, "err", err)
	return errInternal
}

// ------------------------------------------------------------- envelope

type envelope struct {
	OK     bool       `json:"ok"`
	Result any        `json:"result,omitempty"`
	Error  *errorBody `json:"error,omitempty"`
}

type errorBody struct {
	Code        string `json:"code"`
	Description string `json:"description"`
	RetryAfter  int    `json:"retry_after,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeResult(w http.ResponseWriter, result any) {
	writeJSON(w, http.StatusOK, envelope{OK: true, Result: result})
}

func writeError(w http.ResponseWriter, err error) {
	var ae *apiError
	if !errors.As(err, &ae) {
		ae = errInternal
	}
	if ae.retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(ae.retryAfter))
	}
	if ae.status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="bot"`)
	}
	writeJSON(w, ae.status, envelope{Error: &errorBody{Code: ae.code, Description: ae.description, RetryAfter: ae.retryAfter}})
}

// ---------------------------------------------------------------- calls

// call is an authenticated method: it returns the result or an error.
type call func(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error)

// method checks the HTTP method, authenticates the bot, applies its call
// budget and runs fn.
func (s *Service) method(verb string, fn call) http.Handler {
	return s.methods(map[string]call{verb: fn})
}

// methods is method for a path that answers several HTTP methods.
func (s *Service) methods(fns map[string]call) http.Handler {
	verbs := make([]string, 0, len(fns))
	for v := range fns {
		verbs = append(verbs, v)
	}
	slices.Sort(verbs)
	allow := strings.Join(verbs, ", ")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fn, ok := fns[r.Method]
		if !ok {
			w.Header().Set("Allow", allow)
			writeError(w, &apiError{status: http.StatusMethodNotAllowed, code: "method_not_allowed", description: "use " + allow})
			return
		}
		ctx := r.Context()
		if r.Method != http.MethodGet || r.URL.Path != "/bot/v1/updates" {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, requestTimeout)
			defer cancel()
		}
		token, ok := bearer(r.Header.Get("Authorization"))
		var bot *botadmin.Bot
		var err error
		if ok {
			bot, err = s.admin.Authenticate(ctx, token)
		}
		switch {
		case !ok || errors.Is(err, botadmin.ErrBadToken):
			// Only failures count and only failures are refused: a valid
			// token always passes, so bots sharing an address (NAT, one
			// host) cannot lock each other out.
			ip := auth.ClientIP(r.RemoteAddr, r.Header)
			if s.authFailed(ip) {
				writeError(w, &apiError{status: http.StatusTooManyRequests, code: "rate_limited",
					description: "too many failed authentications", retryAfter: int(authBlock.Seconds())})
				return
			}
			writeError(w, &apiError{status: http.StatusUnauthorized, code: "unauthorized",
				description: "missing or invalid bot token (Authorization: Bearer <token>)"})
			return
		case err != nil:
			writeError(w, s.fromCore(ctx, 0, err))
			return
		}
		rules := tiers[bot.Tier()]
		if !s.limiter.Allow(rules.calls, fmt.Sprintf("botcall:%d", bot.ID)) {
			writeError(w, errRateLimited(rules.calls))
			return
		}
		result, err := fn(chat.AsBot(ctx, bot.ID), r, bot)
		if err != nil {
			writeError(w, s.fromCore(ctx, bot.ID, err))
			return
		}
		writeResult(w, result)
	})
}

func bearer(header string) (string, bool) {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

// authFailed records a failed authentication of the address and reports
// whether the address is blocked: once its failed-auth budget is used up,
// its failures are answered 429 for authBlock (a block that is still
// running is not extended).
func (s *Service) authFailed(ip string) bool {
	s.blockMu.Lock()
	defer s.blockMu.Unlock()
	now := time.Now()
	if until, ok := s.blocked[ip]; ok {
		if now.Before(until) {
			return true
		}
		delete(s.blocked, ip)
	}
	if s.limiter.Allow(limitAuthFailures, "botauth:"+ip) {
		return false
	}
	if len(s.blocked) > 10000 {
		for k, until := range s.blocked {
			if now.After(until) {
				delete(s.blocked, k)
			}
		}
	}
	s.blocked[ip] = now.Add(authBlock)
	return true
}

// decode reads a JSON body into v (an empty body leaves v unchanged when
// allowEmpty).
func decode(r *http.Request, v any, allowEmpty bool) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, BodyMax+1))
	if err != nil {
		return errBadRequest("the body could not be read")
	}
	if len(body) > BodyMax {
		return &apiError{status: http.StatusRequestEntityTooLarge, code: "payload_too_large",
			description: fmt.Sprintf("the body is larger than %d KiB", BodyMax>>10)}
	}
	if len(bytes.TrimSpace(body)) == 0 && allowEmpty {
		return nil
	}
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		return &apiError{status: http.StatusUnsupportedMediaType, code: "unsupported_media_type",
			description: "send the body as application/json"}
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errBadRequest("invalid JSON body: %s", jsonProblem(err))
	}
	if dec.More() {
		return errBadRequest("invalid JSON body: trailing data")
	}
	return nil
}

// jsonProblem describes a decoding error without echoing payload values.
func jsonProblem(err error) string {
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) {
		return "syntax error at byte " + strconv.FormatInt(syntax.Offset, 10)
	}
	var typ *json.UnmarshalTypeError
	if errors.As(err, &typ) {
		return "field " + strconv.Quote(typ.Field) + " has the wrong type"
	}
	if msg := err.Error(); strings.HasPrefix(msg, "json: unknown field ") {
		return "unknown field " + strings.TrimPrefix(msg, "json: unknown field ")
	}
	return "unexpected end or shape"
}

func botUser(bot *botadmin.Bot) *appv1.User {
	return &appv1.User{Id: bot.ID, Username: bot.Username, Name: bot.Name, IsBot: true}
}

// ---------------------------------------------------------------- methods

// meResult is the bot's own profile.
type meResult struct {
	wire.User
	Privacy     bool   `json:"privacy"`
	Tier        string `json:"tier"`
	Description string `json:"description,omitempty"`
	About       string `json:"about,omitempty"`
}

func (s *Service) getMe(_ context.Context, _ *http.Request, bot *botadmin.Bot) (any, error) {
	return meResult{User: wire.FromUser(botUser(bot)), Privacy: bot.Privacy, Tier: bot.Tier(),
		Description: bot.Description, About: bot.About}, nil
}

type sendMessageRequest struct {
	ChatID             int64             `json:"chat_id"`
	TopicID            int64             `json:"topic_id"`
	Text               string            `json:"text"`
	Entities           []wire.Entity     `json:"entities"`
	ParseMode          string            `json:"parse_mode"`
	ReplyToSeq         int64             `json:"reply_to_seq"`
	ReplyMarkup        *wire.ReplyMarkup `json:"reply_markup"`
	RandomID           int64             `json:"random_id"`
	DisableLinkPreview bool              `json:"disable_link_preview"`
}

func (s *Service) sendMessage(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req sendMessageRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	sent, err := s.send(ctx, bot, req)
	if err != nil {
		return nil, err
	}
	return s.messageResult(ctx, bot, sent)
}

// send checks and sends a message of the bot (the sendMessage method, and
// the same method in a webhook answer).
func (s *Service) send(ctx context.Context, bot *botadmin.Bot, req sendMessageRequest) (*appv1.Message, error) {
	if err := checkID("chat_id", req.ChatID); err != nil {
		return nil, err
	}
	if err := checkRandomID(req.RandomID); err != nil {
		return nil, err
	}
	text, ents, err := s.parseText(req.Text, req.Entities, req.ParseMode)
	if err != nil {
		return nil, err
	}
	markup, err := wire.ToMarkup(req.ReplyMarkup)
	if err != nil {
		return nil, errBadRequest("%v", err)
	}
	if err := s.allowSend(bot, req.ChatID); err != nil {
		return nil, err
	}
	sent, err := s.chat.SendBotMessage(ctx, bot.ID, chat.BotMessage{
		ChatID: req.ChatID, TopicID: req.TopicID, Text: text, Entities: ents, ReplyTo: req.ReplyToSeq, Markup: markup,
		RandomID: req.RandomID, NoLinkPreview: req.DisableLinkPreview,
	})
	if err != nil {
		return nil, err
	}
	return sent.GetMessage(), nil
}

// checkID checks a required id field.
func checkID(name string, id int64) error {
	if id <= 0 || id >= maxSafeInt {
		return errBadRequest("%s is required (an integer from 1 to 2^53-1)", name)
	}
	return nil
}

func checkRandomID(id int64) error {
	if id < 0 || id >= maxSafeInt {
		return errBadRequest("random_id must be between 0 and 2^53-1")
	}
	return nil
}

// parseText turns text with entities or parse_mode (never both) into plain
// text and entities; the core checks the result like every message.
func (s *Service) parseText(text string, list []wire.Entity, parseMode string) (string, []*appv1.MessageEntity, error) {
	if parseMode != "" && len(list) > 0 {
		return "", nil, errBadRequest("send either entities or parse_mode")
	}
	var ents []*appv1.MessageEntity
	var err error
	switch parseMode {
	case "":
		if ents, err = wire.ToEntities(list); err != nil {
			return "", nil, errBadRequest("%v", err)
		}
		return text, ents, nil
	case "markdown":
		text, ents, err = format.Markdown(text, format.Options{AppScheme: s.cfg.AppScheme})
	case "html":
		text, ents, err = format.HTML(text, format.Options{AppScheme: s.cfg.AppScheme})
	default:
		return "", nil, errBadRequest(`parse_mode must be "markdown" or "html"`)
	}
	if err != nil {
		return "", nil, errBadRequest("cannot parse %s: %v", parseMode, err)
	}
	return text, ents, nil
}

// allowSend applies the bot's send limits: every send and sends into one
// chat (posts, edits, forwards, copies, media and pins).
func (s *Service) allowSend(bot *botadmin.Bot, chatID int64) error {
	rules := tiers[bot.Tier()]
	if !s.limiter.Allow(rules.send, fmt.Sprintf("botsend:%d", bot.ID)) {
		return errRateLimited(rules.send)
	}
	if !s.limiter.Allow(rules.perChat, fmt.Sprintf("botchat:%d:%d", bot.ID, chatID)) {
		return errRateLimited(rules.perChat)
	}
	return nil
}

// messageResult renders a message of a chat the bot is in.
func (s *Service) messageResult(ctx context.Context, bot *botadmin.Bot, m *appv1.Message) (any, error) {
	c, users, err := s.chat.GetChat(ctx, bot.ID, m.GetChatId())
	if err != nil {
		return nil, err
	}
	index := wire.IndexUsers(append(users, botUser(bot)))
	return wire.FromMessage(m, wire.FromChat(c, index), index), nil
}

func (s *Service) getUpdates(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	q := r.URL.Query()
	offset, err := intParam(q, "offset", 0, 0, maxSafeInt-1)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(q, "limit", updatesMax, 1, updatesMax)
	if err != nil {
		return nil, err
	}
	timeout, err := intParam(q, "timeout", 0, 0, int64(botupdates.LongPollMax.Seconds()))
	if err != nil {
		return nil, err
	}
	if raw, ok := q["allowed_updates"]; ok {
		var kinds []string
		for _, k := range strings.Split(strings.Join(raw, ","), ",") {
			if k = strings.TrimSpace(k); k != "" {
				kinds = append(kinds, k)
			}
		}
		if err := s.updates.SetPollAllowedUpdates(ctx, bot.ID, kinds); err != nil {
			return nil, webhookError(err)
		}
	}
	// The owner's chat with the bot and the Console tell whether a program runs the bot.
	if err := s.admin.RecordUpdateFetch(ctx, bot.ID); err != nil {
		s.logger.Warn("recording a bot's update fetch failed", "bot_id", bot.ID, "err", err)
	}
	list, err := s.updates.Poll(ctx, bot.ID, offset, int(limit), time.Duration(timeout)*time.Second)
	switch {
	case errors.Is(err, botupdates.ErrWebhookSet):
		return nil, &apiError{status: http.StatusConflict, code: "conflict",
			description: "a webhook is set; updates go there (DELETE /webhook to use getUpdates)"}
	case errors.Is(err, botupdates.ErrConflict):
		return nil, &apiError{status: http.StatusConflict, code: "conflict",
			description: "terminated by a newer getUpdates request of this bot"}
	case errors.Is(err, botupdates.ErrUnavailable):
		return nil, &apiError{status: http.StatusServiceUnavailable, code: "unavailable",
			description: "the server is restarting; retry later", retryAfter: int(botupdates.RetryAfterShutdown.Seconds())}
	}
	if err != nil {
		return nil, err
	}
	return list, nil
}

func intParam(q url.Values, name string, def, lo, hi int64) (int64, error) {
	raw := q.Get(name)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || v < lo || v > hi {
		return 0, errBadRequest("%s must be an integer from %d to %d", name, lo, hi)
	}
	return v, nil
}

type answerRequest struct {
	Text      string `json:"text"`
	ShowAlert bool   `json:"show_alert"`
	URL       string `json:"url"`
}

func (s *Service) answerCallback(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, ok := strings.CutSuffix(r.PathValue("action"), ":answer")
	if !ok || id == "" {
		return nil, errNotFound("unknown method")
	}
	var req answerRequest
	if err := decode(r, &req, true); err != nil {
		return nil, err
	}
	err := s.updates.Answer(ctx, bot.ID, id, botupdates.Answer{Text: req.Text, ShowAlert: req.ShowAlert, URL: req.URL})
	switch {
	case errors.Is(err, botupdates.ErrCallbackNotFound):
		return nil, errNotFound("unknown or expired callback")
	case errors.Is(err, botupdates.ErrAnswered):
		return nil, errBadRequest("the callback was already answered")
	case errors.Is(err, botupdates.ErrBadAnswer):
		return nil, errBadRequest("%s", strings.TrimPrefix(err.Error(), botupdates.ErrBadAnswer.Error()+": "))
	case err != nil:
		return nil, err
	}
	return true, nil
}

type setCommandsRequest struct {
	Scope    string             `json:"scope"`
	Commands []botadmin.Command `json:"commands"`
}

func (s *Service) setCommands(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req setCommandsRequest
	if err := decode(r, &req, false); err != nil {
		return nil, err
	}
	if req.Commands == nil {
		return nil, errBadRequest("commands is required (an empty list removes the scope)")
	}
	if err := s.admin.SetCommands(ctx, bot.ID, req.Scope, req.Commands); err != nil {
		return nil, err
	}
	return true, nil
}

func (s *Service) getChat(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	id, err := chatID(r)
	if err != nil {
		return nil, err
	}
	members, err := s.chat.MembersAmong(ctx, id, []int64{bot.ID})
	if err != nil {
		return nil, err
	}
	if len(members) == 0 {
		return nil, errNotFound("chat not found or the bot is not a member")
	}
	c, users, err := s.chat.GetChat(ctx, bot.ID, id)
	if err != nil {
		return nil, err
	}
	return wire.FromChat(c, wire.IndexUsers(users)), nil
}

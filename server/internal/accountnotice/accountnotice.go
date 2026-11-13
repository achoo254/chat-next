// Package accountnotice serves POST /api/account-notices: the IdP
// (auth-next) sends a security notice of one account, and the chat delivers
// it as a message of its assistant bot to the user holding that account
// (ADR 0015).
//
// It is mounted beside /rpc, not inside it: the caller is the IdP's server,
// with no Origin and no user session. The bearer is an access token the IdP
// signs for itself: typ at+jwt, aud this endpoint's URL, client_id
// auth-account-notices and scope account-notices; sub is the account.
//
// The answer never tells whether the account has a chat user: an unknown
// account, an assistant that is off and a user who blocked the assistant
// all get 204, as a delivered notice does. The token and the text never
// reach a log.
package accountnotice

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"app.local/server/internal/auth"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// Path is where the handler is mounted.
const Path = "/api/account-notices"

// ClientID and Scope are what the IdP's notice tokens carry.
const (
	ClientID = "auth-account-notices"
	Scope    = "account-notices"
)

// Limits.
const (
	// MaxTextRunes bounds a notice, in characters.
	MaxTextRunes = 2000
	// maxBodyBytes fits MaxTextRunes of any script, JSON-escaped.
	maxBodyBytes = 8 << 10
	// deliverTimeout bounds finding the user and sending the message.
	deliverTimeout = 10 * time.Second
)

// limitPerAccount bounds the notices of one account (30 a minute).
var limitPerAccount = ratelimit.Rule{Rate: 0.5, Burst: 30}

// TokenVerifier checks IdP access tokens offline (auth.IdP).
type TokenVerifier interface {
	VerifyAccessToken(ctx context.Context, raw, audience string) (auth.AccessToken, error)
}

// Users finds the chat user of an IdP account (store.Store).
type Users interface {
	UserByIdPSub(ctx context.Context, tenantID, sub string) (store.User, error)
}

// Notifier delivers the notice to a user (assistant.Service).
type Notifier interface {
	NotifyAccount(ctx context.Context, userID int64, text string) error
}

// Config holds the tenant settings.
type Config struct {
	TenantID string
	// Audience is the aud the notice tokens must carry: CHAT_PUBLIC_URL +
	// Path.
	Audience string
}

// Handler serves Path.
type Handler struct {
	cfg      Config
	users    Users
	tokens   TokenVerifier
	notifier Notifier
	limiter  ratelimit.Limiter
	logger   *slog.Logger
}

// New returns the handler. notifier is nil when the assistant is off:
// every valid notice is then answered 204 and dropped.
func New(cfg Config, users Users, tokens TokenVerifier, notifier Notifier, limiter ratelimit.Limiter, logger *slog.Logger) (*Handler, error) {
	if users == nil || tokens == nil || limiter == nil || logger == nil {
		return nil, errors.New("accountnotice: missing dependency")
	}
	if cfg.TenantID == "" || cfg.Audience == "" {
		return nil, errors.New("accountnotice: incomplete configuration")
	}
	return &Handler{cfg: cfg, users: users, tokens: tokens, notifier: notifier, limiter: limiter, logger: logger}, nil
}

// Register mounts the handler on mux (POST only; other methods get 405).
func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("POST "+Path, h)
}

type request struct {
	Text string `json:"text"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	tok, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if !h.limiter.Allow(limitPerAccount, "accountnotice:"+tok.Subject) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	text, status := readText(w, r)
	if status != 0 {
		writeError(w, status, "invalid_request")
		return
	}
	if h.notifier == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), deliverTimeout)
	defer cancel()
	user, err := h.users.UserByIdPSub(ctx, h.cfg.TenantID, tok.Subject)
	if errors.Is(err, store.ErrNotFound) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.logger.Error("account notice: find user failed", "err", err)
		writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	if err := h.notifier.NotifyAccount(ctx, user.ID, text); err != nil {
		// Only the code: an error of the send must not carry the text into
		// the log.
		h.logger.Error("account notice: delivery failed", "user_id", user.ID, "code", connect.CodeOf(err).String())
		writeError(w, http.StatusBadGateway, "delivery_failed")
		return
	}
	h.logger.Info("account notice handled", "user_id", user.ID)
	w.WriteHeader(http.StatusNoContent)
}

// authenticate verifies the bearer token and its client and scope; on
// failure it has answered.
func (h *Handler) authenticate(w http.ResponseWriter, r *http.Request) (auth.AccessToken, bool) {
	raw, ok := bearer(r.Header.Get("Authorization"))
	if !ok {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "invalid_token")
		return auth.AccessToken{}, false
	}
	tok, err := h.tokens.VerifyAccessToken(r.Context(), raw, h.cfg.Audience)
	if errors.Is(err, auth.ErrIdPUnavailable) {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return auth.AccessToken{}, false
	}
	if err != nil {
		h.logger.Debug("account notice token rejected", "err", err)
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		writeError(w, http.StatusUnauthorized, "invalid_token")
		return auth.AccessToken{}, false
	}
	if tok.ClientID != ClientID || !tok.HasScope(Scope) {
		h.logger.Warn("account notice token of another client or scope", "client_id", tok.ClientID)
		w.Header().Set("WWW-Authenticate", `Bearer error="insufficient_scope", scope="`+Scope+`"`)
		writeError(w, http.StatusForbidden, "insufficient_scope")
		return auth.AccessToken{}, false
	}
	return tok, true
}

// readText decodes the body and returns its trimmed text, or the status to
// answer with: 413 past maxBodyBytes, 400 for a body that is not
// {"text": "…"} with 1 to MaxTextRunes characters of valid UTF-8.
func readText(w http.ResponseWriter, r *http.Request) (string, int) {
	var req request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return "", http.StatusRequestEntityTooLarge
		}
		return "", http.StatusBadRequest
	}
	text := strings.TrimSpace(req.Text)
	if text == "" || !utf8.ValidString(text) || utf8.RuneCountInString(text) > MaxTextRunes {
		return "", http.StatusBadRequest
	}
	return text, 0
}

func bearer(header string) (string, bool) {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	// The body is a constant shape; a failed write only means the caller
	// left.
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

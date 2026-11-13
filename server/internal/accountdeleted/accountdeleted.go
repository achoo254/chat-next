// Package accountdeleted serves POST /api/idp/account-deleted: the IdP
// (auth-next) pushes a Security Event Token (RFC 8417, delivered as in
// RFC 8935) saying an account was deleted, and the chat erases the chat
// account of that sub at once (ADR 0016; auth-next ADR 0018). An account
// is deleted only at the IdP; the chat has no deletion of its own.
//
// It is mounted beside /rpc, not inside it: the caller is the IdP's server,
// with no Origin and no user session. The body is the SET itself
// (Content-Type application/secevent+jwt): ES256 from the IdP's JWKS, typ
// secevent+jwt, iss the IdP, aud this endpoint's URL, not expired, and the
// account.deleted event. There is no shared secret: the signature and the
// aud are enough.
//
// Answers: 202 once the account is erased, or its erasure is queued
// durably (the privacy job finishes it), and also for a sub with no chat
// account (never had one, or already erased), so retries are harmless;
// 400 for a body that is not a SET; 401 for a SET that fails verification
// (the IdP keeps retrying until the configuration is fixed); 503 before the
// IdP's discovery and 500 when the erasure could not even be queued, both
// retried by the IdP. The SET and the sub never reach a log.
package accountdeleted

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"app.local/server/internal/auth"
	"app.local/server/internal/privacy"
)

// Path is where the handler is mounted.
const Path = "/api/idp/account-deleted"

// Event is the SET event of a deleted IdP account.
const Event = "urn:hoandat:auth:event:account.deleted"

const (
	// maxBodyBytes bounds the SET (a few hundred bytes in practice).
	maxBodyBytes = 16 << 10
	// eraseTimeout bounds the erasure the request waits for; past it the
	// queued erasure is finished by the privacy job.
	eraseTimeout = 90 * time.Second
)

// Verifier checks SETs offline against the IdP's JWKS (auth.IdP).
type Verifier interface {
	VerifySecurityEvent(ctx context.Context, raw, audience, event string) (auth.SecurityEvent, error)
}

// Deleter erases the chat account of an IdP account (privacy.Service).
type Deleter interface {
	DeleteIdPAccount(ctx context.Context, sub string) (privacy.DeletionResult, error)
}

// Config holds the endpoint settings.
type Config struct {
	// Audience is the aud the SETs must carry: CHAT_PUBLIC_URL + Path.
	Audience string
}

// Handler serves Path.
type Handler struct {
	cfg      Config
	verifier Verifier
	deleter  Deleter
	logger   *slog.Logger
}

// New returns the handler.
func New(cfg Config, verifier Verifier, deleter Deleter, logger *slog.Logger) (*Handler, error) {
	if verifier == nil || deleter == nil || logger == nil {
		return nil, errors.New("accountdeleted: missing dependency")
	}
	if cfg.Audience == "" {
		return nil, errors.New("accountdeleted: incomplete configuration")
	}
	return &Handler{cfg: cfg, verifier: verifier, deleter: deleter, logger: logger}, nil
}

// Register mounts the handler on mux (POST only; other methods get 405).
func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("POST "+Path, h)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, ok := readSET(w, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	ev, err := h.verifier.VerifySecurityEvent(r.Context(), raw, h.cfg.Audience, Event)
	switch {
	case errors.Is(err, auth.ErrIdPUnavailable):
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	case errors.Is(err, auth.ErrNotSecurityEvent):
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	case err != nil:
		// The reason never holds the SET or its sub: at most the iss or aud
		// it carried, which name servers, not people.
		h.logger.Warn("account deletion event rejected", "err", err)
		writeError(w, http.StatusUnauthorized, "authentication_failed")
		return
	}

	// The erasure goes on when the IdP hangs up: it is queued already, and
	// finishing it now spares the job the work.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), eraseTimeout)
	defer cancel()
	res, err := h.deleter.DeleteIdPAccount(ctx, ev.Subject)
	if err != nil {
		h.logger.Error("account deletion event: queueing the erasure failed", "err", err)
		writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	switch {
	case res.UserID == 0:
		h.logger.Info("account deletion event: no chat account")
	case res.Erased:
		h.logger.Info("account deletion event: chat account erased", "user_id", res.UserID)
	default:
		h.logger.Warn("account deletion event: erasure queued for the job", "user_id", res.UserID)
	}
	w.WriteHeader(http.StatusAccepted)
}

// readSET returns the trimmed body, the compact JWS; false when it is
// empty, too large or not three dot-separated parts.
func readSET(w http.ResponseWriter, r *http.Request) (string, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		return "", false
	}
	raw := strings.TrimSpace(string(body))
	if raw == "" || strings.Count(raw, ".") != 2 {
		return "", false
	}
	return raw, true
}

// writeError answers in the error shape of RFC 8935 §2.3.
func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	// The body is a constant shape; a failed write only means the caller
	// left.
	_ = json.NewEncoder(w).Encode(map[string]string{"err": code})
}

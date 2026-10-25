// Package chatmcp serves the chat's MCP endpoint (/mcp): AI clients such as
// Claude Code act as the signed-in user with an access token of the IdP,
// whose aud is this resource (ADR 0012). Tools run the same service
// handlers as /rpc (rpc.InProcess), so they see and change only what the
// user could in the app.
package chatmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"app.local/server/internal/auth"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/rpc"
	"app.local/server/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// maxBodyBytes bounds one JSON-RPC message, like a /rpc request.
const maxBodyBytes = 1 << 20

// callRule bounds the MCP requests of one IdP account: 120 a minute.
var callRule = ratelimit.Rule{Rate: 2, Burst: 120}

// Config wires the endpoint.
type Config struct {
	// Resource is the resource indicator and token audience,
	// CHAT_PUBLIC_URL + "/mcp".
	Resource string
	// Issuer is the IdP (the authorization server of the metadata).
	Issuer string
	// ResourceName is shown by clients (brand name + " MCP").
	ResourceName string
	TenantID     string
	IdP          *auth.IdP
	Store        *store.Store
	Services     *rpc.InProcess
	Limiter      ratelimit.Limiter
	// AllowOrigin accepts a browser Origin; a request without one (every
	// non-browser MCP client) is always accepted.
	AllowOrigin func(origin string) bool
	// SessionKey keys the confirm tokens of bots:admin tools.
	SessionKey []byte
	Logger     *slog.Logger
}

// Handler serves /mcp and its Protected Resource Metadata.
type Handler struct {
	cfg         Config
	metadataURL string
	confirm     *confirmTokens
	toolScopes  map[string]string
	schemas     *mcp.SchemaCache
	mcp         http.Handler
}

// New returns the endpoint.
func New(cfg Config) (*Handler, error) {
	if cfg.IdP == nil || cfg.Store == nil || cfg.Services == nil || cfg.Limiter == nil || cfg.AllowOrigin == nil || cfg.Logger == nil {
		return nil, errors.New("chatmcp: IdP, store, services, limiter, origin check and logger are required")
	}
	if !strings.HasSuffix(cfg.Resource, "/mcp") || cfg.Issuer == "" {
		return nil, errors.New("chatmcp: resource must end in /mcp and the issuer is required")
	}
	confirm, err := newConfirmTokens(cfg.SessionKey)
	if err != nil {
		return nil, err
	}
	origin := strings.TrimSuffix(cfg.Resource, "/mcp")
	h := &Handler{
		cfg:         cfg,
		metadataURL: origin + metadataResourcePath,
		confirm:     confirm,
		toolScopes:  map[string]string{},
		schemas:     mcp.NewSchemaCache(),
	}
	for _, t := range allTools() {
		h.toolScopes[t.name] = t.scope
	}
	// serveMCP builds the request's server once (the SDK asks for it more
	// than once per request).
	h.mcp = mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		if s, ok := r.Context().Value(serverKey{}).(*mcp.Server); ok {
			return s
		}
		return h.newServer(caller{})
	}, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
		// nginx proxies to 127.0.0.1 with the public Host; the bearer token,
		// not the address, protects the endpoint.
		DisableLocalhostProtection: true,
		MaxRequestBodyBytes:        maxBodyBytes,
		Logger:                     cfg.Logger,
	})
	return h, nil
}

// Register mounts the endpoint on mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/mcp", h.serveMCP)
	for _, path := range []string{metadataPath, metadataResourcePath} {
		mux.HandleFunc("GET "+path, h.serveMetadata)
		mux.HandleFunc("OPTIONS "+path, h.serveMetadata)
	}
}

// caller is who an MCP request acts for.
type caller struct {
	token auth.AccessToken
	// user is the chat account of token.Subject; hasAccount is false when
	// the IdP account never signed in to the chat (no chat account yet).
	user       store.User
	hasAccount bool
}

// serverKey holds the MCP server built for one request's caller.
type serverKey struct{}

func (h *Handler) serveMCP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if origin := r.Header.Get("Origin"); origin != "" && !h.cfg.AllowOrigin(origin) {
		writeError(w, http.StatusForbidden, "origin_rejected", "origin not allowed")
		return
	}
	raw, ok := bearerToken(r)
	if !ok {
		h.challenge(w, http.StatusUnauthorized, "", "", baseScopes)
		return
	}
	tok, err := h.cfg.IdP.VerifyAccessToken(r.Context(), raw, h.cfg.Resource)
	if errors.Is(err, auth.ErrIdPUnavailable) {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "auth_unavailable", "sign-in is not available yet; retry shortly")
		return
	}
	if err != nil {
		h.cfg.Logger.Debug("MCP token rejected", "err", err)
		h.challenge(w, http.StatusUnauthorized, "invalid_token", "the access token is invalid or expired", baseScopes)
		return
	}
	if !slices.ContainsFunc(allScopes, tok.HasScope) {
		h.challenge(w, http.StatusForbidden, "insufficient_scope", "the token carries no chat scope", baseScopes)
		return
	}
	if !h.cfg.Limiter.Allow(callRule, "mcp:"+tok.Subject) {
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many MCP requests; slow down")
		return
	}
	if r.Method == http.MethodPost && !h.checkToolScope(w, r, tok) {
		return
	}
	c := caller{token: tok}
	u, err := h.cfg.Store.UserByIdPSub(r.Context(), h.cfg.TenantID, tok.Subject)
	switch {
	case err == nil:
		c.user, c.hasAccount = u, true
	case !errors.Is(err, store.ErrNotFound):
		h.cfg.Logger.Error("MCP caller lookup failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	h.mcp.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), serverKey{}, h.newServer(c))))
}

func bearerToken(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

// checkToolScope reads the JSON-RPC message (then puts it back for the SDK)
// and answers 403 with a step-up challenge when it calls a tool whose
// scope the token lacks: the client then asks the user for that scope. A
// batch is refused, as by Localman MCP. It reports whether to go on.
func (h *Handler) checkToolScope(w http.ResponseWriter, r *http.Request, tok auth.AccessToken) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", fmt.Sprintf("a message is at most %d bytes", maxBodyBytes))
		} else {
			writeError(w, http.StatusBadRequest, "bad_request", "could not read the request")
		}
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if trimmed := bytes.TrimLeft(body, " \t\r\n"); len(trimmed) > 0 && trimmed[0] == '[' {
		writeError(w, http.StatusBadRequest, "batch_not_supported", "send one JSON-RPC message per request")
		return false
	}
	method, name, ok := peekCall(body)
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_request", "the body must be exactly one JSON-RPC message object")
		return false
	}
	if method != "tools/call" {
		return true
	}
	need, known := h.toolScopes[name]
	if !known || tok.HasScope(need) {
		return true // unknown tools get the SDK's error; tools check their scope again
	}
	scopes := slices.DeleteFunc(slices.Clone(allScopes), func(s string) bool { return s != need && !tok.HasScope(s) })
	h.challenge(w, http.StatusForbidden, "insufficient_scope",
		fmt.Sprintf("tool %s needs the %s scope", name, need), scopes)
	return false
}

// peekCall reads the method and, for a tool call, the tool name of a
// JSON-RPC message. Keys match exactly (as the SDK reads them) and the body
// must hold one JSON object and nothing after it; ok is false otherwise.
func peekCall(body []byte) (method, name string, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	var msg map[string]json.RawMessage
	if dec.Decode(&msg) != nil || msg == nil {
		return "", "", false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return "", "", false
	}
	if raw, present := msg["method"]; present && json.Unmarshal(raw, &method) != nil {
		return "", "", false
	}
	if method != "tools/call" {
		return method, "", true
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(msg["params"], &params) != nil || json.Unmarshal(params["name"], &name) != nil {
		return "", "", false
	}
	return method, name, true
}

// session is the chat session the tools act with. approved marks a
// bots:admin call confirmed with its token, which stands in for the recent
// IdP sign-in those changes need in the app (ADR 0012).
func (c caller) session(tenantID string, approved bool) (store.Session, error) {
	if !c.hasAccount {
		return store.Session{}, errNoChatAccount
	}
	s := store.Session{
		TenantID: tenantID, UserID: c.user.ID, IdPClientID: c.token.ClientID,
		AccountLocked: c.user.DeletionRequestedAt != nil, Platform: store.PlatformWeb,
	}
	if approved {
		s.AuthTime = time.Now()
	}
	return s, nil
}

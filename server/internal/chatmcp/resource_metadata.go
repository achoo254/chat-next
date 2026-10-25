package chatmcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Scopes of the chat's MCP resource at the IdP (auth-next
// src/oidc/resources.ts, CHAT_MCP_SCOPES).
const (
	ScopeChatRead  = "chat:read"
	ScopeChatWrite = "chat:write"
	ScopeBotsRead  = "bots:read"
	ScopeBotsWrite = "bots:write"
	// ScopeBotsAdmin hands over a bot (webhook, token, deletion). A client
	// holds it only when it registered it and the user approved it on a
	// consent page that warns about it; its tools also need a confirm token.
	ScopeBotsAdmin = "bots:admin"
)

// baseScopes are asked for when a client connects (the 401 challenge);
// bots:admin is added only when a tool needs it (the 403 step-up).
var baseScopes = []string{ScopeChatRead, ScopeChatWrite, ScopeBotsRead, ScopeBotsWrite}

// allScopes are advertised in the resource metadata, so a client registers
// them all and can step up to bots:admin later.
var allScopes = append(append([]string{}, baseScopes...), ScopeBotsAdmin)

// Well-known paths of the Protected Resource Metadata (RFC 9728): the root
// one and the one for the /mcp resource path.
const (
	metadataPath         = "/.well-known/oauth-protected-resource"
	metadataResourcePath = metadataPath + "/mcp"
)

// resourceMetadata is the RFC 9728 document of the /mcp resource.
type resourceMetadata struct {
	Resource               string   `json:"resource"`
	AuthorizationServers   []string `json:"authorization_servers"`
	ScopesSupported        []string `json:"scopes_supported"`
	BearerMethodsSupported []string `json:"bearer_methods_supported"`
	ResourceName           string   `json:"resource_name"`
}

// serveMetadata answers the metadata document; public, cacheable and
// readable from any origin (clients discover it before they sign in).
func (h *Handler) serveMetadata(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(w, http.StatusOK, resourceMetadata{
		Resource:               h.cfg.Resource,
		AuthorizationServers:   []string{h.cfg.Issuer},
		ScopesSupported:        allScopes,
		BearerMethodsSupported: []string{"header"},
		ResourceName:           h.cfg.ResourceName,
	})
}

// challenge answers 401 or 403 with a Bearer challenge pointing at the
// metadata (RFC 6750 §3, RFC 9728 §5.1). oauthError is "" for a request
// without a token; scopes is what the client should ask for.
func (h *Handler) challenge(w http.ResponseWriter, status int, oauthError, description string, scopes []string) {
	params := []string{}
	if oauthError != "" {
		params = append(params, fmt.Sprintf(`error=%q`, quotable(oauthError)))
		if description != "" {
			params = append(params, fmt.Sprintf(`error_description=%q`, quotable(description)))
		}
	}
	if len(scopes) > 0 {
		params = append(params, fmt.Sprintf(`scope=%q`, strings.Join(scopes, " ")))
	}
	params = append(params, fmt.Sprintf(`resource_metadata=%q`, h.metadataURL))
	w.Header().Set("WWW-Authenticate", "Bearer "+strings.Join(params, ", "))
	code := "unauthenticated"
	switch {
	case oauthError == "invalid_token":
		code = "invalid_token"
	case status == http.StatusForbidden:
		code = "insufficient_scope"
	}
	writeError(w, status, code, description)
}

// quotable drops the characters a quoted-string cannot carry as is.
func quotable(s string) string {
	return strings.NewReplacer(`"`, "", `\`, "").Replace(s)
}

// httpError is the body of every non-MCP error of the endpoint.
type httpError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message,omitempty"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body httpError
	body.Error.Code, body.Error.Message = code, message
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

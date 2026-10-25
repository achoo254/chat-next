package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/api"
	"app.local/server/internal/config"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpToken signs an IdP access token for the chat's /mcp resource; mods
// change the claims (or the typ) to build bad tokens.
func (e *env) mcpToken(t *testing.T, scope string, mods ...func(claims map[string]any) string) string {
	t.Helper()
	claims := map[string]any{
		"iss": e.idp.Issuer(), "aud": e.srv.URL + "/mcp", "sub": "acc_test", "client_id": "dcr-client-1",
		"scope": scope, "iat": time.Now().Unix(), "exp": time.Now().Add(10 * time.Minute).Unix(),
	}
	typ := "at+jwt"
	for _, mod := range mods {
		if v := mod(claims); v != "" {
			typ = v
		}
	}
	tok, err := e.idp.Sign(claims, typ)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// bearerTransport adds the access token to every request of the MCP client.
type bearerTransport struct {
	base  http.RoundTripper
	token string
}

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.base.RoundTrip(r)
}

// mcpSession connects the SDK's own client to /mcp with token.
func (e *env) mcpSession(t *testing.T, token string) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "1"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:   e.srv.URL + "/mcp",
		HTTPClient: &http.Client{Transport: bearerTransport{base: e.srv.Client().Transport, token: token}},
	}
	cs, err := client.Connect(context.Background(), transport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

// callTool calls a tool and decodes its structured result; failed reports
// a tool error, whose text is returned in errText.
func callTool(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (out map[string]any, errText string) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if res.IsError {
		var b strings.Builder
		for _, c := range res.Content {
			if tc, ok := c.(*mcp.TextContent); ok {
				b.WriteString(tc.Text)
			}
		}
		return nil, b.String()
	}
	raw, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s: %s", name, raw)
	}
	return out, ""
}

// postMCP sends one raw JSON-RPC message and returns the response.
func (e *env) postMCP(t *testing.T, token, origin, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, e.srv.URL+"/mcp", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

const toolsCall = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":{}}}`

func TestMCPResourceMetadata(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"} {
		resp, err := e.srv.Client().Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		var meta struct {
			Resource             string   `json:"resource"`
			AuthorizationServers []string `json:"authorization_servers"`
			ScopesSupported      []string `json:"scopes_supported"`
		}
		err = json.NewDecoder(resp.Body).Decode(&meta)
		_ = resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, err)
		}
		if meta.Resource != e.srv.URL+"/mcp" || len(meta.AuthorizationServers) != 1 || meta.AuthorizationServers[0] != e.idp.Issuer() {
			t.Fatalf("%s: %+v", path, meta)
		}
		if strings.Join(meta.ScopesSupported, " ") != "chat:read chat:write bots:read bots:write bots:admin" {
			t.Fatalf("scopes_supported %v", meta.ScopesSupported)
		}
	}
}

// Every way in without a usable token is refused with a challenge that
// leads the client to the metadata and the IdP.
func TestMCPRefusals(t *testing.T) {
	e := newEnv(t)
	init := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	cases := []struct {
		name, token, origin string
		status              int
		challenge           string
	}{
		{"no token", "", "", http.StatusUnauthorized, `scope="chat:read chat:write bots:read bots:write"`},
		{"ID token typ", e.mcpToken(t, "chat:read", func(map[string]any) string { return "JWT" }), "", http.StatusUnauthorized, `error="invalid_token"`},
		{"other audience", e.mcpToken(t, "chat:read", func(c map[string]any) string { c["aud"] = "https://localman.example/mcp"; return "" }), "", http.StatusUnauthorized, `error="invalid_token"`},
		{"other issuer", e.mcpToken(t, "chat:read", func(c map[string]any) string { c["iss"] = "https://evil.example"; return "" }), "", http.StatusUnauthorized, `error="invalid_token"`},
		{"expired", e.mcpToken(t, "chat:read", func(c map[string]any) string { c["exp"] = time.Now().Add(-time.Minute).Unix(); return "" }), "", http.StatusUnauthorized, `error="invalid_token"`},
		{"no client_id", e.mcpToken(t, "chat:read", func(c map[string]any) string { delete(c, "client_id"); return "" }), "", http.StatusUnauthorized, `error="invalid_token"`},
		{"no chat scope", e.mcpToken(t, "mock:read"), "", http.StatusForbidden, `error="insufficient_scope"`},
		{"foreign origin", e.mcpToken(t, "chat:read"), "https://evil.example", http.StatusForbidden, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := e.postMCP(t, c.token, c.origin, init)
			if resp.StatusCode != c.status {
				t.Fatalf("status %d, want %d", resp.StatusCode, c.status)
			}
			got := resp.Header.Get("WWW-Authenticate")
			if c.challenge != "" && (!strings.Contains(got, c.challenge) || !strings.Contains(got, `resource_metadata="`+e.srv.URL+`/.well-known/oauth-protected-resource/mcp"`)) {
				t.Fatalf("WWW-Authenticate %q, want %q", got, c.challenge)
			}
		})
	}
}

// A tool whose scope the token lacks is answered 403 with the scope to ask
// for (step-up), before the call runs.
func TestMCPStepUpScope(t *testing.T) {
	e := newEnv(t)
	resp := e.postMCP(t, e.mcpToken(t, "chat:read bots:read"), "", strings.Replace(toolsCall, "%s", "send_message", 1))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got := resp.Header.Get("WWW-Authenticate"); !strings.Contains(got, `error="insufficient_scope"`) || !strings.Contains(got, `scope="chat:read chat:write bots:read"`) {
		t.Fatalf("WWW-Authenticate %q", got)
	}
	resp = e.postMCP(t, e.mcpToken(t, "chat:read"), "", `[`+strings.Replace(toolsCall, "%s", "get_me", 1)+`]`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("batch: status %d", resp.StatusCode)
	}
}

// Bodies that read differently to a lenient and a strict JSON parser never
// get a tool past its scope: the step-up check refuses what it cannot read
// exactly, and every tool checks its scope again.
func TestMCPScopeCannotBeBypassed(t *testing.T) {
	e := newEnv(t)
	e.signedIn(t)
	readOnly := e.mcpToken(t, "chat:read")
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))
	callTool(t, cs, "get_me", nil) // creates the user's saved chat
	dialogs, errText := callTool(t, cs, "list_chats", nil)
	if errText != "" {
		t.Fatal(errText)
	}
	chatID := mustJSON(t, firstChatID(t, dialogs))
	send := `"name":"send_message","arguments":{"chat_id":` + string(chatID) + `,"text":"bypass attempt"}`
	bodies := []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` + send + `,"Name":"get_me"}}`,
		`{"jsonrpc":"2.0","id":1,"Method":"ping","method":"tools/call","params":{` + send + `}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` + send + `}} garbage`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` + send + `}}{}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` + send + `,"name":"get_me"}}`,
	}
	for i, body := range bodies {
		resp := e.postMCP(t, readOnly, "", body)
		raw := new(bytes.Buffer)
		_, _ = raw.ReadFrom(resp.Body)
		// Refused, a tool error, or the other (read) tool ran: never a sent message.
		if resp.StatusCode == http.StatusOK && !strings.Contains(raw.String(), `"isError":true`) && !strings.Contains(raw.String(), "tester") {
			t.Errorf("body %d: %d %s", i, resp.StatusCode, raw)
		}
	}
	history, errText := callTool(t, cs, "get_messages", map[string]any{"chat_id": firstChatID(t, dialogs)})
	if errText != "" || strings.Contains(string(mustJSON(t, history)), "bypass attempt") {
		t.Fatalf("a read-only token sent a message: %s %s", mustJSON(t, history), errText)
	}
}

// The user reads and writes their chats through the tools, as in the app.
func TestMCPChatTools(t *testing.T) {
	e := newEnv(t)
	e.signedIn(t) // creates the chat account of acc_test
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read chat:write"))

	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) < 20 {
		t.Fatalf("only %d tools", len(tools.Tools))
	}

	me, errText := callTool(t, cs, "get_me", nil)
	if errText != "" || !strings.Contains(string(mustJSON(t, me)), `"username":"tester"`) {
		t.Fatalf("get_me: %v %s", me, errText)
	}
	dialogs, errText := callTool(t, cs, "list_chats", map[string]any{"limit": 20})
	if errText != "" {
		t.Fatal(errText)
	}
	chatID := firstChatID(t, dialogs)

	if _, errText := callTool(t, cs, "send_message", map[string]any{"chat_id": chatID, "text": "Xin chào từ MCP"}); errText != "" {
		t.Fatal(errText)
	}
	history, errText := callTool(t, cs, "get_messages", map[string]any{"chat_id": chatID, "limit": 5})
	if errText != "" || !strings.Contains(string(mustJSON(t, history)), "Xin chào từ MCP") {
		t.Fatalf("get_messages: %s %s", mustJSON(t, history), errText)
	}

	// Not a member: the service refuses, as /rpc would.
	if _, errText := callTool(t, cs, "get_messages", map[string]any{"chat_id": 999999}); !strings.Contains(errText, `"code":"`) {
		t.Fatalf("foreign chat: %q", errText)
	}
	if _, errText := callTool(t, cs, "get_messages", map[string]any{"chat_id": chatID, "direction": "sideways"}); !strings.Contains(errText, "invalid_argument") {
		t.Fatalf("bad direction: %q", errText)
	}
}

// An IdP account that never opened the chat has no chat account yet.
func TestMCPWithoutChatAccount(t *testing.T) {
	e := newEnv(t)
	cs := e.mcpSession(t, e.mcpToken(t, "chat:read", func(c map[string]any) string { c["sub"] = "acc_never_signed_in"; return "" }))
	if _, errText := callTool(t, cs, "get_me", nil); !strings.Contains(errText, "chat_account_required") {
		t.Fatalf("get_me: %q", errText)
	}
}

// bots:admin tools preview first and act only with the confirm token of
// that preview: same user, tool and arguments, once.
func TestMCPBotAdminConfirmation(t *testing.T) {
	e := newEnv(t, func(c *config.Config, _ *api.Options) { c.BotWebhookLocal = true })
	e.signedIn(t)
	cs := e.mcpSession(t, e.mcpToken(t, "bots:read bots:write bots:admin"))

	created, errText := callTool(t, cs, "create_bot", map[string]any{"username": "mcp_echo_bot", "name": "Echo"})
	if errText != "" {
		t.Fatal(errText)
	}
	botID := created["bot"].(map[string]any)["user"].(map[string]any)["id"]

	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	t.Cleanup(hook.Close)
	args := map[string]any{"bot_id": botID, "url": hook.URL + "/hook", "secret": "s3cret_value"}

	preview, errText := callTool(t, cs, "set_bot_webhook", args)
	if errText != "" {
		t.Fatal(errText)
	}
	token, _ := preview["confirm_token"].(string)
	if token == "" || strings.Contains(string(mustJSON(t, preview)), "s3cret_value") {
		t.Fatalf("preview: %s", mustJSON(t, preview))
	}
	delivery, _ := callTool(t, cs, "get_bot_delivery", map[string]any{"bot_id": botID})
	if strings.Contains(string(mustJSON(t, delivery)), hook.URL) {
		t.Fatal("the preview set the webhook")
	}

	// The token is bound to the arguments.
	other := map[string]any{"bot_id": botID, "url": hook.URL + "/other", "secret": "s3cret_value", "confirm_token": token}
	if _, errText := callTool(t, cs, "set_bot_webhook", other); !strings.Contains(errText, "confirm_token_invalid") {
		t.Fatalf("other arguments: %q", errText)
	}
	args["confirm_token"] = token
	if _, errText := callTool(t, cs, "set_bot_webhook", args); errText != "" {
		t.Fatalf("confirmed: %s", errText)
	}
	delivery, _ = callTool(t, cs, "get_bot_delivery", map[string]any{"bot_id": botID})
	if !strings.Contains(string(mustJSON(t, delivery)), hook.URL+"/hook") {
		t.Fatalf("webhook not set: %s", mustJSON(t, delivery))
	}
	if _, errText := callTool(t, cs, "set_bot_webhook", args); !strings.Contains(errText, "confirm_token_used") {
		t.Fatalf("reused token: %q", errText)
	}

	// A token is the user's: another account cannot spend it.
	reset, errText := callTool(t, cs, "reset_bot_token", map[string]any{"bot_id": botID})
	if errText != "" {
		t.Fatal(errText)
	}
	resetArgs := map[string]any{"bot_id": botID, "confirm_token": reset["confirm_token"]}
	otherUser := e.mcpSession(t, e.mcpToken(t, "bots:admin", func(c map[string]any) string { c["sub"] = "acc_other"; return "" }))
	if _, errText := callTool(t, otherUser, "reset_bot_token", resetArgs); !strings.Contains(errText, "confirm_token_invalid") {
		t.Fatalf("other user: %q", errText)
	}
	issued, errText := callTool(t, cs, "reset_bot_token", resetArgs)
	if newToken, _ := issued["token"].(string); errText != "" || newToken == "" {
		t.Fatalf("reset: %s", errText)
	}
	if bot := issued["bot"].(map[string]any); bot["webhook"] == true {
		t.Fatal("the webhook survived the token reset")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// firstChatID returns the id of the first dialog of a list_chats result.
func firstChatID(t *testing.T, dialogs map[string]any) any {
	t.Helper()
	list, _ := dialogs["dialogs"].([]any)
	if len(list) == 0 {
		t.Fatalf("no dialogs: %s", mustJSON(t, dialogs))
	}
	d, _ := list[0].(map[string]any)
	return d["chat_id"]
}

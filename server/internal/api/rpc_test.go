package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/ids"
	"connectrpc.com/connect"
)

func TestRPCOriginCheck(t *testing.T) {
	e := newEnv(t)
	_, c := e.signedIn(t)
	ctx := context.Background()
	for _, origin := range []string{"", "https://evil.example", "null"} {
		cl := e.rpc(c, origin)
		if _, err := getSelf(t, cl); codeOf(err) != connect.CodePermissionDenied {
			t.Errorf("GetSelf with Origin %q: %v", origin, err)
		}
		if _, err := cl.config.GetAppConfig(ctx, connect.NewRequest(&appv1.GetAppConfigRequest{})); codeOf(err) != connect.CodePermissionDenied {
			t.Errorf("GetAppConfig with Origin %q: %v", origin, err)
		}
	}
}

func TestRPCUnauthenticated(t *testing.T) {
	e := newEnv(t)
	c := e.browser(t)
	cl := e.rpc(c, e.srv.URL)
	if _, err := getSelf(t, cl); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("no cookie: %v", err)
	}
	// A forged cookie of the right shape and one of the wrong shape.
	for _, v := range []string{strings.Repeat("A", 43), "garbage"} {
		req := connect.NewRequest(&appv1.GetSelfRequest{})
		req.Header().Set("Cookie", auth.SessionCookieName+"="+v)
		if _, err := cl.users.GetSelf(context.Background(), req); codeOf(err) != connect.CodeUnauthenticated {
			t.Fatalf("cookie %q: %v", v, err)
		}
	}
	if _, err := cl.auth.ListSessions(context.Background(), connect.NewRequest(&appv1.ListSessionsRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("ListSessions: %v", err)
	}
}

func TestPublicRPCs(t *testing.T) {
	e := newEnv(t)
	cl := e.rpc(e.browser(t), e.srv.URL)
	ctx := context.Background()

	ac, err := cl.auth.GetAuthConfig(ctx, connect.NewRequest(&appv1.GetAuthConfigRequest{Platform: appv1.ClientPlatform_CLIENT_PLATFORM_ANDROID}))
	if err != nil {
		t.Fatal(err)
	}
	if ac.Msg.GetIssuer() != e.idp.Issuer() || ac.Msg.GetClientId() != auth.MobileClientID ||
		ac.Msg.GetAuthorizationEndpoint() != e.idp.Issuer()+"/authorize" || ac.Msg.GetTenantName() != "hoandat.com" ||
		strings.Join(ac.Msg.GetScopes(), " ") != "openid profile email" {
		t.Fatalf("GetAuthConfig = %v", ac.Msg)
	}
	web, err := cl.auth.GetAuthConfig(ctx, connect.NewRequest(&appv1.GetAuthConfigRequest{Platform: appv1.ClientPlatform_CLIENT_PLATFORM_WEB}))
	if err != nil || web.Msg.GetClientId() != clientID {
		t.Fatalf("web GetAuthConfig = %v, %v", web, err)
	}

	first, err := cl.config.GetAppConfig(ctx, connect.NewRequest(&appv1.GetAppConfigRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	cfg := first.Msg.GetConfig()
	if cfg == nil || cfg.GetHash() == "" || cfg.GetMessageLengthMax() != 4096 {
		t.Fatalf("GetAppConfig = %v", first.Msg)
	}
	again, err := cl.config.GetAppConfig(ctx, connect.NewRequest(&appv1.GetAppConfigRequest{Hash: cfg.GetHash()}))
	if err != nil || again.Msg.GetNotModified() == nil {
		t.Fatalf("GetAppConfig(hash) = %v, %v", again, err)
	}

	if _, err := cl.auth.ExchangeNativeCode(ctx, connect.NewRequest(&appv1.ExchangeNativeCodeRequest{})); codeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("ExchangeNativeCode: %v", err)
	}
}

func TestProfileRPCs(t *testing.T) {
	e := newEnv(t)
	alice, _ := e.signedIn(t)
	e.idp.SetAccount(idptest.Account{Sub: "acc_bob", SID: "sid-bob", PreferredUsername: "bob", Name: "Bob"})
	bob, _ := e.signedIn(t)
	ctx := context.Background()

	setUsername := func(cl clients, name string) (*appv1.User, error) {
		resp, err := cl.users.SetUsername(ctx, connect.NewRequest(&appv1.SetUsernameRequest{Username: name}))
		if err != nil {
			return nil, err
		}
		return resp.Msg.GetUser(), nil
	}
	if _, err := setUsername(bob, "tester"); codeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("taken username: %v", err)
	}
	if _, err := setUsername(bob, "TESTER"); codeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("taken username in another case: %v", err)
	}
	for _, bad := range []string{"ab", "bad name", "tên", strings.Repeat("x", 33)} {
		if _, err := setUsername(bob, bad); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("username %q: %v", bad, err)
		}
	}
	if u, err := setUsername(bob, " Bobby_1 "); err != nil || u.GetUsername() != "bobby_1" {
		t.Fatalf("SetUsername = %v, %v", u, err)
	}
	if u, err := setUsername(alice, "tester"); err != nil || u.GetUsername() != "tester" {
		t.Fatalf("SetUsername to own name = %v, %v", u, err)
	}

	update := func(name, bio *string) (*appv1.User, error) {
		resp, err := alice.users.UpdateProfile(ctx, connect.NewRequest(&appv1.UpdateProfileRequest{Name: name, Bio: bio}))
		if err != nil {
			return nil, err
		}
		return resp.Msg.GetUser(), nil
	}
	ptr := func(s string) *string { return &s }
	if _, err := update(ptr(strings.Repeat("ạ", 65)), nil); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("long name: %v", err)
	}
	if _, err := update(ptr("  "), nil); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty name: %v", err)
	}
	if _, err := update(nil, ptr(strings.Repeat("a", 141))); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("long bio: %v", err)
	}
	u, err := update(ptr(" Alice "), ptr("Xin chào"))
	if err != nil || u.GetName() != "Alice" || u.GetBio() != "Xin chào" {
		t.Fatalf("UpdateProfile = %v, %v", u, err)
	}
	u, err = update(nil, ptr(""))
	if err != nil || u.GetName() != "Alice" || u.GetBio() != "" {
		t.Fatalf("clear bio = %v, %v", u, err)
	}
	photo := "file-1"
	if _, err := alice.users.UpdateProfile(ctx, connect.NewRequest(&appv1.UpdateProfileRequest{PhotoFileId: &photo})); codeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("photo: %v", err)
	}
	got, err := alice.users.GetUsers(ctx, connect.NewRequest(&appv1.GetUsersRequest{UserIds: []int64{u.GetId(), 999999}}))
	if err != nil || len(got.Msg.GetUsers()) != 1 || got.Msg.GetUsers()[0].GetName() != "Alice" || !got.Msg.GetUsers()[0].GetIsSelf() {
		t.Fatalf("GetUsers = %v, %v", got, err)
	}
}

func TestSessionRPCs(t *testing.T) {
	e := newEnv(t)
	first, _ := e.signedIn(t)
	second, _ := e.signedIn(t)
	third, _ := e.signedIn(t)
	ctx := context.Background()

	list, err := second.auth.ListSessions(ctx, connect.NewRequest(&appv1.ListSessionsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	sessions := list.Msg.GetSessions()
	if len(sessions) != 3 {
		t.Fatalf("sessions = %v", sessions)
	}
	current := 0
	for _, s := range sessions {
		if s.GetCurrent() {
			current++
			if s.GetNewLogin() {
				t.Errorf("current session marked new_login")
			}
		} else if !s.GetNewLogin() {
			t.Errorf("fresh session %d not marked new_login", s.GetId())
		}
		if s.GetPlatform() != appv1.ClientPlatform_CLIENT_PLATFORM_WEB || s.GetCreatedAt() <= 0 || s.GetLastActiveAt() <= 0 {
			t.Errorf("session = %v", s)
		}
	}
	if current != 1 {
		t.Fatalf("%d current sessions", current)
	}

	firstID := currentSessionID(t, first)
	if _, err := second.auth.RevokeSession(ctx, connect.NewRequest(&appv1.RevokeSessionRequest{SessionId: firstID})); err != nil {
		t.Fatal(err)
	}
	if _, err := getSelf(t, first); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("revoked session still works: %v", err)
	}
	if _, err := second.auth.RevokeSession(ctx, connect.NewRequest(&appv1.RevokeSessionRequest{SessionId: firstID})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("revoking twice: %v", err)
	}
	if _, err := second.auth.RevokeSession(ctx, connect.NewRequest(&appv1.RevokeSessionRequest{})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("revoking id 0: %v", err)
	}

	resp, err := second.auth.RevokeOtherSessions(ctx, connect.NewRequest(&appv1.RevokeOtherSessionsRequest{}))
	if err != nil || resp.Msg.GetRevokedCount() != 1 {
		t.Fatalf("RevokeOtherSessions = %v, %v", resp, err)
	}
	if _, err := getSelf(t, third); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("other session still works: %v", err)
	}
	if _, err := getSelf(t, second); err != nil {
		t.Fatalf("current session revoked: %v", err)
	}
	e.app.Sessions.Wait()
	if n := len(e.idp.Revoked()); n != 2 {
		t.Fatalf("revoked at IdP = %d tokens, want 2", n)
	}
}

func TestRequestIDsGuard(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	_, err := cl.auth.RevokeSession(context.Background(), connect.NewRequest(&appv1.RevokeSessionRequest{SessionId: ids.MaxSafeID + 1}))
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unsafe id: %v", err)
	}
}

func TestUnknownRoutes(t *testing.T) {
	e := newEnv(t)
	resp, err := e.srv.Client().Get(e.srv.URL + "/auth/backchannel-logout")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET back-channel logout status %d", resp.StatusCode)
	}
}

// ModerationService is mounted behind the session check, and nobody is an
// operator unless configured.
func TestModerationRPCsNeedAnOperator(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	anon := appv1connect.NewModerationServiceClient(e.browser(t), e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := anon.GetReports(ctx, connect.NewRequest(&appv1.GetReportsRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("anonymous GetReports: %v", err)
	}
	cl, c := e.signedIn(t)
	self, err := cl.users.GetSelf(ctx, connect.NewRequest(&appv1.GetSelfRequest{}))
	if err != nil || self.Msg.GetIsOperator() {
		t.Fatalf("GetSelf = %v, %v", self, err)
	}
	mod := appv1connect.NewModerationServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := mod.GetReports(ctx, connect.NewRequest(&appv1.GetReportsRequest{})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("GetReports by a user: %v", err)
	}
	blocked, err := cl.users.GetBlockedUsers(ctx, connect.NewRequest(&appv1.GetBlockedUsersRequest{}))
	if err != nil || len(blocked.Msg.GetBlocked()) != 0 {
		t.Fatalf("GetBlockedUsers = %v, %v", blocked, err)
	}
	chats := appv1connect.NewChatsServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := chats.GetCommonChats(ctx, connect.NewRequest(&appv1.GetCommonChatsRequest{UserId: self.Msg.GetUser().GetId()})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("GetCommonChats with oneself: %v", err)
	}
}

// The web app's first request is GetSelf in the Connect protocol's JSON
// encoding (apps/web/src/api/get-self.ts), sent before the protobuf runtime
// loads; it relies on these field names and error bodies.
func TestGetSelfOverJSON(t *testing.T) {
	e := newEnv(t)
	post := func(c *http.Client, request string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, e.srv.URL+"/rpc/app.v1.UsersService/GetSelf", strings.NewReader(request))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		req.Header.Set("Origin", e.srv.URL)
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if err := json.Unmarshal([]byte(readBody(t, resp)), &body); err != nil {
			t.Fatalf("GetSelf JSON body: %v", err)
		}
		return resp.StatusCode, body
	}

	status, body := post(e.browser(t), "{}")
	if status != http.StatusUnauthorized || body["code"] != "unauthenticated" {
		t.Fatalf("signed out: %d %v", status, body)
	}
	// The start-up probe asks for an empty answer instead of an error, with
	// no cookie and with one that names no session.
	status, body = post(e.browser(t), `{"allowSignedOut":true}`)
	if status != http.StatusOK || len(body) != 0 {
		t.Fatalf("signed out, allowed: %d %v", status, body)
	}
	forged := e.browser(t)
	srvURL, err := url.Parse(e.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	forged.Jar.SetCookies(srvURL, []*http.Cookie{{Name: auth.SessionCookieName, Value: strings.Repeat("A", 43)}})
	status, body = post(forged, `{"allowSignedOut":true}`)
	if status != http.StatusOK || len(body) != 0 {
		t.Fatalf("unknown session, allowed: %d %v", status, body)
	}

	cl, c := e.signedIn(t)
	want, err := getSelf(t, cl)
	if err != nil {
		t.Fatal(err)
	}
	status, body = post(c, `{"allowSignedOut":true}`)
	user, ok := body["user"].(map[string]any)
	if status != http.StatusOK || !ok {
		t.Fatalf("signed in: %d %v", status, body)
	}
	// int64 travels as a decimal string; names are lowerCamelCase.
	if user["id"] != strconv.FormatInt(want.GetId(), 10) || user["name"] != want.GetName() || user["email"] != want.GetEmail() {
		t.Fatalf("user %v, want %v", user, want)
	}
	if _, present := body["isOperator"]; present {
		t.Fatalf("isOperator should be omitted when false: %v", body)
	}
}

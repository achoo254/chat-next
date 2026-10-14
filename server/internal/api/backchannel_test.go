package api_test

import (
	"net/http"
	"testing"
	"time"

	"app.local/server/internal/auth/idptest"
	"connectrpc.com/connect"
)

func TestBackchannelLogoutRevokesBySID(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t) // sid-1
	e.idp.SetAccount(idptest.Account{Sub: "acc_test", SID: "sid-other", PreferredUsername: "tester"})
	other, _ := e.signedIn(t) // same user, another IdP session

	tok := e.idp.LogoutToken(t, e.idp.LogoutClaims("sid-1"))
	if code := postLogoutToken(t, e, tok); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if _, err := getSelf(t, cl); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("session of sid-1 still works: %v", err)
	}
	if _, err := getSelf(t, other); err != nil {
		t.Fatalf("session of another sid revoked: %v", err)
	}
	// Replaying the same token is rejected.
	if code := postLogoutToken(t, e, tok); code != http.StatusBadRequest {
		t.Fatalf("replay status %d", code)
	}
}

func TestBackchannelLogoutRevokesBySubWithoutSID(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	claims := e.idp.LogoutClaims("")
	delete(claims, "sid")
	if code := postLogoutToken(t, e, e.idp.LogoutToken(t, claims)); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if _, err := getSelf(t, cl); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("session still works: %v", err)
	}
}

func TestBackchannelLogoutRejectsBadTokens(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	cases := map[string]func(t *testing.T) string{
		"typ JWT": func(t *testing.T) string {
			tok, err := e.idp.Sign(e.idp.LogoutClaims("sid-1"), "JWT")
			if err != nil {
				t.Fatal(err)
			}
			return tok
		},
		"no typ": func(t *testing.T) string {
			tok, err := e.idp.Sign(e.idp.LogoutClaims("sid-1"), "")
			if err != nil {
				t.Fatal(err)
			}
			return tok
		},
		"wrong aud": func(t *testing.T) string {
			c := e.idp.LogoutClaims("sid-1")
			c["aud"] = "localman-web"
			return e.idp.LogoutToken(t, c)
		},
		"wrong iss": func(t *testing.T) string {
			c := e.idp.LogoutClaims("sid-1")
			c["iss"] = "https://auth.evil.example"
			return e.idp.LogoutToken(t, c)
		},
		"too old": func(t *testing.T) string {
			c := e.idp.LogoutClaims("sid-1")
			c["iat"] = time.Now().Add(-5 * time.Minute).Unix()
			c["exp"] = time.Now().Add(time.Minute).Unix()
			return e.idp.LogoutToken(t, c)
		},
		"expired": func(t *testing.T) string {
			c := e.idp.LogoutClaims("sid-1")
			c["exp"] = time.Now().Add(-time.Minute).Unix()
			return e.idp.LogoutToken(t, c)
		},
		"no events": func(t *testing.T) string {
			c := e.idp.LogoutClaims("sid-1")
			delete(c, "events")
			return e.idp.LogoutToken(t, c)
		},
		"has nonce": func(t *testing.T) string {
			c := e.idp.LogoutClaims("sid-1")
			c["nonce"] = "n"
			return e.idp.LogoutToken(t, c)
		},
		"no jti": func(t *testing.T) string {
			c := e.idp.LogoutClaims("sid-1")
			delete(c, "jti")
			return e.idp.LogoutToken(t, c)
		},
		"garbage": func(*testing.T) string { return "not-a-jwt" },
		"empty":   func(*testing.T) string { return "" },
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			if code := postLogoutToken(t, e, build(t)); code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400", code)
			}
		})
	}
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("a rejected token revoked the session: %v", err)
	}
}

package auth

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"

	"app.local/server/internal/auth/idptest"
)

const (
	testClientID     = "chat-web"
	testClientSecret = "secret"
	testRedirect     = "https://chat.example/auth/callback"
)

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// newTestIdP returns a discovered client of a fake IdP and the buffer its
// logs go to.
func newTestIdP(t *testing.T) (*IdP, *idptest.Provider, *lockedBuffer) {
	t.Helper()
	fake := idptest.New(t, testClientID, testClientSecret)
	logs := &lockedBuffer{}
	p := NewIdP(IdPConfig{
		Issuer: fake.Issuer(), ClientID: testClientID, ClientSecret: testClientSecret, RedirectURL: testRedirect,
		HTTPClient: fake.Server.Client(), Logger: slog.New(slog.NewTextHandler(logs, nil)),
	})
	if err := p.Discover(context.Background()); err != nil {
		t.Fatal(err)
	}
	return p, fake, logs
}

// exchange runs an authorization request against the fake IdP and redeems
// its code.
func exchange(t *testing.T, p *IdP, fake *idptest.Provider) (Tokens, error) {
	t.Helper()
	verifier := "verifier-" + strings.Repeat("v", 40)
	authURL, err := p.AuthCodeURL(AuthRequest{State: "state", Nonce: "nonce", Verifier: verifier})
	if err != nil {
		t.Fatal(err)
	}
	client := fake.Server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(authURL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	back, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || resp.StatusCode != http.StatusFound {
		t.Fatalf("authorize: status %d, location %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	return p.Exchange(context.Background(), back.Query().Get("code"), verifier)
}

var testAccount = idptest.Account{
	Sub: "acc_ui", SID: "sid-ui", PreferredUsername: "annguyen", Name: "Nguyễn Văn An",
	Email: "an@example.com", EmailVerified: true,
}

func TestExchangeCompletesClaimsFromUserInfo(t *testing.T) {
	p, fake, _ := newTestIdP(t)
	fake.SetAccount(testAccount)
	tokens, err := exchange(t, p, fake)
	if err != nil {
		t.Fatal(err)
	}
	c := tokens.Claims
	if c.Subject != "acc_ui" || c.SessionID != "sid-ui" || c.Nonce != "nonce" || c.PreferredUsername != "annguyen" ||
		c.Name != "Nguyễn Văn An" || c.Email != "an@example.com" || !c.EmailVerified || !c.EmailKnown {
		t.Fatalf("claims = %+v", c)
	}
	if prof := c.idpProfile(); prof.EmailUnknown || prof.Email.Email != "an@example.com" || !prof.Email.Verified {
		t.Fatalf("profile = %+v", prof)
	}
}

func TestExchangeUserInfoOutageFallsBackToIDToken(t *testing.T) {
	p, fake, logs := newTestIdP(t)
	fake.SetAccount(testAccount)
	fake.SetUserInfo(idptest.UserInfoServerError)
	tokens, err := exchange(t, p, fake)
	if err != nil {
		t.Fatalf("sign-in blocked by a userinfo outage: %v", err)
	}
	c := tokens.Claims
	// The fake ID token, like hoandat-auth's, carries no name or email.
	if c.Subject != "acc_ui" || c.PreferredUsername != "annguyen" || c.Name != "" || c.Email != "" || c.EmailKnown {
		t.Fatalf("claims = %+v", c)
	}
	if !c.idpProfile().EmailUnknown {
		t.Fatal("an unknown email state would clear the stored email")
	}
	out := logs.String()
	if !strings.Contains(out, "IdP userinfo unavailable at sign-in") {
		t.Fatalf("no warning logged: %q", out)
	}
	if strings.Contains(out, tokens.AccessToken) || strings.Contains(out, tokens.RefreshToken) {
		t.Fatalf("warning leaks a token: %q", out)
	}
}

func TestExchangeRejectsUserInfoOfAnotherSubject(t *testing.T) {
	p, fake, _ := newTestIdP(t)
	fake.SetAccount(testAccount)
	fake.SetUserInfo(idptest.UserInfoOtherSubject)
	if _, err := exchange(t, p, fake); !errors.Is(err, ErrInvalidToken) || !errors.Is(err, errUserInfoSubject) {
		t.Fatalf("exchange = %v, want a subject mismatch", err)
	}
}

func TestRefreshCompletesClaimsFromUserInfo(t *testing.T) {
	p, fake, _ := newTestIdP(t)
	fake.SetAccount(testAccount)
	signIn, err := exchange(t, p, fake)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := p.Refresh(context.Background(), signIn.RefreshToken)
	if err != nil || tokens.ClaimsErr != nil {
		t.Fatalf("refresh: %v, claims %v", err, tokens.ClaimsErr)
	}
	if c := tokens.Claims; tokens.IDToken == "" || c.Name != "Nguyễn Văn An" || c.Email != "an@example.com" || !c.EmailKnown {
		t.Fatalf("refresh claims = %+v", c)
	}

	// A userinfo outage or another subject leaves the claims unknown, while
	// the rotated refresh token is still returned.
	for _, mode := range []idptest.UserInfoMode{idptest.UserInfoServerError, idptest.UserInfoOtherSubject} {
		fake.SetUserInfo(mode)
		next, err := p.Refresh(context.Background(), tokens.RefreshToken)
		if err != nil || next.ClaimsErr == nil || next.RefreshToken == "" || next.Claims.Subject != "" || next.IDToken != "" {
			t.Fatalf("mode %d: err %v, tokens %+v", mode, err, next)
		}
		tokens = next
	}
}

func TestMergeUserInfo(t *testing.T) {
	id := IDClaims{Subject: "s", SessionID: "sid", Nonce: "n", PreferredUsername: "id-user", Name: "ID Name"}
	got := mergeUserInfo(id, IDClaims{Subject: "s", Email: "e@example.com", EmailVerified: true})
	want := IDClaims{Subject: "s", SessionID: "sid", Nonce: "n", PreferredUsername: "id-user", Name: "ID Name",
		Email: "e@example.com", EmailVerified: true, EmailKnown: true}
	if got != want {
		t.Fatalf("empty userinfo values replaced ID token values: %+v", got)
	}
	got = mergeUserInfo(id, IDClaims{Subject: "s", PreferredUsername: "ui-user", Name: "UI Name"})
	if got.PreferredUsername != "ui-user" || got.Name != "UI Name" || got.Email != "" || !got.EmailKnown {
		t.Fatalf("userinfo values not applied: %+v", got)
	}
}

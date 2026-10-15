package idptest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/go-jose/go-jose/v4"
)

// TestServePicksAccountPerSignIn: with Serve, each sign-in picks its own
// account on the picker page, and a refresh keeps the account the token was
// issued to, so several browsers stay signed in as different people.
func TestServePicksAccountPerSignIn(t *testing.T) {
	accounts := []Account{
		{Sub: "acc_an", SID: "sid-an", PreferredUsername: "an", Name: "An"},
		{Sub: "acc_binh", SID: "sid-binh", PreferredUsername: "binh", Name: "Bình"},
	}
	p, err := Serve("127.0.0.1:0", "chat-web", "secret", accounts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Server.Close)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	verifier := "verifier-" + strings.Repeat("x", 40)
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"client_id": {"chat-web"}, "response_type": {"code"}, "code_challenge_method": {"S256"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])},
		"redirect_uri":   {"http://localhost:5173/auth/callback"}, "state": {"st"}, "nonce": {"n"},
	}

	resp, err := client.Get(p.Issuer() + "/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(page), "Đăng nhập là Bình") {
		t.Fatalf("picker page: status %d, body %q", resp.StatusCode, page)
	}

	signIn := func(sub string) (idSub, refresh, access string) {
		t.Helper()
		pq := url.Values{}
		for k, v := range q {
			pq[k] = v
		}
		pq.Set("account", sub)
		resp, err := client.Get(p.Issuer() + "/authorize?" + pq.Encode())
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		back, err := url.Parse(resp.Header.Get("Location"))
		if err != nil || resp.StatusCode != http.StatusFound {
			t.Fatalf("authorize: status %d, location %q", resp.StatusCode, resp.Header.Get("Location"))
		}
		return p.redeem(t, url.Values{
			"grant_type": {"authorization_code"}, "code": {back.Query().Get("code")},
			"code_verifier": {verifier}, "redirect_uri": {q.Get("redirect_uri")},
		})
	}

	binhSub, binhRefresh, binhAccess := signIn("acc_binh")
	anSub, _, anAccess := signIn("acc_an")
	if binhSub != "acc_binh" || anSub != "acc_an" {
		t.Fatalf("signed in as %q and %q, want acc_binh and acc_an", binhSub, anSub)
	}
	sub, _, refreshedAccess := p.redeem(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {binhRefresh}})
	if sub != "acc_binh" {
		t.Fatalf("refresh of Bình's token signed in %q", sub)
	}

	// Userinfo answers for the account each access token was issued to, and
	// for the first account without a known token.
	for _, c := range []struct{ token, sub, name string }{
		{binhAccess, "acc_binh", "Bình"}, {anAccess, "acc_an", "An"},
		{refreshedAccess, "acc_binh", "Bình"}, {"", "acc_an", "An"}, {"at-unknown", "acc_an", "An"},
	} {
		if gotSub, gotName := p.userInfo(t, c.token); gotSub != c.sub || gotName != c.name {
			t.Fatalf("userinfo with token %q = %q %q, want %q %q", c.token, gotSub, gotName, c.sub, c.name)
		}
	}
}

// userInfo calls the userinfo endpoint with a bearer token ("" sends none).
func (p *Provider) userInfo(t *testing.T, token string) (sub, name string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, p.Issuer()+"/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body struct {
		Sub  string `json:"sub"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("userinfo: status %d, err %v", resp.StatusCode, err)
	}
	return body.Sub, body.Name
}

// redeem posts a token request and returns the ID token's sub, the new
// refresh token and the access token.
func (p *Provider) redeem(t *testing.T, form url.Values) (sub, refresh, access string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, p.Issuer()+"/token", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(p.ClientID, p.ClientSecret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
		AccessToken  string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("token: status %d, err %v", resp.StatusCode, err)
	}
	jws, err := jose.ParseSigned(body.IDToken, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(jws.UnsafePayloadWithoutVerification(), &claims); err != nil {
		t.Fatal(err)
	}
	return claims.Sub, body.RefreshToken, body.AccessToken
}

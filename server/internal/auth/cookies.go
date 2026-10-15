package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"app.local/server/internal/sealbox"
	"app.local/server/internal/store"
)

// Cookie names. The __Host- prefix forces Secure, Path=/ and no Domain, so
// no other host of the site can set or read them. Browsers treat
// http://localhost as a secure context, so Secure also works in development.
const (
	SessionCookieName = "__Host-chat_session"
	LoginCookieName   = "__Host-chat_login"
)

// loginTTL bounds one sign-in attempt (state, nonce and verifier).
const loginTTL = 10 * time.Minute

// sessionTokenBytes is the size of a session token (256 bits).
const sessionTokenBytes = 32

// newSecret returns n random bytes, base64url-encoded without padding.
func newSecret(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand does not fail on supported platforms.
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// hashToken returns the SHA-256 of a session token; ok is false when the
// value cannot be a token this server issued.
func hashToken(token string) (hash []byte, ok bool) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != sessionTokenBytes {
		return nil, false
	}
	sum := sha256.Sum256(raw)
	return sum[:], true
}

// SessionToken returns the session cookie value carried by a request header
// set, or "".
func SessionToken(h http.Header) string {
	c, err := (&http.Request{Header: h}).Cookie(SessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

func setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(store.SessionMaxAge / time.Second),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearCookie(w http.ResponseWriter, name string, sameSite http.SameSite) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Secure:   true,
		HttpOnly: true,
		SameSite: sameSite,
	})
}

// loginState is sealed into the login cookie for one sign-in attempt.
type loginState struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Locale   string `json:"l,omitempty"`
	Expires  int64  `json:"e"`
	// ReturnTo is the same-origin path to open after sign-in (CleanReturnTo).
	ReturnTo string `json:"r,omitempty"`
	// Replaces is the base64url token hash of the session the browser held
	// when it started this sign-in; the new session replaces it.
	Replaces string `json:"p,omitempty"`
}

var loginCookieAAD = []byte(LoginCookieName)

var errLoginState = errors.New("auth: missing, invalid or expired login state")

// setLoginCookie seals st into the login cookie. SameSite=Lax because the
// IdP sends the browser back with a cross-site top-level GET.
func setLoginCookie(w http.ResponseWriter, box *sealbox.Box, st loginState) error {
	plain, err := json.Marshal(st)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     LoginCookieName,
		Value:    base64.RawURLEncoding.EncodeToString(box.Seal(plain, loginCookieAAD)),
		Path:     "/",
		MaxAge:   int(loginTTL / time.Second),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// readLoginCookie opens the login cookie of r and checks its expiry.
func readLoginCookie(r *http.Request, box *sealbox.Box, now time.Time) (loginState, error) {
	c, err := r.Cookie(LoginCookieName)
	if err != nil {
		return loginState{}, errLoginState
	}
	sealed, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil {
		return loginState{}, errLoginState
	}
	plain, err := box.Open(sealed, loginCookieAAD)
	if err != nil {
		return loginState{}, errLoginState
	}
	var st loginState
	if err := json.Unmarshal(plain, &st); err != nil || st.State == "" || st.Nonce == "" || st.Verifier == "" {
		return loginState{}, errLoginState
	}
	if now.Unix() > st.Expires {
		return loginState{}, errLoginState
	}
	return st, nil
}

package chatmcp

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// confirmTokenTTL is how long a preview's confirm token stays usable.
const confirmTokenTTL = 5 * time.Minute

// confirmKeyInfo separates this key from the other keys derived from
// SESSION_KEY.
const confirmKeyInfo = "chat-mcp confirm token v1"

// Confirmation errors; the tool answers them as invalid_argument.
var (
	errConfirmInvalid = errors.New("confirm_token_invalid: the confirm token does not match this call; preview again")
	errConfirmExpired = errors.New("confirm_token_expired: the confirm token expired; preview again")
	errConfirmUsed    = errors.New("confirm_token_used: the confirm token was already used; preview again")
)

// confirmTokens issues and checks the tokens that turn a preview of a
// bots:admin tool into the real call. A token is bound to the user, the
// tool and the exact arguments, lives 5 minutes and works once. The used
// nonces are kept in memory: the api runs as one process (as the rate
// limiter assumes), and a restart only makes pending previews fail.
type confirmTokens struct {
	key []byte
	now func() time.Time

	mu   sync.Mutex
	used map[string]time.Time // nonce → expiry
}

func newConfirmTokens(sessionKey []byte) (*confirmTokens, error) {
	key, err := hkdf.Key(sha256.New, sessionKey, nil, confirmKeyInfo, sha256.Size)
	if err != nil {
		return nil, fmt.Errorf("chatmcp: confirm key: %w", err)
	}
	return &confirmTokens{key: key, now: time.Now, used: map[string]time.Time{}}, nil
}

// issue returns a token for subject calling tool with args, and its expiry.
func (c *confirmTokens) issue(subject, tool string, args any) (string, time.Time, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", time.Time{}, fmt.Errorf("chatmcp: confirm nonce: %w", err)
	}
	expires := c.now().Add(confirmTokenTTL).Truncate(time.Millisecond)
	exp := strconv.FormatInt(expires.UnixMilli(), 36)
	n := base64.RawURLEncoding.EncodeToString(nonce)
	mac, err := c.mac(exp, n, subject, tool, args)
	if err != nil {
		return "", time.Time{}, err
	}
	return "v1." + exp + "." + n + "." + mac, expires, nil
}

// consume checks token against the call and spends it.
func (c *confirmTokens) consume(token, subject, tool string, args any) error {
	parts := strings.Split(token, ".")
	if len(parts) != 4 || parts[0] != "v1" {
		return errConfirmInvalid
	}
	exp, nonce, got := parts[1], parts[2], parts[3]
	want, err := c.mac(exp, nonce, subject, tool, args)
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(got), []byte(want)) {
		return errConfirmInvalid
	}
	ms, err := strconv.ParseInt(exp, 36, 64)
	if err != nil {
		return errConfirmInvalid
	}
	expires := time.UnixMilli(ms)
	now := c.now()
	if !now.Before(expires) {
		return errConfirmExpired
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for n, e := range c.used {
		if !now.Before(e) {
			delete(c.used, n)
		}
	}
	if _, spent := c.used[nonce]; spent {
		return errConfirmUsed
	}
	c.used[nonce] = expires
	return nil
}

// mac signs the token fields with the call it confirms. args is a struct
// without the confirm token, so its JSON (fields in declaration order) is
// canonical.
func (c *confirmTokens) mac(exp, nonce, subject, tool string, args any) (string, error) {
	body, err := json.Marshal([]any{"v1", exp, nonce, subject, tool, args})
	if err != nil {
		return "", fmt.Errorf("chatmcp: confirm payload: %w", err)
	}
	h := hmac.New(sha256.New, c.key)
	h.Write(body)
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)), nil
}

package miniapp

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// HKDF-SHA256 info strings of the keys derived from SESSION_KEY. Rotating
// SESSION_KEY rotates both (bots fetch the new public key with
// getMiniAppKey).
const (
	signingKeyInfo  = "chat-miniapp-ed25519"
	instanceKeyInfo = "chat-miniapp-chat-instance"
)

// Chat types of the init data: where the Mini App was opened.
const (
	ChatPrivate = "private"
	ChatGroup   = "group"
	ChatChannel = "channel"
	// ChatSender: opened from the bot's profile, outside a chat.
	ChatSender = "sender"
)

// Signer signs init data with the platform's Ed25519 key. The keys live in
// memory only; they are derived again from SESSION_KEY at every start.
type Signer struct {
	tenantID    string
	private     ed25519.PrivateKey
	public      ed25519.PublicKey
	instanceKey []byte
}

// NewSigner derives the signing key and the chat_instance key from the
// session key (config SESSION_KEY).
func NewSigner(sessionKey []byte, tenantID string) (*Signer, error) {
	if len(sessionKey) < 32 || tenantID == "" {
		return nil, errors.New("miniapp: a session key of at least 32 bytes and the tenant id are required")
	}
	seed, err := hkdf.Key(sha256.New, sessionKey, nil, signingKeyInfo, ed25519.SeedSize)
	if err != nil {
		return nil, fmt.Errorf("miniapp: derive signing key: %w", err)
	}
	instanceKey, err := hkdf.Key(sha256.New, sessionKey, nil, instanceKeyInfo, sha256.Size)
	if err != nil {
		return nil, fmt.Errorf("miniapp: derive chat_instance key: %w", err)
	}
	private := ed25519.NewKeyFromSeed(seed)
	public, ok := private.Public().(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("miniapp: unexpected public key type")
	}
	return &Signer{tenantID: tenantID, private: private, public: public, instanceKey: instanceKey}, nil
}

// PublicKey is the verification key as base64url without padding (32 bytes),
// what the Bot API's getMiniAppKey returns.
func (s *Signer) PublicKey() string {
	return base64.RawURLEncoding.EncodeToString(s.public)
}

// ChatInstance is the stable chat_instance of a bot in a chat: an HMAC of
// the pair, so the Mini App can group its users by chat without learning
// the chat id. Opened outside a chat (chatID 0), it is the pair of the user
// and the bot instead.
func (s *Signer) ChatInstance(chatID, userID, botID int64) string {
	subject := fmt.Sprintf("chat:%d:%d", chatID, botID)
	if chatID == 0 {
		subject = fmt.Sprintf("user:%d:%d", userID, botID)
	}
	mac := hmac.New(sha256.New, s.instanceKey)
	mac.Write([]byte(subject))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:12])
}

// User is the user field of the init data.
type User struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	Username  string `json:"username,omitempty"`
}

// InitData is what a Mini App learns when it opens.
type InitData struct {
	BotID        int64
	User         User
	ChatType     string
	ChatInstance string
	// StartParam is left out of the query string when empty.
	StartParam string
	AuthDate   time.Time
}

// Sign returns the init data as a query string with its signature:
// base64url (no padding) Ed25519 over "<bot_id>:WebAppData\n" followed by
// every other field as key=value lines (decoded values) sorted by key and
// joined by "\n".
func (s *Signer) Sign(d InitData) (string, error) {
	user, err := json.Marshal(d.User)
	if err != nil {
		return "", fmt.Errorf("miniapp: encode user: %w", err)
	}
	fields := map[string]string{
		"user":          string(user),
		"chat_type":     d.ChatType,
		"chat_instance": d.ChatInstance,
		"auth_date":     strconv.FormatInt(d.AuthDate.Unix(), 10),
		"bot_id":        strconv.FormatInt(d.BotID, 10),
		"tenant_id":     s.tenantID,
	}
	if d.StartParam != "" {
		fields["start_param"] = d.StartParam
	}
	signature := ed25519.Sign(s.private, []byte(DataCheckString(d.BotID, fields)))
	q := url.Values{}
	for k, v := range fields {
		q.Set(k, v)
	}
	q.Set("signature", base64.RawURLEncoding.EncodeToString(signature))
	return q.Encode(), nil
}

// DataCheckString is the signed text of init data fields (signature
// excluded).
func DataCheckString(botID int64, fields map[string]string) string {
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+"="+fields[k])
	}
	return strconv.FormatInt(botID, 10) + ":WebAppData\n" + strings.Join(lines, "\n")
}

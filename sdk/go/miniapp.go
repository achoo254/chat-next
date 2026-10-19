package chatbot

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// MiniAppMaxAge is how old init data VerifyMiniAppInitData accepts by
	// default (its auth_date).
	MiniAppMaxAge = time.Hour
	// miniAppSkew is how far in the future auth_date may be (clock skew).
	miniAppSkew = 5 * time.Minute
)

// ErrMiniAppInitData is wrapped by every error of VerifyMiniAppInitData.
var ErrMiniAppInitData = errors.New("chatbot: Mini App init data rejected")

// MiniAppUser is the user who opened the Mini App.
type MiniAppUser struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	Username  string `json:"username,omitempty"`
}

// MiniAppInitData is verified init data.
type MiniAppInitData struct {
	User MiniAppUser
	// ChatType is private, group, channel, or sender (opened from the bot's
	// profile); new types may be added.
	ChatType string
	// ChatInstance is stable for a chat and the bot (for sender: the user
	// and the bot), without telling the chat id.
	ChatInstance string
	// StartParam is "" when none was given.
	StartParam string
	AuthDate   time.Time
	BotID      int64
	TenantID   string
	// Fields holds every field but signature, as received.
	Fields map[string]string
}

// VerifyMiniAppInitData checks the init data a Mini App received (the query
// string the client passes in #chatAppData) and returns its fields. The
// signature is Ed25519 over "<bot_id>:WebAppData\n" followed by the other
// fields as key=value lines sorted by key and joined by "\n", checked with
// publicKey (Client.GetMiniAppKey, base64url); bot_id must be botID and
// auth_date at most maxAge old (MiniAppMaxAge when maxAge <= 0) at now. It
// returns an error wrapping ErrMiniAppInitData otherwise.
func VerifyMiniAppInitData(initData string, botID int64, publicKey string, maxAge time.Duration, now time.Time) (*MiniAppInitData, error) {
	reject := func(why string) (*MiniAppInitData, error) {
		return nil, fmt.Errorf("%w: %s", ErrMiniAppInitData, why)
	}
	if maxAge <= 0 {
		maxAge = MiniAppMaxAge
	}
	key, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return reject("bad public key")
	}
	values, err := url.ParseQuery(initData)
	if err != nil {
		return reject("not a query string")
	}
	fields := make(map[string]string, len(values))
	for k, v := range values {
		if len(v) != 1 {
			return reject("field " + k + " repeats")
		}
		fields[k] = v[0]
	}
	signature, err := base64.RawURLEncoding.DecodeString(fields["signature"])
	if err != nil || len(signature) != ed25519.SignatureSize {
		return reject("bad signature")
	}
	delete(fields, "signature")
	if fields["bot_id"] != strconv.FormatInt(botID, 10) {
		return reject("init data of another bot")
	}
	if !ed25519.Verify(ed25519.PublicKey(key), []byte(miniAppCheckString(botID, fields)), signature) {
		return reject("wrong signature")
	}
	at, err := strconv.ParseInt(fields["auth_date"], 10, 64)
	if err != nil {
		return reject("bad auth_date")
	}
	age := now.Sub(time.Unix(at, 0))
	if age > maxAge || age < -miniAppSkew {
		return reject("auth_date too old or in the future")
	}
	out := &MiniAppInitData{
		ChatType: fields["chat_type"], ChatInstance: fields["chat_instance"], StartParam: fields["start_param"],
		AuthDate: time.Unix(at, 0), BotID: botID, TenantID: fields["tenant_id"], Fields: fields,
	}
	if err := json.Unmarshal([]byte(fields["user"]), &out.User); err != nil {
		return reject("bad user")
	}
	return out, nil
}

// miniAppCheckString is the signed text of the fields.
func miniAppCheckString(botID int64, fields map[string]string) string {
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(strconv.FormatInt(botID, 10) + ":WebAppData")
	for _, k := range keys {
		b.WriteString("\n" + k + "=" + fields[k])
	}
	return b.String()
}

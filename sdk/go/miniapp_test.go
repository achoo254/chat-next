package chatbot

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// Init data signed by the server (server/internal/miniapp TestSignVector;
// docs/bot-api/README.md).
const (
	miniAppKey      = "3ktwc67vmU-jLgKZ13Lj1iN6KAk145mjNELp-vwXrcg"
	miniAppInitData = "auth_date=1760850000&bot_id=1234567&chat_instance=jkvivnNpwnmKUPzV&chat_type=private" +
		"&signature=_Z0BDYBsfng_LKrIg5NS1OZZMzOmjLKQU9sXDmE4vYMWAzIZzX8_W_XApoETPJsVzHm-pwST8Goq1Z92Vnu0CQ" +
		"&start_param=promo_1&tenant_id=primary" +
		"&user=%7B%22id%22%3A7654321%2C%22first_name%22%3A%22Lan+Nguy%E1%BB%85n%22%2C%22username%22%3A%22lan%22%7D"
	miniAppBotID = 1234567
)

var miniAppAt = time.Unix(1760850000, 0)

func TestVerifyMiniAppInitData(t *testing.T) {
	d, err := VerifyMiniAppInitData(miniAppInitData, miniAppBotID, miniAppKey, 0, miniAppAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if d.User != (MiniAppUser{ID: 7654321, FirstName: "Lan Nguyễn", Username: "lan"}) || d.ChatType != "private" ||
		d.ChatInstance != "jkvivnNpwnmKUPzV" || d.StartParam != "promo_1" || d.TenantID != "primary" ||
		d.BotID != miniAppBotID || !d.AuthDate.Equal(miniAppAt) {
		t.Fatalf("data = %+v", d)
	}

	rejected := map[string]func() (*MiniAppInitData, error){
		"another bot": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData, miniAppBotID+1, miniAppKey, 0, miniAppAt)
		},
		"older than an hour": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData, miniAppBotID, miniAppKey, 0, miniAppAt.Add(time.Hour+time.Second))
		},
		"older than max age": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData, miniAppBotID, miniAppKey, time.Minute, miniAppAt.Add(2*time.Minute))
		},
		"from the future": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData, miniAppBotID, miniAppKey, 0, miniAppAt.Add(-10*time.Minute))
		},
		"tampered": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(strings.Replace(miniAppInitData, "chat_type=private", "chat_type=group", 1),
				miniAppBotID, miniAppKey, 0, miniAppAt)
		},
		"field added": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData+"&admin=1", miniAppBotID, miniAppKey, 0, miniAppAt)
		},
		"field repeated": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData+"&chat_type=private", miniAppBotID, miniAppKey, 0, miniAppAt)
		},
		"another key": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData, miniAppBotID, "A"+miniAppKey[1:], 0, miniAppAt)
		},
		"bad key": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData(miniAppInitData, miniAppBotID, "short", 0, miniAppAt)
		},
		"no signature": func() (*MiniAppInitData, error) {
			return VerifyMiniAppInitData("auth_date=1760850000&bot_id=1234567", miniAppBotID, miniAppKey, 0, miniAppAt)
		},
	}
	for name, run := range rejected {
		if d, err := run(); d != nil || !errors.Is(err, ErrMiniAppInitData) {
			t.Errorf("%s: %+v, %v", name, d, err)
		}
	}
}

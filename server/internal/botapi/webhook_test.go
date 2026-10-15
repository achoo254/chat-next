package botapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebhookMethods(t *testing.T) {
	h := newHarness(t)
	owner := h.User("owner")
	_, token := h.Bot(owner, "hookapibot")
	rcv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer rcv.Close()

	var info webhookInfo
	h.call(http.MethodGet, "/bot/v1/webhook", token, "").into(t, &info)
	if info.URL != "" || info.MaxConnections != 40 || info.AllowedUpdates == nil {
		t.Fatalf("info without webhook = %+v", info)
	}
	h.call(http.MethodPut, "/bot/v1/webhook", token, `{"url": ""}`).fails(t, http.StatusBadRequest, "bad_request")
	h.call(http.MethodPut, "/bot/v1/webhook", token, fmt.Sprintf(`{"url": %q}`, rcv.URL)).fails(t, http.StatusBadRequest, "bad_request")
	bad := h.call(http.MethodPut, "/bot/v1/webhook", token, fmt.Sprintf(`{"url": %q, "secret": "s", "max_connections": 0, "allowed_updates": ["nope"]}`, rcv.URL))
	bad.fails(t, http.StatusBadRequest, "bad_request")
	if !strings.Contains(bad.Error.Description, "unknown update kind") {
		t.Fatalf("description = %q", bad.Error.Description)
	}
	h.call(http.MethodPut, "/bot/v1/webhook", token, `{"url": "https://x.example", "secret": "s", "extra": 1}`).
		fails(t, http.StatusBadRequest, "bad_request")
	var ok bool
	h.call(http.MethodPut, "/bot/v1/webhook", token,
		fmt.Sprintf(`{"url": %q, "secret": "abc_DEF-1", "max_connections": 5, "allowed_updates": ["message", "callback"]}`, rcv.URL)).
		into(t, &ok)
	h.call(http.MethodGet, "/bot/v1/webhook", token, "").into(t, &info)
	if info.URL != rcv.URL || info.MaxConnections != 5 || strings.Join(info.AllowedUpdates, ",") != "message,callback" {
		t.Fatalf("info = %+v", info)
	}
	// Long poll while a webhook is set: 409.
	conflict := h.call(http.MethodGet, "/bot/v1/updates", token, "")
	conflict.fails(t, http.StatusConflict, "conflict")
	if !strings.Contains(conflict.Error.Description, "webhook") {
		t.Fatalf("description = %q", conflict.Error.Description)
	}
	h.call(http.MethodPost, "/bot/v1/webhook", token, "{}").fails(t, http.StatusMethodNotAllowed, "method_not_allowed")
	h.call(http.MethodDelete, "/bot/v1/webhook?drop_pending=maybe", token, "").fails(t, http.StatusBadRequest, "bad_request")
	h.call(http.MethodDelete, "/bot/v1/webhook?drop_pending=true", token, "").into(t, &ok)
	h.call(http.MethodGet, "/bot/v1/webhook", token, "").into(t, &info)
	if info.URL != "" || info.PendingCount != 0 {
		t.Fatalf("info after delete = %+v", info)
	}
	h.updates(token, "timeout=0")
}

func TestFailureMessage(t *testing.T) {
	for code, want := range map[string]string{
		"http_502":        "the webhook answered HTTP 502 Bad Gateway",
		"timeout":         "no answer within 10 seconds",
		"blocked_address": "the host resolves to a private, local or reserved address",
		"unknown_code":    "unknown_code",
	} {
		if got := FailureMessage(code); got != want {
			t.Errorf("FailureMessage(%s) = %q", code, got)
		}
	}
}

func TestWebhookReplyIgnoresNonActions(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := h.User("owner")
	botID, _ := h.Bot(owner, "quietbot")
	for _, body := range []string{``, `ok`, `[]`, `{"ok": true}`} {
		if err := h.api.WebhookReply(ctx, botID, 1, []byte(body)); err != nil {
			t.Errorf("WebhookReply(%q) = %v", body, err)
		}
	}
	// A method on a bot without webhook is refused (the webhook went away
	// while the request ran).
	if err := h.api.WebhookReply(ctx, botID, 1, []byte(`{"method": "sendMessage", "chat_id": 1, "text": "x"}`)); err == nil {
		t.Fatal("action without webhook ran")
	}
}

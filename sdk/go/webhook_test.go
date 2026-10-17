package chatbot

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	vectorSecret = "my_secret"
	vectorTS     = "1760500000"
	vectorBody   = `{"update_id":1}`
	vectorSig    = "v1=12ce7a96902e36f654800624244c841b5b6ce24b50f42f876fa551d508a6e8e1"
)

func signedHeader(secret, ts string, body []byte) http.Header {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	h := http.Header{}
	h.Set("X-Bot-Api-Secret-Token", secret)
	h.Set("X-Bot-Timestamp", ts)
	h.Set("X-Bot-Signature", "v1="+hex.EncodeToString(mac.Sum(nil)))
	return h
}

func TestVerifyWebhook(t *testing.T) {
	at := time.Unix(1760500000, 0)
	good := func() http.Header {
		h := http.Header{}
		h.Set("X-Bot-Api-Secret-Token", vectorSecret)
		h.Set("X-Bot-Timestamp", vectorTS)
		h.Set("X-Bot-Signature", vectorSig)
		return h
	}
	if err := VerifyWebhook(good(), []byte(vectorBody), vectorSecret, at); err != nil {
		t.Fatalf("documented test vector rejected: %v", err)
	}
	if err := VerifyWebhook(good(), []byte(vectorBody), vectorSecret, at.Add(5*time.Minute)); err != nil {
		t.Errorf("5 minutes of skew rejected: %v", err)
	}
	if err := VerifyWebhook(good(), []byte(vectorBody), vectorSecret, at.Add(-5*time.Minute)); err != nil {
		t.Errorf("-5 minutes of skew rejected: %v", err)
	}

	cases := map[string]struct {
		mutate func(h http.Header)
		body   string
		secret string
		now    time.Time
	}{
		"wrong secret token": {mutate: func(h http.Header) { h.Set("X-Bot-Api-Secret-Token", "other") }},
		"other secret":       {secret: "other"},
		"wrong signature":    {mutate: func(h http.Header) { h.Set("X-Bot-Signature", strings.Replace(vectorSig, "e", "f", 1)) }},
		"tampered body":      {body: `{"update_id":2}`},
		"missing signature":  {mutate: func(h http.Header) { h.Del("X-Bot-Signature") }},
		"too old":            {now: at.Add(5*time.Minute + time.Second)},
		"from the future":    {now: at.Add(-5*time.Minute - time.Second)},
		"bad timestamp":      {mutate: func(h http.Header) { h.Set("X-Bot-Timestamp", "-1760500000") }},
		"missing timestamp":  {mutate: func(h http.Header) { h.Del("X-Bot-Timestamp") }},
		"empty secret":       {secret: "-"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := good()
			if tc.mutate != nil {
				tc.mutate(h)
			}
			body, secret, now := vectorBody, vectorSecret, at
			if tc.body != "" {
				body = tc.body
			}
			switch tc.secret {
			case "":
			case "-":
				secret = ""
			default:
				secret = tc.secret
			}
			if !tc.now.IsZero() {
				now = tc.now
			}
			err := VerifyWebhook(h, []byte(body), secret, now)
			if !errors.Is(err, ErrWebhookRejected) {
				t.Errorf("err = %v, want ErrWebhookRejected", err)
			}
		})
	}
}

// postUpdate sends a signed update to h and returns the answer.
func postUpdate(t *testing.T, h http.Handler, secret string, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/hook", strings.NewReader(body))
	for k, v := range signedHeader(secret, strconv.FormatInt(time.Now().Unix(), 10), []byte(body)) {
		r.Header[k] = v
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestWebhookHandlerRejectsBadSignatureBeforeParsing(t *testing.T) {
	var calls atomic.Int32
	h := WebhookHandler("s3cret", func(context.Context, Update) (*WebhookAnswer, error) {
		calls.Add(1)
		return nil, nil
	})
	w := postUpdate(t, h, "wrong", "not json at all")
	if w.Code != http.StatusUnauthorized || w.Body.Len() != 0 {
		t.Errorf("answer = %d %q, want 401 without body", w.Code, w.Body.String())
	}
	w = postUpdate(t, h, "s3cret", "not json at all")
	if w.Code != http.StatusBadRequest {
		t.Errorf("signed garbage = %d, want 400", w.Code)
	}
	if calls.Load() != 0 {
		t.Error("handler ran")
	}
}

func TestWebhookHandlerMethodAndSize(t *testing.T) {
	h := WebhookHandler("s3cret", func(context.Context, Update) (*WebhookAnswer, error) { return nil, nil })
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/hook", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", w.Code)
	}
	big := `{"update_id":1,"x":"` + strings.Repeat("a", 1<<20) + `"}`
	if w := postUpdate(t, h, "s3cret", big); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("big body = %d, want 413", w.Code)
	}
}

func TestWebhookHandlerAnswers(t *testing.T) {
	h := WebhookHandler("s3cret", func(_ context.Context, u Update) (*WebhookAnswer, error) {
		switch u.UpdateID {
		case 1:
			return nil, nil
		case 2:
			return &WebhookAnswer{Method: "sendMessage", ChatID: 42, Text: "Đã nhận"}, nil
		default:
			return nil, errors.New("boom")
		}
	})
	if w := postUpdate(t, h, "s3cret", `{"update_id":1,"message":{"chat":{"id":1},"seq":1,"date":1}}`); w.Code != http.StatusNoContent {
		t.Errorf("no answer = %d, want 204", w.Code)
	}
	w := postUpdate(t, h, "s3cret", `{"update_id":2}`)
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("answer = %d %s", w.Code, w.Header().Get("Content-Type"))
	}
	var got WebhookAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got != (WebhookAnswer{Method: "sendMessage", ChatID: 42, Text: "Đã nhận"}) {
		t.Errorf("answer body = %s", w.Body.String())
	}
	if w := postUpdate(t, h, "s3cret", `{"update_id":3}`); w.Code != http.StatusInternalServerError {
		t.Errorf("handler error = %d, want 500", w.Code)
	}
}

func TestWebhookHandlerDeduplicates(t *testing.T) {
	var calls atomic.Int32
	fail := atomic.Bool{}
	fail.Store(true)
	h := WebhookHandler("s3cret", func(_ context.Context, u Update) (*WebhookAnswer, error) {
		calls.Add(1)
		if u.UpdateID == 9 && fail.Load() {
			return nil, errors.New("not yet")
		}
		return nil, nil
	})
	if w := postUpdate(t, h, "s3cret", `{"update_id":5}`); w.Code != http.StatusNoContent {
		t.Fatalf("first = %d", w.Code)
	}
	if w := postUpdate(t, h, "s3cret", `{"update_id":5}`); w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Errorf("duplicate = %d %q, want 200 without body", w.Code, w.Body.String())
	}
	if calls.Load() != 1 {
		t.Errorf("handler ran %d times for one update", calls.Load())
	}
	// A failed update is not remembered: the redelivery runs.
	if w := postUpdate(t, h, "s3cret", `{"update_id":9}`); w.Code != http.StatusInternalServerError {
		t.Fatalf("failing = %d", w.Code)
	}
	fail.Store(false)
	if w := postUpdate(t, h, "s3cret", `{"update_id":9}`); w.Code != http.StatusNoContent {
		t.Errorf("redelivery = %d, want 204", w.Code)
	}
}

func TestWebhookHandlerPanicIs500(t *testing.T) {
	h := WebhookHandler("s3cret", func(context.Context, Update) (*WebhookAnswer, error) { panic("bad") })
	if w := postUpdate(t, h, "s3cret", `{"update_id":1}`); w.Code != http.StatusInternalServerError {
		t.Errorf("panic = %d, want 500", w.Code)
	}
}

func TestRecentIDsKeepsLastN(t *testing.T) {
	s := newRecentIDs(3)
	for id := int64(1); id <= 4; id++ {
		if !s.claim(id) {
			t.Fatalf("claim(%d) not new", id)
		}
	}
	if !s.claim(1) {
		t.Error("the oldest id was not forgotten")
	}
	if s.claim(4) {
		t.Error("a recent id was claimed twice")
	}
}

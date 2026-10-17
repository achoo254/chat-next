package chatbot

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	// webhookBodyMax is the largest update body the handler accepts.
	webhookBodyMax = 1 << 20
	// webhookSkew is how far X-Bot-Timestamp may be from the local clock.
	webhookSkew = 5 * time.Minute
	// dedupeSize is how many recent update ids the handler remembers.
	dedupeSize = 1000
)

// ErrWebhookRejected is wrapped by every error of VerifyWebhook.
var ErrWebhookRejected = errors.New("chatbot: webhook request rejected")

// HandlerFunc handles one update from Poll or WebhookHandler. A non-nil
// WebhookAnswer is a method for the server to run as the bot (in a webhook
// answer; Poll calls it through the API). Router.Handle is a HandlerFunc.
type HandlerFunc func(ctx context.Context, u Update) (*WebhookAnswer, error)

// VerifyWebhook checks a webhook request: X-Bot-Api-Secret-Token equals
// secret, X-Bot-Signature equals "v1=" + hex(HMAC-SHA256(secret,
// X-Bot-Timestamp + "." + body)), and the timestamp is at most 5 minutes from
// now. Comparisons run in constant time. It returns nil when the request is
// genuine, or an error wrapping ErrWebhookRejected.
func VerifyWebhook(header http.Header, body []byte, secret string, now time.Time) error {
	if secret == "" {
		return fmt.Errorf("%w: empty secret", ErrWebhookRejected)
	}
	ts := header.Get("X-Bot-Timestamp")
	sent, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || ts == "" || ts[0] < '0' || ts[0] > '9' {
		return fmt.Errorf("%w: bad timestamp", ErrWebhookRejected)
	}
	skew := now.Sub(time.Unix(sent, 0))
	if skew > webhookSkew || skew < -webhookSkew {
		return fmt.Errorf("%w: timestamp too far from the clock", ErrWebhookRejected)
	}
	if subtle.ConstantTimeCompare([]byte(header.Get("X-Bot-Api-Secret-Token")), []byte(secret)) != 1 {
		return fmt.Errorf("%w: wrong secret token", ErrWebhookRejected)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	want := "v1=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(header.Get("X-Bot-Signature")), []byte(want)) {
		return fmt.Errorf("%w: wrong signature", ErrWebhookRejected)
	}
	return nil
}

// WebhookHandler serves the bot's webhook. It accepts only POST, answers 413
// for a body over 1 MiB, 401 (no body) when VerifyWebhook fails (checked
// before the JSON is parsed), and 200 without running handle again for one of
// the last 1000 update ids it handled. Otherwise it runs handle: an answer is
// sent as 200 with its JSON, none as 204, an error as 500 so the server
// delivers the update again.
func WebhookHandler(secret string, handle HandlerFunc) http.Handler {
	return &webhookHandler{secret: secret, handle: handle, seen: newRecentIDs(dedupeSize), now: time.Now}
}

type webhookHandler struct {
	secret string
	handle HandlerFunc
	seen   *recentIDs
	now    func() time.Time
}

func (h *webhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, webhookBodyMax))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := VerifyWebhook(r.Header, body, h.secret, h.now()); err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var u Update
	if err := json.Unmarshal(body, &u); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if !h.seen.claim(u.UpdateID) {
		w.WriteHeader(http.StatusOK)
		return
	}
	answer, err := safeHandle(r.Context(), h.handle, u)
	if err != nil {
		h.seen.release(u.UpdateID)
		slog.ErrorContext(r.Context(), "chatbot: webhook handler failed", "update_id", u.UpdateID, "error", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if answer == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	b, err := json.Marshal(answer)
	if err != nil {
		slog.ErrorContext(r.Context(), "chatbot: encode webhook answer", "update_id", u.UpdateID, "error", err)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

// safeHandle runs handle and turns a panic into an error, so one bad update
// neither kills the poll loop nor stays claimed in the webhook's dedupe set.
func safeHandle(ctx context.Context, handle HandlerFunc, u Update) (answer *WebhookAnswer, err error) {
	defer func() {
		if p := recover(); p != nil {
			answer, err = nil, fmt.Errorf("chatbot: handler panicked: %v", p)
		}
	}()
	return handle(ctx, u)
}

// recentIDs remembers the last n update ids claimed, oldest dropped first.
type recentIDs struct {
	mu    sync.Mutex
	set   map[int64]struct{}
	order []int64
	n     int
}

func newRecentIDs(n int) *recentIDs {
	return &recentIDs{set: make(map[int64]struct{}, n), n: n}
}

// claim records id and reports whether it was new. An id stays claimed while
// it is handled, so a parallel redelivery is not run twice.
func (s *recentIDs) claim(id int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.set[id]; ok {
		return false
	}
	s.set[id] = struct{}{}
	s.order = append(s.order, id)
	if len(s.order) > s.n {
		delete(s.set, s.order[0])
		s.order = s.order[1:]
	}
	return true
}

// release forgets id after a failed handling so the redelivery runs.
func (s *recentIDs) release(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.set, id)
	for i, v := range s.order {
		if v == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

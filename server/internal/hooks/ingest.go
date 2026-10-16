package hooks

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"app.local/server/internal/chat"
	"app.local/server/internal/hooks/format"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
)

const requestTimeout = 10 * time.Second

var (
	hookIDPattern  = regexp.MustCompile(`^hk_[A-Za-z0-9]{12}$`)
	secretPattern  = regexp.MustCompile(`^[A-Za-z0-9]{16,128}$`)
	errBodyTooBig  = errors.New("body too large")
	errReadingBody = errors.New("cannot read body")
)

// Routes are the mux patterns of the hook endpoint.
var Routes = []string{"POST /hook/{id}/{secret}", "POST /hook/{id}/{secret}/{format}"}

// ServeHTTP is the public hook endpoint. It never logs the request path or
// the secret; failures after the hook is identified are counted, and
// unprocessable payloads go to the dead letters.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	kind := format.Native
	if suffix := r.PathValue("format"); suffix != "" {
		kind = format.Kind(suffix)
		if kind == format.Native || !kind.Valid() {
			writeError(w, format.Native, http.StatusNotFound, "hook_not_found", "")
			return
		}
	}
	if !s.onTenantHost(r) {
		writeError(w, kind, http.StatusNotFound, "hook_not_found", "")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()

	h, err := s.authenticate(ctx, r.PathValue("id"), r.PathValue("secret"))
	if err != nil {
		s.logger.Error("hook lookup failed", "err", err)
		writeError(w, kind, http.StatusServiceUnavailable, "unavailable", "")
		return
	}
	if h == nil {
		writeError(w, kind, http.StatusNotFound, "hook_not_found", "")
		return
	}
	if h.State != "active" {
		s.counters.failed(h.ID, "hook_disabled")
		writeError(w, kind, http.StatusForbidden, "hook_disabled", "the webhook is turned off in the chat")
		return
	}
	if !s.limiter.Allow(limitRequests, "hook:"+h.ID) {
		s.counters.failed(h.ID, "rate_limited")
		w.Header().Set("Retry-After", "1")
		writeError(w, kind, http.StatusTooManyRequests, "rate_limited", "too many requests; slow down")
		return
	}

	contentType := r.Header.Get("Content-Type")
	body, err := readBody(w, r)
	switch {
	case errors.Is(err, errBodyTooBig):
		s.reject(ctx, w, h, kind, contentType, body, true, http.StatusRequestEntityTooLarge, "payload_too_large",
			fmt.Sprintf("the body is larger than %d KiB", BodyMax>>10))
		return
	case err != nil:
		s.counters.failed(h.ID, "invalid_payload")
		writeError(w, kind, http.StatusBadRequest, "invalid_payload", "the body could not be read")
		return
	}

	n, err := format.Parse(kind, contentType, body, s.opts)
	if err != nil {
		if fe, ok := format.AsError(err); ok {
			s.reject(ctx, w, h, kind, contentType, body, false, http.StatusBadRequest, fe.Reason, fe.Detail)
			return
		}
		s.fail(ctx, w, h, kind, contentType, body, err)
		return
	}
	if n.Ignored {
		s.counters.accepted(h.ID)
		writeIgnored(w, kind)
		return
	}
	if n.Priority == format.PriorityAlert && !h.AllowAlert {
		n.Priority = format.PriorityTransactional
	}

	seq, err := s.deliver(ctx, h, n)
	switch {
	case err == nil:
		s.counters.accepted(h.ID)
		writeResult(w, kind, h.ChatID, seq)
	case errors.Is(err, errHookOff):
		s.counters.failed(h.ID, "hook_disabled")
		writeError(w, kind, http.StatusForbidden, "hook_disabled", "the webhook is turned off in the chat")
	case connect.CodeOf(err) == connect.CodeNotFound:
		s.counters.failed(h.ID, "chat_unavailable")
		writeError(w, kind, http.StatusGone, "chat_unavailable", "the chat of this webhook no longer exists")
	case connect.CodeOf(err) == connect.CodeInvalidArgument:
		reason, detail := "invalid_payload", connectMessage(err)
		if r, rest, ok := strings.Cut(detail, ": "); ok && r == "url_not_allowed" {
			reason, detail = r, rest
		}
		s.reject(ctx, w, h, kind, contentType, body, false, http.StatusBadRequest, reason, detail)
	default:
		s.fail(ctx, w, h, kind, contentType, body, err)
	}
}

// onTenantHost: hooks answer only on the tenant's chat host (Host header,
// set by nginx from the request).
func (s *Service) onTenantHost(r *http.Request) bool {
	host := strings.ToLower(r.Host)
	if host == s.host {
		return true
	}
	// A default port may or may not be present.
	if h, port, err := net.SplitHostPort(host); err == nil && (port == "443" || port == "80") {
		return h == s.host
	}
	return false
}

// authenticate returns the hook when id and secret match (the current
// secret, or the previous one within its grace period), nil otherwise.
// The hashes are compared in constant time.
func (s *Service) authenticate(ctx context.Context, id, secret string) (*hookRow, error) {
	if !hookIDPattern.MatchString(id) || !secretPattern.MatchString(secret) {
		return nil, nil
	}
	h, err := s.loadHook(ctx, s.pool, id, false)
	if err != nil || h == nil {
		return nil, err
	}
	hash := hashSecret(secret)
	current := subtle.ConstantTimeCompare(hash, h.SecretHash) == 1
	previous := h.PrevHash != nil && subtle.ConstantTimeCompare(hash, h.PrevHash) == 1 &&
		h.PrevExpiresAt != nil && h.PrevExpiresAt.After(time.Now())
	if !current && !previous {
		return nil, nil
	}
	return h, nil
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, BodyMax))
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		return body, errBodyTooBig
	case err != nil:
		return nil, errReadingBody
	}
	return body, nil
}

// deliver posts the notification, or updates the message of its alert
// group in place, in one transaction holding the chat lock: idempotency
// keys and alert groups of the hook are therefore never raced.
func (s *Service) deliver(ctx context.Context, h *hookRow, n *format.Notification) (int64, error) {
	msg := chat.IntegrationMessage{Label: h.Name, Text: n.Text, Entities: n.Entities, Silent: n.Silent || h.Silent, HookID: h.ID}
	for _, row := range n.Buttons {
		var out []chat.IntegrationButton
		for _, b := range row {
			out = append(out, chat.IntegrationButton{Text: b.Text, URL: b.URL})
		}
		msg.Buttons = append(msg.Buttons, out)
	}
	sourceTime := n.SourceTime
	if sourceTime.IsZero() {
		sourceTime = time.Now()
	}
	reached := func(ok bool) {
		if ok {
			s.counters.delivered(h.ID)
		}
	}
	var seq int64
	err := s.chat.WithIntegration(ctx, h.ChatID, reached, func(it *chat.IntegrationTx) error {
		seq = 0
		tx := it.Tx()
		var state string
		err := tx.QueryRow(ctx, `SELECT state FROM incoming_hooks WHERE id = $1`, h.ID).Scan(&state)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && state != "active") {
			return errHookOff
		}
		if err != nil {
			return fmt.Errorf("hooks: check hook: %w", err)
		}
		if n.IdempotencyKey != "" {
			err := tx.QueryRow(ctx, `SELECT seq FROM hook_idempotency WHERE hook_id = $1 AND key = $2 AND created_at > $3`,
				h.ID, n.IdempotencyKey, time.Now().Add(-idempotencyTTL)).Scan(&seq)
			if err == nil {
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("hooks: read idempotency key: %w", err)
			}
		}
		if n.GroupKey != "" {
			if seq, err = s.deliverGroup(ctx, it, h, n, msg, sourceTime); err != nil {
				return err
			}
		} else if seq, err = it.Post(ctx, msg); err != nil {
			return err
		}
		if n.IdempotencyKey != "" {
			if _, err := tx.Exec(ctx, `
				INSERT INTO hook_idempotency (hook_id, key, chat_id, seq) VALUES ($1, $2, $3, $4)
				ON CONFLICT (hook_id, key) DO UPDATE SET seq = excluded.seq, chat_id = excluded.chat_id, created_at = now()`,
				h.ID, n.IdempotencyKey, h.ChatID, seq); err != nil {
				return fmt.Errorf("hooks: store idempotency key: %w", err)
			}
		}
		return nil
	})
	return seq, err
}

// deliverGroup updates the group's message in place, or posts a new one
// when the group is new or its message is gone. A payload older (by source
// time) than the group's last update changes nothing, so a late firing
// never overwrites resolved. Only a change of status notifies again.
func (s *Service) deliverGroup(ctx context.Context, it *chat.IntegrationTx, h *hookRow, n *format.Notification, msg chat.IntegrationMessage, sourceTime time.Time) (int64, error) {
	tx := it.Tx()
	var (
		seq      int64
		status   string
		lastTime time.Time
	)
	err := tx.QueryRow(ctx, `SELECT seq, status, source_ts FROM notify_groups WHERE hook_id = $1 AND group_key = $2 FOR UPDATE`,
		h.ID, n.GroupKey).Scan(&seq, &status, &lastTime)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		seq = 0
	case err != nil:
		return 0, fmt.Errorf("hooks: read alert group: %w", err)
	case sourceTime.Before(lastTime):
		return seq, nil
	default:
		notify := n.Status != "" && n.Status != status && !msg.Silent
		edited, err := it.Edit(ctx, seq, msg, notify)
		if err != nil {
			return 0, err
		}
		if !edited {
			seq = 0
		}
	}
	if seq == 0 {
		if seq, err = it.Post(ctx, msg); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO notify_groups (hook_id, group_key, chat_id, seq, status, source_ts) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (hook_id, group_key) DO UPDATE SET seq = excluded.seq, status = excluded.status,
			source_ts = excluded.source_ts, updated_at = now()`,
		h.ID, n.GroupKey, h.ChatID, seq, n.Status, sourceTime); err != nil {
		return 0, fmt.Errorf("hooks: store alert group: %w", err)
	}
	return seq, nil
}

// reject answers a payload the hook cannot process, counts it and keeps it
// as a dead letter (within the hook's dead letter budget).
func (s *Service) reject(ctx context.Context, w http.ResponseWriter, h *hookRow, kind format.Kind, contentType string, body []byte, truncated bool, status int, reason, detail string) {
	s.counters.failed(h.ID, reason)
	s.deadLetter(ctx, h, contentType, body, truncated, status, reason, detail)
	writeError(w, kind, status, reason, detail)
}

// fail answers an unexpected server error: logged with the hook id only.
func (s *Service) fail(ctx context.Context, w http.ResponseWriter, h *hookRow, kind format.Kind, contentType string, body []byte, err error) {
	s.logger.Error("hook delivery failed", "hook_id", h.ID, "err", err)
	s.counters.failed(h.ID, "internal")
	s.deadLetter(ctx, h, contentType, body, false, http.StatusInternalServerError, "internal", "server error")
	writeError(w, kind, http.StatusInternalServerError, "internal", "")
}

func (s *Service) deadLetter(ctx context.Context, h *hookRow, contentType string, body []byte, truncated bool, status int, reason, detail string) {
	if !s.limiter.Allow(limitDeadLetters, "hook-dead:"+h.ID) {
		return
	}
	if len(body) > deadLetterMax {
		body, truncated = body[:deadLetterMax], true
	}
	if body == nil {
		body = []byte{}
	}
	if len(contentType) > 200 {
		contentType = contentType[:200]
	}
	if _, err := s.pool.Exec(context.WithoutCancel(ctx), `
		INSERT INTO hook_dead_letters (hook_id, reason, detail, http_status, content_type, body, body_truncated)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, h.ID, reason, strings.ToValidUTF8(detail, ""),
		status, strings.ToValidUTF8(contentType, ""), body, truncated); err != nil {
		s.logger.Warn("hook dead letter not stored", "hook_id", h.ID, "err", err)
	}
}

func connectMessage(err error) string {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Message()
	}
	return ""
}

// ------------------------------------------------------------- responses

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeText(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, text)
}

// writeResult answers success: the text "ok" for Slack-compatible senders
// (Grafana compares it byte for byte), {chat_id, seq} otherwise.
func writeResult(w http.ResponseWriter, kind format.Kind, chatID, seq int64) {
	if kind == format.Slack {
		writeText(w, http.StatusOK, "ok")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"chat_id": chatID, "seq": seq})
}

func writeIgnored(w http.ResponseWriter, kind format.Kind) {
	if kind == format.Slack {
		writeText(w, http.StatusOK, "ok")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ignored": true})
}

// writeError answers a failure: Slack's style (the code as text) for
// Slack-compatible senders, {"error", "description"} otherwise.
func writeError(w http.ResponseWriter, kind format.Kind, status int, reason, detail string) {
	if kind == format.Slack {
		writeText(w, status, reason)
		return
	}
	body := map[string]string{"error": reason}
	if detail != "" {
		body["description"] = detail
	}
	writeJSON(w, status, body)
}

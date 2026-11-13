package accountdeleted_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app.local/server/internal/accountdeleted"
	"app.local/server/internal/auth"
	"app.local/server/internal/privacy"
)

// The end-to-end flow (a real SET, the erasure) is in
// internal/api/privacy_test.go; these cover the answers the IdP retries on.

type fakeVerifier struct{ err error }

func (f fakeVerifier) VerifySecurityEvent(_ context.Context, _, audience, event string) (auth.SecurityEvent, error) {
	if f.err != nil {
		return auth.SecurityEvent{}, f.err
	}
	if audience != "https://chat.example.test"+accountdeleted.Path || event != accountdeleted.Event {
		return auth.SecurityEvent{}, fmt.Errorf("%w: audience %q event %q", auth.ErrInvalidToken, audience, event)
	}
	return auth.SecurityEvent{Subject: "acc_secret_sub", JTI: "jti-1"}, nil
}

type fakeDeleter struct {
	res   privacy.DeletionResult
	err   error
	calls []string
}

func (f *fakeDeleter) DeleteIdPAccount(ctx context.Context, sub string) (privacy.DeletionResult, error) {
	f.calls = append(f.calls, sub)
	if ctx.Err() != nil {
		return privacy.DeletionResult{}, ctx.Err()
	}
	return f.res, f.err
}

func serve(t *testing.T, v accountdeleted.Verifier, d accountdeleted.Deleter, logs *bytes.Buffer, body string) *httptest.ResponseRecorder {
	t.Helper()
	h, err := accountdeleted.New(accountdeleted.Config{Audience: "https://chat.example.test" + accountdeleted.Path}, v, d,
		slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Register(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, accountdeleted.Path, strings.NewReader(body)))
	return rec
}

const set = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"

func TestAnswers(t *testing.T) {
	for _, tc := range []struct {
		name     string
		verifier fakeVerifier
		deleter  *fakeDeleter
		body     string
		status   int
		deletes  bool
	}{
		{name: "erased", deleter: &fakeDeleter{res: privacy.DeletionResult{UserID: 7, Erased: true}}, body: set, status: http.StatusAccepted, deletes: true},
		{name: "queued for the job", deleter: &fakeDeleter{res: privacy.DeletionResult{UserID: 7}}, body: set, status: http.StatusAccepted, deletes: true},
		{name: "no chat account", deleter: &fakeDeleter{}, body: set, status: http.StatusAccepted, deletes: true},
		{name: "not queued", deleter: &fakeDeleter{err: errors.New("db down")}, body: set, status: http.StatusInternalServerError, deletes: true},
		{name: "IdP not discovered", verifier: fakeVerifier{err: auth.ErrIdPUnavailable}, deleter: &fakeDeleter{}, body: set, status: http.StatusServiceUnavailable},
		{name: "not a SET", verifier: fakeVerifier{err: auth.ErrNotSecurityEvent}, deleter: &fakeDeleter{}, body: set, status: http.StatusBadRequest},
		{name: "bad SET", verifier: fakeVerifier{err: auth.ErrInvalidToken}, deleter: &fakeDeleter{}, body: set, status: http.StatusUnauthorized},
		{name: "two parts", deleter: &fakeDeleter{}, body: "a.b", status: http.StatusBadRequest},
		{name: "too large", deleter: &fakeDeleter{}, body: strings.Repeat("a", 17<<10) + ".b.c", status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := &bytes.Buffer{}
			rec := serve(t, tc.verifier, tc.deleter, logs, tc.body)
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d (%s)", rec.Code, tc.status, rec.Body)
			}
			if got := len(tc.deleter.calls) == 1 && tc.deleter.calls[0] == "acc_secret_sub"; got != tc.deletes {
				t.Fatalf("deleter calls %v", tc.deleter.calls)
			}
			if tc.status == http.StatusServiceUnavailable && rec.Header().Get("Retry-After") == "" {
				t.Fatal("503 without Retry-After")
			}
			if strings.Contains(logs.String(), "acc_secret_sub") || strings.Contains(logs.String(), set) {
				t.Fatalf("the sub or the SET reached the log:\n%s", logs)
			}
		})
	}
}

func TestNewRejectsMissingParts(t *testing.T) {
	quiet := slog.New(slog.DiscardHandler)
	if _, err := accountdeleted.New(accountdeleted.Config{}, fakeVerifier{}, &fakeDeleter{}, quiet); err == nil {
		t.Fatal("no audience accepted")
	}
	if _, err := accountdeleted.New(accountdeleted.Config{Audience: "x"}, nil, &fakeDeleter{}, quiet); err == nil {
		t.Fatal("no verifier accepted")
	}
}

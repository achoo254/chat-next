package agentgrant

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"app.local/server/internal/store"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestHTTPClient(t *testing.T) {
	var status int
	var got map[string]string
	var user, pass, contentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, _ = r.BasicAuth()
		contentType = r.Header.Get("Content-Type")
		if r.Method != http.MethodPost {
			t.Errorf("method %s", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":"x"}`))
	}))
	t.Cleanup(srv.Close)
	c, err := NewHTTPClient(srv.URL+"/api/tunelo-agent/grants/revoke", "chat-web", "s:ecret", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	for code, want := range map[int]string{
		http.StatusNoContent: "ok", http.StatusOK: "ok",
		http.StatusBadRequest: "permanent", http.StatusNotFound: "permanent",
		http.StatusUnauthorized: "retry", http.StatusBadGateway: "retry", http.StatusInternalServerError: "retry",
	} {
		status = code
		err := c.Revoke(context.Background(), "acc_1", "g-1")
		var kind string
		switch {
		case err == nil:
			kind = "ok"
		case errors.Is(err, ErrPermanent):
			kind = "permanent"
		default:
			kind = "retry"
		}
		if kind != want {
			t.Errorf("status %d: %v", code, err)
		}
	}
	// Credentials are form-encoded before Basic, as RFC 6749 §2.3.1 says.
	if got["sub"] != "acc_1" || got["grant_id"] != "g-1" || user != "chat-web" || pass != "s%3Aecret" || contentType != "application/json" {
		t.Fatalf("request %v as %q:%q (%s)", got, user, pass, contentType)
	}

	for _, bad := range []struct{ url, id, secret string }{
		{"", "chat-web", "s"}, {"/relative", "chat-web", "s"}, {"ftp://x/y", "chat-web", "s"}, {srv.URL, "", "s"}, {srv.URL, "chat-web", ""},
	} {
		if _, err := NewHTTPClient(bad.url, bad.id, bad.secret, nil); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

type fakeStore struct {
	mu      sync.Mutex
	pending []store.GrantRevocation
	marked  []int64
}

func (f *fakeStore) PendingGrantRevocations(_ context.Context, _ string, _ int) ([]store.GrantRevocation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]store.GrantRevocation(nil), f.pending...), nil
}

func (f *fakeStore) MarkGrantRevoked(_ context.Context, _ string, machineID int64, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.marked = append(f.marked, machineID)
	kept := f.pending[:0]
	for _, g := range f.pending {
		if g.MachineID != machineID {
			kept = append(kept, g)
		}
	}
	f.pending = kept
	return nil
}

type fakeClient map[string]error

func (f fakeClient) Revoke(_ context.Context, _, grantID string) error { return f[grantID] }

func TestRunOnce(t *testing.T) {
	st := &fakeStore{pending: []store.GrantRevocation{
		{MachineID: 1, OwnerSub: "acc_1", GrantID: "ok"},
		{MachineID: 2, OwnerSub: "acc_1", GrantID: "down"},
		{MachineID: 3, OwnerSub: "acc_1", GrantID: "unknown"},
	}}
	client := fakeClient{"down": errors.New("status 502"), "unknown": ErrPermanent}
	r := New(st, client, "primary", quiet)
	done, err := r.RunOnce(context.Background())
	if err != nil || done != 2 {
		t.Fatalf("done %d: %v", done, err)
	}
	if len(st.pending) != 1 || st.pending[0].MachineID != 2 {
		t.Fatalf("still pending %+v", st.pending)
	}
	// The IdP is back: the last one goes.
	delete(client, "down")
	if done, err := r.RunOnce(context.Background()); err != nil || done != 1 || len(st.pending) != 0 {
		t.Fatalf("second pass %d %v %+v", done, err, st.pending)
	}

	// Off without a client: nothing is touched, Kick never blocks.
	off := New(&fakeStore{pending: []store.GrantRevocation{{MachineID: 9, GrantID: "g"}}}, nil, "primary", quiet)
	if done, err := off.RunOnce(context.Background()); done != 0 || err != nil {
		t.Fatalf("off: %d %v", done, err)
	}
	off.Kick()
	off.Kick()
	off.Run(context.Background())
}

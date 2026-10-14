package api_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"app.local/server/internal/auth/idptest"
	"connectrpc.com/connect"
)

func TestGrantCheckInvalidGrantRevokes(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	id := currentSessionID(t, cl)
	e.makeGrantDue(t, id)
	e.idp.SetRefresh(idptest.RefreshInvalidGrant, 0)

	// The request that notices the stale check is served; the check runs in
	// the background and ends the session.
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("request during the check failed: %v", err)
	}
	e.app.Sessions.Wait()
	if e.idp.RefreshCalls() != 1 {
		t.Fatalf("refresh calls = %d", e.idp.RefreshCalls())
	}
	if _, err := getSelf(t, cl); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("session survived invalid_grant: %v", err)
	}
}

func TestGrantCheckServerErrorKeepsSession(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	id := currentSessionID(t, cl)
	e.makeGrantDue(t, id)
	e.idp.SetRefresh(idptest.RefreshServerError, 0)

	if _, err := getSelf(t, cl); err != nil {
		t.Fatal(err)
	}
	e.app.Sessions.Wait()
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("IdP 5xx revoked the session: %v", err)
	}
	e.app.Sessions.Wait()
	// The failed check is retried later, not on every request.
	if n := e.idp.RefreshCalls(); n != 1 {
		t.Fatalf("refresh calls = %d, want 1", n)
	}
}

func TestGrantCheckConcurrentRequestsRefreshOnce(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	id := currentSessionID(t, cl)
	e.makeGrantDue(t, id)
	e.idp.SetRefresh(idptest.RefreshOK, 200*time.Millisecond)

	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if _, err := getSelf(t, cl); err != nil {
				t.Error(err)
			}
		})
		// Direct checks bypass the in-process dedupe, like another server
		// process would; the row lock still keeps them exclusive.
		wg.Go(func() {
			if _, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	e.app.Sessions.Wait()
	if n := e.idp.RefreshCalls(); n != 1 {
		t.Fatalf("refresh calls = %d, want 1", n)
	}

	// The rotated refresh token was stored: the next check succeeds (the
	// fake IdP rejects a reused token with invalid_grant).
	e.makeGrantDue(t, id)
	e.idp.SetRefresh(idptest.RefreshOK, 0)
	if ran, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil || !ran {
		t.Fatalf("second check: %v, %v", ran, err)
	}
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("session lost after rotation: %v", err)
	}
	if n := e.idp.RefreshCalls(); n != 2 {
		t.Fatalf("refresh calls = %d, want 2", n)
	}
}

func TestGrantCheckRefreshesEmail(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	id := currentSessionID(t, cl)
	e.makeGrantDue(t, id)
	e.idp.SetAccount(idptest.Account{Sub: "acc_test", SID: "sid-1", PreferredUsername: "tester",
		Email: "tester@example.com", EmailVerified: false})
	if _, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	u, err := getSelf(t, cl)
	if err != nil {
		t.Fatal(err)
	}
	if u.GetEmail() != "" {
		t.Fatalf("unverified email kept: %v", u)
	}
}

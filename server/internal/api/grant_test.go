package api_test

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
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

func TestGrantCheckRefreshesIdPPicture(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	if u, err := getSelf(t, cl); err != nil || u.GetIdpPicture() != "" {
		t.Fatalf("picture before the IdP has one: %v, %v", u, err)
	}
	const picture = "https://avatars.githubusercontent.com/u/1"
	id := currentSessionID(t, cl)
	e.makeGrantDue(t, id)
	e.idp.SetAccount(idptest.Account{Sub: "acc_test", SID: "sid-1", PreferredUsername: "tester",
		Email: "tester@example.com", EmailVerified: true, Picture: picture})
	if _, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if u, err := getSelf(t, cl); err != nil || u.GetIdpPicture() != picture {
		t.Fatalf("GetSelf after the grant check: %v, %v", u, err)
	}
}

func TestGrantCheckStoresRotatedTokenWhenClaimsFail(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	id := currentSessionID(t, cl)
	e.makeGrantDue(t, id)
	// The token endpoint rotates the refresh token, but the ID token does
	// not verify (as with a JWKS outage).
	e.idp.SetRefresh(idptest.RefreshBadIDToken, 0)
	e.idp.SetAccount(idptest.Account{Sub: "acc_test", SID: "sid-1", PreferredUsername: "tester",
		Email: "changed@example.com", EmailVerified: true})
	if ran, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil || !ran {
		t.Fatalf("check with unverifiable claims: %v, %v", ran, err)
	}
	u, err := getSelf(t, cl)
	if err != nil {
		t.Fatalf("session lost: %v", err)
	}
	if u.GetEmail() != "tester@example.com" {
		t.Fatalf("email taken from unverified claims: %q", u.GetEmail())
	}

	// The rotated token was stored: the next refresh is accepted (the fake
	// IdP answers invalid_grant to the already-used token).
	e.makeGrantDue(t, id)
	e.idp.SetRefresh(idptest.RefreshOK, 0)
	if ran, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil || !ran {
		t.Fatalf("next check: %v, %v", ran, err)
	}
	if u, err := getSelf(t, cl); err != nil || u.GetEmail() != "changed@example.com" {
		t.Fatalf("after next check: %v, %v", u, err)
	}
	if n := e.idp.RefreshCalls(); n != 2 {
		t.Fatalf("refresh calls = %d, want 2", n)
	}
}

func TestGrantCheckRejectedClientLogsError(t *testing.T) {
	e := newEnv(t)
	cl, _ := e.signedIn(t)
	id := currentSessionID(t, cl)
	e.makeGrantDue(t, id)
	e.idp.SetRefresh(idptest.RefreshInvalidClient, 0)
	if ran, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil || !ran {
		t.Fatalf("check: %v, %v", ran, err)
	}
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("invalid_client revoked the session: %v", err)
	}
	logs := e.logs.String()
	var line string
	for l := range strings.Lines(logs) {
		if strings.Contains(l, "IdP rejected the refresh request") {
			line = l
		}
	}
	if !strings.Contains(line, "level=ERROR") || !strings.Contains(line, "invalid_client") || !strings.Contains(line, "status 401") {
		t.Fatalf("no error log for invalid_client; logs:\n%s", logs)
	}
	if strings.Contains(logs, clientSecret) || strings.Contains(logs, "rt-") {
		t.Fatal("logs contain a secret or a refresh token")
	}
	// Like an outage, the check is retried later rather than on every request.
	if ran, err := e.app.Sessions.CheckGrant(context.Background(), id); err != nil || ran {
		t.Fatalf("immediate re-check: %v, %v", ran, err)
	}
}

func TestGrantCheckHoldsNoLockDuringIdPCall(t *testing.T) {
	e := newEnv(t)
	victim, victimBrowser := e.signedIn(t)
	other, _ := e.signedIn(t)
	id := currentSessionID(t, victim)
	e.makeGrantDue(t, id)
	arrived, release := e.idp.HoldRefresh(t)

	type result struct {
		ran bool
		err error
	}
	done := make(chan result, 1)
	go func() {
		ran, err := e.app.Sessions.CheckGrant(context.Background(), id)
		done <- result{ran, err}
	}()
	select {
	case <-arrived:
	case <-time.After(10 * time.Second):
		t.Fatal("refresh never reached the IdP")
	}

	// While the IdP holds the refresh, revocation, logout and back-channel
	// logout of the session go through without waiting for it.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := other.auth.RevokeSession(ctx, connect.NewRequest(&appv1.RevokeSessionRequest{SessionId: id})); err != nil {
		t.Fatalf("RevokeSession during the IdP call: %v", err)
	}
	if loc := e.postLogout(t, victimBrowser); loc != "/" {
		t.Fatalf("logout of a session revoked by another one redirected to %q", loc)
	}
	if code := postLogoutToken(t, e, e.idp.LogoutToken(t, e.idp.LogoutClaims("sid-1"))); code != http.StatusOK {
		t.Fatalf("back-channel logout status %d", code)
	}

	release()
	select {
	case r := <-done:
		if r.err != nil || !r.ran {
			t.Fatalf("check = %v, %v", r.ran, r.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("grant check did not finish")
	}
	if _, err := getSelf(t, victim); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("grant check revived a revoked session: %v", err)
	}
	// The original token was revoked by RevokeSession, and the token the IdP
	// rotated during the check, which could no longer be stored, by the check.
	e.app.Sessions.Wait()
	if got := e.idp.Revoked(); len(got) != 2 || got[0] == got[1] {
		t.Fatalf("revoked at IdP = %v, want the old and the rotated token", got)
	}
	if n := e.idp.RefreshCalls(); n != 1 {
		t.Fatalf("refresh calls = %d, want 1", n)
	}
}

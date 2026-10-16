package api_test

import (
	"bytes"
	"context"
	"testing"

	"app.local/server/internal/api"
	"app.local/server/internal/auth"
	"app.local/server/internal/config"
	"app.local/server/internal/sealbox"
	"app.local/server/internal/store"
)

var (
	oldKey = bytes.Repeat([]byte{42}, 32)
	newKey = bytes.Repeat([]byte{43}, 32)
)

// sealUnder rewrites the session's stored IdP tokens as if master had
// sealed them (opening them with from), and returns the stored row.
func sealUnder(t *testing.T, e *env, from, master []byte) store.SealedSession {
	t.Helper()
	ctx := context.Background()
	rows, err := e.store.SealedSessions(ctx, tenantID, 0, 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("sealed sessions: %v, %v", rows, err)
	}
	next := rows[0]
	for _, f := range []struct {
		purpose string
		val     *[]byte
	}{{"idp refresh token", &next.RefreshTokenEnc}, {"idp id token", &next.IDTokenEnc}} {
		src, _ := sealbox.New(from, f.purpose)
		dst, _ := sealbox.New(master, f.purpose)
		plain, err := src.Open(*f.val, next.TokenHash)
		if err != nil {
			t.Fatalf("%s: %v", f.purpose, err)
		}
		*f.val = dst.Seal(plain, next.TokenHash)
	}
	if ok, err := e.store.ReplaceSealedTokens(ctx, rows[0], next); err != nil || !ok {
		t.Fatalf("replace: %v, %v", ok, err)
	}
	return next
}

func resealSessions(t *testing.T, e *env, previous []byte) sealbox.Count {
	t.Helper()
	n, err := auth.ResealSessions(context.Background(), e.store, tenantID, newKey, previous)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// The api runs with SESSION_KEY rotated to newKey and SESSION_KEY_PREVIOUS
// = oldKey: a session whose IdP tokens were sealed under oldKey keeps its
// grant and moves to newKey on its next grant check; the reseal role moves
// the rest, and without the previous key nothing is left unreadable.
func TestSessionTokensAcrossAKeyRotation(t *testing.T) {
	e := newEnv(t, func(c *config.Config, _ *api.Options) { c.SessionKey, c.SessionKeyPrevious = newKey, oldKey })
	cl, _ := e.signedIn(t)
	id := currentSessionID(t, cl)
	refresh, _ := sealbox.New(newKey, "idp refresh token")

	// On use: a grant check seals the tokens again.
	sealUnder(t, e, newKey, oldKey)
	e.makeGrantDue(t, id)
	if _, err := getSelf(t, cl); err != nil {
		t.Fatal(err)
	}
	e.app.Sessions.Wait()
	if _, err := getSelf(t, cl); err != nil {
		t.Fatalf("session after a grant check under the previous key: %v", err)
	}
	if e.idp.RefreshCalls() != 1 {
		t.Fatalf("refresh calls = %d", e.idp.RefreshCalls())
	}
	if n := resealSessions(t, e, nil); n.Current != 1 || n.Unreadable != 0 {
		t.Fatalf("after the grant check: %+v", n)
	}

	// In bulk: the reseal role.
	stale := sealUnder(t, e, newKey, oldKey)
	if !refresh.Stale(stale.RefreshTokenEnc) {
		t.Fatal("the rewritten token is current")
	}
	if n := resealSessions(t, e, nil); n.Unreadable != 1 {
		t.Fatalf("without the previous key: %+v", n)
	}
	if n := resealSessions(t, e, oldKey); n.Resealed != 1 || n.Unreadable != 0 {
		t.Fatalf("with the previous key: %+v", n)
	}
	if n := resealSessions(t, e, nil); n.Current != 1 || n.Resealed != 0 || n.Unreadable != 0 {
		t.Fatalf("after the reseal: %+v", n)
	}

	// An ID token under a key nobody has does not hold back the refresh token.
	row := sealUnder(t, e, newKey, oldKey)
	lost := row
	lostBox, _ := sealbox.New(bytes.Repeat([]byte{44}, 32), "idp id token")
	lost.IDTokenEnc = lostBox.Seal([]byte("x"), row.TokenHash)
	if ok, err := e.store.ReplaceSealedTokens(context.Background(), row, lost); err != nil || !ok {
		t.Fatalf("replace: %v, %v", ok, err)
	}
	if n := resealSessions(t, e, oldKey); n.Unreadable != 1 {
		t.Fatalf("with an unreadable ID token: %+v", n)
	}
	rows, err := e.store.SealedSessions(context.Background(), tenantID, 0, 10)
	if err != nil || refresh.Stale(rows[0].RefreshTokenEnc) || !bytes.Equal(rows[0].IDTokenEnc, lost.IDTokenEnc) {
		t.Fatalf("the refresh token did not move or the ID token changed: %v", err)
	}
}

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"app.local/server/internal/ids"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
)

const tenant = "primary"

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	s := testdb.Open(t)
	if err := s.EnsureTenant(context.Background(), tenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	return s
}

func hashOf(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

func TestUpsertIdPUser(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)

	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{
		Sub: "acc_1", PreferredUsername: "Dat", Name: "Đạt",
		Email: store.IdPEmail{Email: "dat@example.com", Verified: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "dat" || u.Name != "Đạt" || u.Email != "dat@example.com" || !u.EmailVerified {
		t.Fatalf("created user = %+v", u)
	}
	if err := ids.CheckSafe(u.ID); err != nil || u.ID <= 0 {
		t.Fatalf("user id %d: %v", u.ID, err)
	}

	// Same subject again: same user, profile kept, unverified email dropped.
	again, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{
		Sub: "acc_1", PreferredUsername: "other", Name: "Other",
		Email: store.IdPEmail{Email: "dat@example.com", Verified: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != u.ID || again.Username != "dat" || again.Name != "Đạt" || again.Email != "" || again.EmailVerified {
		t.Fatalf("second sign-in user = %+v", again)
	}

	// Another subject with the same preferred username gets digits.
	other, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	if other.Username != "dat2" || other.Name != "dat" {
		t.Fatalf("conflicting user = %+v", other)
	}
}

func TestUpsertIdPUserNameFromIdP(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	verified := store.IdPEmail{Email: "an@example.com", Verified: true}

	// First sign-in without a display name: the name falls back to the
	// preferred username.
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_an", PreferredUsername: "AnNguyen", Email: verified})
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "annguyen" || u.Name != "AnNguyen" {
		t.Fatalf("created user = %+v", u)
	}

	// The IdP now reports a name: it replaces the fallback.
	u, err = s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_an", PreferredUsername: "AnNguyen", Name: " Nguyễn Văn An ", Email: verified})
	if err != nil {
		t.Fatal(err)
	}
	if u.Name != "Nguyễn Văn An" || u.Email != "an@example.com" {
		t.Fatalf("fallback name not replaced: %+v", u)
	}

	// A name the user chose is never overwritten.
	if _, err := s.UpdateProfile(ctx, tenant, u.ID, ptr("Anh An"), nil); err != nil {
		t.Fatal(err)
	}
	u, err = s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_an", PreferredUsername: "AnNguyen", Name: "Nguyễn Văn An", Email: verified})
	if err != nil {
		t.Fatal(err)
	}
	if u.Name != "Anh An" {
		t.Fatalf("user-chosen name overwritten: %+v", u)
	}

	// A name equal to the username is still the fallback; an unknown email
	// state keeps the stored email.
	if _, err := s.UpdateProfile(ctx, tenant, u.ID, ptr("annguyen"), nil); err != nil {
		t.Fatal(err)
	}
	u, err = s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_an", PreferredUsername: "AnNguyen", Name: "Nguyễn Văn An", EmailUnknown: true})
	if err != nil {
		t.Fatal(err)
	}
	if u.Name != "Nguyễn Văn An" || u.Email != "an@example.com" || !u.EmailVerified {
		t.Fatalf("username-equal name or unknown email: %+v", u)
	}

	// No IdP name (or only blanks) keeps the stored name.
	if _, err := s.UpdateProfile(ctx, tenant, u.ID, ptr("annguyen"), nil); err != nil {
		t.Fatal(err)
	}
	u, err = s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_an", PreferredUsername: "AnNguyen", Name: " \t", Email: verified})
	if err != nil {
		t.Fatal(err)
	}
	if u.Name != "annguyen" {
		t.Fatalf("blank IdP name applied: %+v", u)
	}
}

func ptr[T any](v T) *T { return &v }

func TestUpsertIdPUserConcurrentFirstSignIn(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	var wg sync.WaitGroup
	got := make([]int64, 8)
	for i := range got {
		wg.Go(func() {
			u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_same", PreferredUsername: "same"})
			if err != nil {
				t.Error(err)
				return
			}
			got[i] = u.ID
		})
	}
	wg.Wait()
	for _, id := range got {
		if id != got[0] {
			t.Fatalf("concurrent sign-ins created different users: %v", got)
		}
	}
}

func TestSetUsernameAndProfile(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_a", PreferredUsername: "alice"})
	b, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_b", PreferredUsername: "bob"})

	if _, err := s.SetUsername(ctx, tenant, b.ID, "alice"); !errors.Is(err, store.ErrUsernameTaken) {
		t.Fatalf("taken username err = %v", err)
	}
	u, err := s.SetUsername(ctx, tenant, b.ID, "bobby")
	if err != nil || u.Username != "bobby" {
		t.Fatalf("SetUsername = %+v, %v", u, err)
	}
	name, bio := "Alice", "xin chào"
	u, err = s.UpdateProfile(ctx, tenant, a.ID, &name, &bio)
	if err != nil || u.Name != "Alice" || u.Bio != "xin chào" {
		t.Fatalf("UpdateProfile = %+v, %v", u, err)
	}
	u, err = s.UpdateProfile(ctx, tenant, a.ID, nil, nil)
	if err != nil || u.Name != "Alice" || u.Bio != "xin chào" {
		t.Fatalf("UpdateProfile(nil, nil) = %+v, %v", u, err)
	}
	if _, err := s.UserByID(ctx, "other", a.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-tenant lookup err = %v", err)
	}
}

func newSession(t *testing.T, s *store.Store, userID int64, token, sid string) int64 {
	t.Helper()
	id, err := s.CreateSession(context.Background(), store.NewSession{
		TokenHash: hashOf(token), TenantID: tenant, UserID: userID, IdPSID: sid,
		IdPClientID: "chat-web", RefreshTokenEnc: []byte("rt-" + token), IDTokenEnc: []byte("idt-" + token),
		UserAgent: "test", IP: "203.0.113.7",
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSessionsLifecycle(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_s", PreferredUsername: "sess"})
	id1 := newSession(t, s, u.ID, "one", "sid-1")
	id2 := newSession(t, s, u.ID, "two", "sid-2")
	id3 := newSession(t, s, u.ID, "three", "sid-3")

	got, err := s.ActiveSession(ctx, tenant, hashOf("one"))
	if err != nil || got.ID != id1 || got.IP != "203.0.113.7" || got.IdPSID != "sid-1" {
		t.Fatalf("ActiveSession = %+v, %v", got, err)
	}
	if _, err := s.ActiveSession(ctx, "other", hashOf("one")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("other tenant err = %v", err)
	}
	if st, err := s.TouchSession(ctx, id1, time.Minute); err != nil || !st.Active {
		t.Fatalf("TouchSession of an active session = %+v, %v", st, err)
	}

	r, err := s.RevokeSession(ctx, tenant, u.ID, id2, nil)
	if err != nil || r.ID != id2 || string(r.RefreshTokenEnc) != "rt-two" {
		t.Fatalf("RevokeSession = %+v, %v", r, err)
	}
	if _, err := s.RevokeSession(ctx, tenant, u.ID, id2, nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second revoke err = %v", err)
	}
	// The realtime gateway learns of the revocation from TouchSession.
	if st, err := s.TouchSession(ctx, id2, time.Minute); err != nil || st.Active || st.RevokeReason != 2 {
		t.Fatalf("TouchSession of a revoked session = %+v, %v", st, err)
	}
	if st, err := s.TouchSession(ctx, 1<<40, time.Minute); err != nil || st.Active {
		t.Fatalf("TouchSession of a missing session = %+v, %v", st, err)
	}
	others, err := s.RevokeOtherSessions(ctx, tenant, u.ID, id1)
	if err != nil || len(others) != 1 || others[0].ID != id3 {
		t.Fatalf("RevokeOtherSessions = %+v, %v", others, err)
	}
	list, err := s.ListActiveSessions(ctx, tenant, u.ID)
	if err != nil || len(list) != 1 || list[0].ID != id1 {
		t.Fatalf("ListActiveSessions = %+v, %v", list, err)
	}

	// Logout hands the ID token out once, even after the session was revoked.
	if _, err := s.RevokeSession(ctx, tenant, u.ID, id1, hashOf("one")); err != nil {
		t.Fatal(err)
	}
	end, err := s.EndSessionForLogout(ctx, tenant, hashOf("one"))
	if err != nil || string(end.IDTokenEnc) != "idt-one" || end.RefreshTokenEnc != nil {
		t.Fatalf("EndSessionForLogout = %+v, %v", end, err)
	}
	end, err = s.EndSessionForLogout(ctx, tenant, hashOf("one"))
	if err != nil || end.IDTokenEnc != nil {
		t.Fatalf("second EndSessionForLogout = %+v, %v", end, err)
	}
	if _, err := s.EndSessionForLogout(ctx, tenant, hashOf("nope")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token err = %v", err)
	}

	// Sessions revoked from another session keep no ID token.
	for _, token := range []string{"two", "three"} {
		end, err := s.EndSessionForLogout(ctx, tenant, hashOf(token))
		if err != nil || end.IDTokenEnc != nil || end.RefreshTokenEnc != nil {
			t.Fatalf("EndSessionForLogout(%s) = %+v, %v", token, end, err)
		}
	}
}

func TestBackchannelLogout(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_b", PreferredUsername: "bc"})
	newSession(t, s, u.ID, "a", "sid-a")
	newSession(t, s, u.ID, "b", "sid-b")
	newSession(t, s, u.ID, "c", "sid-c")

	fresh, n, err := s.BackchannelLogout(ctx, tenant, "chat-web", "jti-1", 10*time.Minute, "sid-a", "acc_b")
	if err != nil || !fresh || n != 1 {
		t.Fatalf("by sid = %v, %d, %v", fresh, n, err)
	}
	fresh, n, err = s.BackchannelLogout(ctx, tenant, "chat-web", "jti-1", 10*time.Minute, "sid-b", "acc_b")
	if err != nil || fresh || n != 0 {
		t.Fatalf("replay = %v, %d, %v", fresh, n, err)
	}
	fresh, n, err = s.BackchannelLogout(ctx, tenant, "chat-web", "jti-2", 10*time.Minute, "", "acc_b")
	if err != nil || !fresh || n != 2 {
		t.Fatalf("by sub = %v, %d, %v", fresh, n, err)
	}
}

// makeDue backdates the last grant check of a session by two hours.
func makeDue(t *testing.T, s *store.Store, id int64) {
	t.Helper()
	// A negative interval makes any check time due; the retry then stores
	// now - interval + RetryAfter = now - 2h.
	ran, err := s.CheckGrant(context.Background(), id, -48*time.Hour, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		return store.GrantOutcome{Result: store.GrantRetry, RetryAfter: -50 * time.Hour}
	})
	if err != nil || !ran {
		t.Fatalf("makeDue: %v, %v", ran, err)
	}
}

func TestCheckGrantRunsOnceUnderConcurrency(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_g", PreferredUsername: "grant"})
	id := newSession(t, s, u.ID, "g", "sid-g")

	makeDue(t, s, id)
	var calls atomic.Int32
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			_, err := s.CheckGrant(ctx, id, time.Hour, func(context.Context, store.GrantCandidate) store.GrantOutcome {
				calls.Add(1)
				time.Sleep(100 * time.Millisecond)
				return store.GrantOutcome{Result: store.GrantAlive, RefreshTokenEnc: []byte("rt-new")}
			})
			if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if n := calls.Load(); n != 1 {
		t.Fatalf("grant checked %d times, want 1", n)
	}

	// With a real interval, a session checked just now is not due.
	ran, err := s.CheckGrant(ctx, id, time.Hour, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		t.Fatal("check ran for a session that is not due")
		return store.GrantOutcome{}
	})
	if err != nil || ran {
		t.Fatalf("CheckGrant = %v, %v", ran, err)
	}
}

func TestCheckGrantOutcomes(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_o", PreferredUsername: "outcome",
		Email: store.IdPEmail{Email: "o@example.com", Verified: true}})
	id := newSession(t, s, u.ID, "o", "sid-o")

	ran, err := s.CheckGrant(ctx, id, 0, func(_ context.Context, c store.GrantCandidate) store.GrantOutcome {
		if c.IdPSub != "acc_o" || string(c.RefreshTokenEnc) != "rt-o" {
			t.Errorf("candidate = %+v", c)
		}
		return store.GrantOutcome{Result: store.GrantAlive, Profile: &store.IdPProfile{Sub: "acc_o", PreferredUsername: "outcome", Name: "Outcome Person"}}
	})
	if err != nil || !ran {
		t.Fatalf("alive: %v, %v", ran, err)
	}
	if got, _ := s.UserByID(ctx, tenant, u.ID); got.Email != "" || got.EmailVerified || got.Name != "Outcome Person" {
		t.Fatalf("user after the IdP removed the email and reported a name: %+v", got)
	}

	// Retry backdates the check so it is due again after RetryAfter.
	if _, err := s.CheckGrant(ctx, id, 0, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		return store.GrantOutcome{Result: store.GrantRetry, RetryAfter: time.Hour}
	}); err != nil {
		t.Fatal(err)
	}
	if ran, _ := s.CheckGrant(ctx, id, time.Hour, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		return store.GrantOutcome{Result: store.GrantAlive}
	}); ran {
		t.Fatal("retry did not postpone the check")
	}
	if _, err := s.ActiveSession(ctx, tenant, hashOf("o")); err != nil {
		t.Fatalf("retry revoked the session: %v", err)
	}

	makeDue(t, s, id)
	if ran, err := s.CheckGrant(ctx, id, time.Hour, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		return store.GrantOutcome{Result: store.GrantEnded}
	}); err != nil || !ran {
		t.Fatalf("ended: %v, %v", ran, err)
	}
	if _, err := s.ActiveSession(ctx, tenant, hashOf("o")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ended grant kept the session: %v", err)
	}
}

func TestCheckGrantWritesAfterCallerDeadline(t *testing.T) {
	s := newStore(t)
	u, _ := s.UpsertIdPUser(context.Background(), tenant, store.IdPProfile{Sub: "acc_d", PreferredUsername: "deadline"})
	id := newSession(t, s, u.ID, "d", "sid-d")

	// The caller's context ends while the IdP answers; the rotated token is
	// stored anyway.
	ctx, cancel := context.WithCancel(context.Background())
	ran, err := s.CheckGrant(ctx, id, 0, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		cancel()
		return store.GrantOutcome{Result: store.GrantAlive, RefreshTokenEnc: []byte("rt-rotated")}
	})
	if err != nil || !ran {
		t.Fatalf("CheckGrant = %v, %v", ran, err)
	}
	r, err := s.RevokeSession(context.Background(), tenant, u.ID, id, nil)
	if err != nil || string(r.RefreshTokenEnc) != "rt-rotated" {
		t.Fatalf("stored refresh token = %q, %v", r.RefreshTokenEnc, err)
	}
}

func TestCheckGrantHoldsNoLockAndKeepsRevocation(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_l", PreferredUsername: "lease"})
	id := newSession(t, s, u.ID, "l", "sid-l")

	ran, err := s.CheckGrant(ctx, id, 0, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		// While the check consults the IdP the row is not locked: these
		// would block until the deadline if it were.
		qctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if _, err := s.TouchSession(qctx, id, 0); err != nil {
			t.Errorf("TouchSession during check: %v", err)
		}
		if _, err := s.RevokeSession(qctx, tenant, u.ID, id, nil); err != nil {
			t.Errorf("RevokeSession during check: %v", err)
		}
		// A concurrent check finds the session leased.
		again, err := s.CheckGrant(qctx, id, 0, func(context.Context, store.GrantCandidate) store.GrantOutcome {
			t.Error("leased session checked twice")
			return store.GrantOutcome{Result: store.GrantAlive}
		})
		if err != nil || again {
			t.Errorf("concurrent CheckGrant = %v, %v", again, err)
		}
		return store.GrantOutcome{Result: store.GrantAlive, RefreshTokenEnc: []byte("rt-late"), IDTokenEnc: []byte("idt-late")}
	})
	if !ran || !errors.Is(err, store.ErrGrantNotApplied) {
		t.Fatalf("CheckGrant on a session revoked meanwhile = %v, %v", ran, err)
	}
	// The late outcome did not bring the tokens back.
	end, err := s.EndSessionForLogout(ctx, tenant, hashOf("l"))
	if err != nil || end.RefreshTokenEnc != nil || end.IDTokenEnc != nil {
		t.Fatalf("tokens after revocation = %+v, %v", end, err)
	}
}

func TestCheckGrantLeaseExpires(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, _ := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_x", PreferredUsername: "expire"})
	id := newSession(t, s, u.ID, "x", "sid-x")

	// A check that never finished (crashed process) leaves its lease; the
	// session is checked again once the lease has expired.
	if _, err := s.CheckGrant(ctx, id, 0, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		return store.GrantOutcome{Result: 0} // unknown result: nothing written
	}); err == nil {
		t.Fatal("unknown result accepted")
	}
	called := false
	ran, err := s.CheckGrant(ctx, id, 0, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		called = true
		return store.GrantOutcome{Result: store.GrantAlive}
	})
	if err != nil || ran || called {
		t.Fatalf("check while leased = %v, %v", ran, err)
	}
	store.ExpireGrantLeases(t, s)
	ran, err = s.CheckGrant(ctx, id, 0, func(context.Context, store.GrantCandidate) store.GrantOutcome {
		return store.GrantOutcome{Result: store.GrantAlive}
	})
	if err != nil || !ran {
		t.Fatalf("check after lease expiry = %v, %v", ran, err)
	}
}

func TestLatestMigrationRollsBack(t *testing.T) {
	s := newStore(t)
	if v := store.RollBackAndReapplyLatest(t, s); v < 5 {
		t.Fatalf("rolled back version %d", v)
	}
}

package store_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"app.local/server/internal/store"
)

func deviceInput(key byte, name string) store.NewAccountDevice {
	return store.NewAccountDevice{PublicKey: bytes.Repeat([]byte{key}, 32), Name: name, Platform: "web"}
}

func keysOf(list []store.AccountDevice) [][]byte {
	out := make([][]byte, len(list))
	for i, d := range list {
		out[i] = d.PublicKey
	}
	return out
}

func sameKeys(got [][]byte, want ...byte) bool {
	if len(got) != len(want) {
		return false
	}
	for i, k := range got {
		if !bytes.Equal(k, bytes.Repeat([]byte{want[i]}, 32)) {
			return false
		}
	}
	return true
}

func TestRegisterAccountDevice(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	laptop := newSession(t, s, u.ID, "laptop", "")
	phone := newSession(t, s, u.ID, "phone", "")

	dev, created, err := s.RegisterAccountDevice(ctx, tenant, u.ID, laptop, deviceInput(1, "Chrome"))
	if err != nil || !created || dev.SessionID != laptop || dev.Name != "Chrome" || dev.Platform != "web" || !dev.RevokedAt.IsZero() {
		t.Fatalf("register: %+v %v %v", dev, created, err)
	}
	// Again from the same session: no new device, the name follows.
	again, created, err := s.RegisterAccountDevice(ctx, tenant, u.ID, laptop, deviceInput(1, "Chrome on macOS"))
	if err != nil || created || again.ID != dev.ID || again.Name != "Chrome on macOS" {
		t.Fatalf("register again: %+v %v %v", again, created, err)
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, phone, deviceInput(1, "x")); !errors.Is(err, store.ErrDeviceKeyInUse) {
		t.Fatalf("key of another session: %v", err)
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, phone, deviceInput(2, "Phone")); err != nil {
		t.Fatal(err)
	}

	// The limit counts live keys.
	for i := range store.MaxAccountDevices - 2 {
		sess := newSession(t, s, u.ID, fmt.Sprintf("extra-%d", i), "")
		if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, sess, deviceInput(byte(10+i), "d")); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, laptop, deviceInput(200, "one too many")); !errors.Is(err, store.ErrTooManyDevices) {
		t.Fatalf("over the limit: %v", err)
	}

	if _, _, err := s.RegisterAccountDevice(ctx, "other", u.ID, laptop, deviceInput(201, "x")); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
}

// Revoking a key is for good, and the session that registered it cannot add
// keys any more.
func TestRevokedDeviceKeyNeverComesBack(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "binh"})
	if err != nil {
		t.Fatal(err)
	}
	laptop := newSession(t, s, u.ID, "laptop", "")
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, laptop, deviceInput(1, "Chrome")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RevokeAccountDevice(ctx, tenant, other.ID, bytes.Repeat([]byte{1}, 32)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked by another account: %v", err)
	}
	for range 2 {
		sid, err := s.RevokeAccountDevice(ctx, tenant, u.ID, bytes.Repeat([]byte{1}, 32))
		if err != nil || sid != laptop {
			t.Fatalf("revoke: %d %v", sid, err)
		}
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, laptop, deviceInput(2, "new key")); !errors.Is(err, store.ErrSessionDevicesRevoked) {
		t.Fatalf("new key from the session of a revoked one: %v", err)
	}
	fresh := newSession(t, s, u.ID, "fresh", "")
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, fresh, deviceInput(1, "Chrome")); !errors.Is(err, store.ErrDeviceRevoked) {
		t.Fatalf("revoked key from a new session: %v", err)
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, fresh, deviceInput(2, "new key")); err != nil {
		t.Fatalf("new key from a new session: %v", err)
	}
	// The same key on another account is that account's own.
	theirs := newSession(t, s, other.ID, "theirs", "")
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, other.ID, theirs, deviceInput(1, "Chrome")); err != nil {
		t.Fatalf("another account's device: %v", err)
	}
	if _, err := s.RevokeAccountDevice(ctx, tenant, u.ID, bytes.Repeat([]byte{9}, 32)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown key: %v", err)
	}
}

// A session that ends, however it ends, takes its keys with it; the keys of
// other sessions and other accounts stay.
func TestSessionEndRevokesItsDevices(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "binh"})
	if err != nil {
		t.Fatal(err)
	}
	signedOut := newSession(t, s, u.ID, "signed-out", "")
	expired := newSession(t, s, u.ID, "expired", "")
	idpEnded := newSession(t, s, u.ID, "idp-ended", "sid-1")
	stays := newSession(t, s, u.ID, "stays", "")
	theirs := newSession(t, s, other.ID, "theirs", "sid-2")
	for i, sess := range []int64{signedOut, expired, idpEnded, stays} {
		if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, sess, deviceInput(byte(i+1), "d")); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, other.ID, theirs, deviceInput(9, "d")); err != nil {
		t.Fatal(err)
	}

	if _, err := s.RevokeSession(ctx, tenant, u.ID, signedOut, nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool().Exec(ctx, `UPDATE user_sessions SET last_seen_at = now() - interval '31 days' WHERE id = $1`, expired); err != nil {
		t.Fatal(err)
	}
	// The IdP ended one browser session (back-channel logout of its sid).
	if _, _, err := s.BackchannelLogout(ctx, tenant, "chat-web", "jti-1", time.Hour, "sid-1", "acc_1"); err != nil {
		t.Fatal(err)
	}

	m, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("mac", 7))
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := s.MachineHeartbeat(ctx, tenant, m.ID, "", "3.0.0", nil)
	if err != nil || !sameKeys(keysOf(trusted), 4) {
		t.Fatalf("trusted after the sessions ended: %x %v", keysOf(trusted), err)
	}
	list, err := s.ListAccountDevices(ctx, tenant, u.ID)
	if err != nil || len(list) != 4 || !bytes.Equal(list[0].PublicKey, bytes.Repeat([]byte{4}, 32)) || !list[0].RevokedAt.IsZero() {
		t.Fatalf("list %+v %v", list, err)
	}
	for _, d := range list[1:] {
		if d.RevokedAt.IsZero() {
			t.Fatalf("not revoked: %+v", d)
		}
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, stays, deviceInput(2, "d")); !errors.Is(err, store.ErrDeviceRevoked) {
		t.Fatalf("key of an expired session again: %v", err)
	}

	// Revoking every session (account deletion) ends the last one too.
	if _, err := s.RevokeAllSessions(ctx, tenant, u.ID); err != nil {
		t.Fatal(err)
	}
	if trusted, _ := s.MachineHeartbeat(ctx, tenant, m.ID, "", "3.0.0", nil); len(trusted) != 0 {
		t.Fatalf("trusted after revoking every session: %x", keysOf(trusted))
	}
	theirList, err := s.ListAccountDevices(ctx, tenant, other.ID)
	if err != nil || len(theirList) != 1 || !theirList[0].RevokedAt.IsZero() {
		t.Fatalf("the other account's device: %+v %v", theirList, err)
	}
}

func TestHeartbeatTrustedDevices(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "binh"})
	if err != nil {
		t.Fatal(err)
	}
	mine := newSession(t, s, u.ID, "mine", "")
	theirs := newSession(t, s, other.ID, "theirs", "")
	for _, k := range []byte{1, 2} {
		if _, _, err := s.RegisterAccountDevice(ctx, tenant, u.ID, mine, deviceInput(k, "d")); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.RegisterAccountDevice(ctx, tenant, other.ID, theirs, deviceInput(3, "d")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool().Exec(ctx, `UPDATE account_devices SET last_seen_at = now() - interval '1 day'`); err != nil {
		t.Fatal(err)
	}
	m, _, err := s.RegisterMachine(ctx, tenant, u.ID, newMachineInput("mac", 7))
	if err != nil {
		t.Fatal(err)
	}
	// A connected key of another account is not touched.
	trusted, err := s.MachineHeartbeat(ctx, tenant, m.ID, "", "3.0.0",
		[][]byte{bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{3}, 32)})
	if err != nil || !sameKeys(keysOf(trusted), 1, 2) {
		t.Fatalf("trusted %x %v", keysOf(trusted), err)
	}
	var recent []byte
	rows, err := s.Pool().Query(ctx, `SELECT public_key FROM account_devices WHERE last_seen_at > now() - interval '1 minute'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		if err := rows.Scan(&recent); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(recent, bytes.Repeat([]byte{2}, 32)) {
			t.Fatalf("seen now: %x", recent)
		}
	}
	if rows.Err() != nil || recent == nil {
		t.Fatalf("no device seen now: %v", rows.Err())
	}
}

// Erasing an account deletes its machines, its device keys and the install
// codes the previous binary may still have written.
func TestErasureDeletesMachinesAndDevices(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_1", PreferredUsername: "dat"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "acc_2", PreferredUsername: "binh"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{u.ID, other.ID} {
		sess := newSession(t, s, id, fmt.Sprintf("erase-%d", id), "")
		if _, _, err := s.RegisterAccountDevice(ctx, tenant, id, sess, deviceInput(1, "d")); err != nil {
			t.Fatal(err)
		}
		if _, _, err := s.RegisterMachine(ctx, tenant, id, newMachineInput("m", 7)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Pool().Exec(ctx, `
		INSERT INTO machine_install_codes (code_hash, tenant_id, user_id, expires_at)
		VALUES ($1, $2, $3, now() + interval '10 minutes')`, bytes.Repeat([]byte{8}, 32), tenant, u.ID); err != nil {
		t.Fatal(err)
	}
	// As the erasure job does: the sessions go first, then the profile.
	if _, err := s.Pool().Exec(ctx, `DELETE FROM user_sessions WHERE user_id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool().Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	var machines, devices, codes int
	if err := s.Pool().QueryRow(ctx, `
		SELECT (SELECT count(*) FROM machines WHERE user_id = $1), (SELECT count(*) FROM account_devices WHERE user_id = $1),
			(SELECT count(*) FROM machine_install_codes WHERE user_id = $1)`, u.ID).Scan(&machines, &devices, &codes); err != nil {
		t.Fatal(err)
	}
	if machines != 0 || devices != 0 || codes != 0 {
		t.Fatalf("after erasure: %d machines, %d devices, %d codes", machines, devices, codes)
	}
	if list, err := s.ListAccountDevices(ctx, tenant, other.ID); err != nil || len(list) != 1 || !list[0].RevokedAt.IsZero() {
		t.Fatalf("the other account's devices: %+v %v", list, err)
	}
}

func TestCleanDevicePlatform(t *testing.T) {
	for in, ok := range map[string]bool{"web": true, " ios ": true, "desktop-pwa": true, "": false, "Web": false, "a b": false,
		"x" + string(bytes.Repeat([]byte("y"), 32)): false} {
		if _, got := store.CleanDevicePlatform(in); got != ok {
			t.Errorf("CleanDevicePlatform(%q) = %v", in, got)
		}
	}
}

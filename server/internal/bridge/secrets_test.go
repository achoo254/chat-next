package bridge

import (
	"bytes"
	"context"
	"os"
	"testing"

	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

func TestResealSecretsMovesToTheNewKeyAndFlagsUnreadable(t *testing.T) {
	ctx := context.Background()
	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, "primary", "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	u, err := st.UpsertIdPUser(ctx, "primary", store.IdPProfile{Sub: "acc_bridge", PreferredUsername: "owner", Name: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	oldKey, newKey := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	oldBox, err := NewSecretBox(oldKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	insert := func(ref string, secret func(id int64) []byte) int64 {
		t.Helper()
		var id int64
		if err := st.Pool().QueryRow(ctx, `INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', $2, '\x00') RETURNING id`,
			u.ID, ref).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := st.Pool().Exec(ctx, `UPDATE external_accounts SET secret = $2 WHERE id = $1`, id, secret(id)); err != nil {
			t.Fatal(err)
		}
		return id
	}
	good := insert("good", func(id int64) []byte { return oldBox.Seal([]byte("session-state"), SecretAAD(id, u.ID, "telegram")) })
	insert("garbage", func(int64) []byte { return []byte("not a sealed value at all, just bytes") })

	n, err := ResealSecrets(ctx, st.Pool(), newKey, oldKey)
	if err != nil {
		t.Fatal(err)
	}
	if n.Resealed != 1 || n.Unreadable != 1 {
		t.Fatalf("first reseal = %+v, want 1 resealed and 1 unreadable", n)
	}
	// The new key alone opens the resealed secret, with the account in the AAD.
	newBox, _ := NewSecretBox(newKey, nil)
	var sealed []byte
	if err := st.Pool().QueryRow(ctx, `SELECT secret FROM external_accounts WHERE id = $1`, good).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	got, err := newBox.Open(sealed, SecretAAD(good, u.ID, "telegram"))
	if err != nil || string(got) != "session-state" {
		t.Fatalf("open with the new key = %q, %v", got, err)
	}
	if _, err := newBox.Open(sealed, SecretAAD(good+1, u.ID, "telegram")); err == nil {
		t.Fatal("a secret opened with another account in the AAD")
	}
	n, err = ResealSecrets(ctx, st.Pool(), newKey, oldKey)
	if err != nil {
		t.Fatal(err)
	}
	if n.Resealed != 0 || n.Current != 1 {
		t.Fatalf("second reseal = %+v, want it to change nothing", n)
	}
}

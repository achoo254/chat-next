package privacy

import (
	"context"
	"fmt"
	"os"
	"testing"

	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"github.com/jackc/pgx/v5"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

// eraseRows runs the personal-data deletion of Erase for one user.
func eraseRows(t *testing.T, st *store.Store, userID int64) {
	t.Helper()
	ctx := context.Background()
	if err := pgx.BeginFunc(ctx, st.Pool(), func(tx pgx.Tx) error {
		for _, sql := range personalRows {
			if _, err := tx.Exec(ctx, sql, userID); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// TestEraseDropsLinkRowsOfBothSides: erasing a linked user takes them out of
// every owner's people (a person left with one user goes) and drops the
// rejections that name them; erasing an owner drops all of that owner's rows
// and leaves other owners' people alone.
func TestEraseDropsLinkRowsOfBothSides(t *testing.T) {
	st := testdb.Open(t)
	ctx := context.Background()
	const tenant = "primary"
	if err := st.EnsureTenant(ctx, tenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	mk := func(name string) int64 {
		u, err := st.UpsertIdPUser(ctx, tenant, store.IdPProfile{Sub: "sub_" + name, PreferredUsername: name, Name: name})
		if err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	ownerA, ownerB := mk("owner_a"), mk("owner_b")
	x, y, z := mk("user_x"), mk("user_y"), mk("user_z")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := st.Pool().Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	person := func(owner int64, members ...int64) int64 {
		t.Helper()
		var id int64
		if err := st.Pool().QueryRow(ctx, `INSERT INTO people (owner_id, name) VALUES ($1, 'P') RETURNING id`, owner).Scan(&id); err != nil {
			t.Fatal(err)
		}
		for _, m := range members {
			exec(`INSERT INTO people_members (person_id, owner_id, user_id) VALUES ($1, $2, $3)`, id, owner, m)
		}
		return id
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := st.Pool().QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	reject := func(owner, a, b int64) {
		exec(`INSERT INTO people_rejections (owner_id, user_a, user_b) VALUES ($1, $2, $3)`, owner, min(a, b), max(a, b))
	}

	bigA := person(ownerA, x, y, z) // keeps two users after x is erased
	smallB := person(ownerB, x, y)  // keeps one user after x is erased: goes
	reject(ownerA, x, z)
	reject(ownerA, y, z)

	eraseRows(t, st, x)
	if n := count(`SELECT count(*) FROM people_members WHERE person_id = $1`, bigA); n != 2 {
		t.Fatalf("a person of another owner has %d members after an erasure, want 2", n)
	}
	if n := count(`SELECT count(*) FROM people WHERE id = $1`, smallB); n != 0 {
		t.Fatal("a person left with one user stays")
	}
	if n := count(`SELECT count(*) FROM people_members WHERE user_id = $1`, x); n != 0 {
		t.Fatalf("the erased user is still a member %d times", n)
	}
	if n := count(`SELECT count(*) FROM people_rejections WHERE owner_id = $1`, ownerA); n != 1 {
		t.Fatalf("rejections left = %d, want only the pair of the other two users", n)
	}

	// Erasing the owner drops everything of theirs; another owner's people stay.
	keep := person(ownerB, y, z)
	reject(ownerB, y, z)
	eraseRows(t, st, ownerA)
	for _, table := range []string{"people", "people_members", "people_rejections"} {
		if n := count(fmt.Sprintf(`SELECT count(*) FROM %s WHERE owner_id = $1`, table), ownerA); n != 0 {
			t.Fatalf("%s keeps %d rows of an erased owner", table, n)
		}
	}
	if n := count(`SELECT count(*) FROM people_members WHERE person_id = $1`, keep); n != 2 {
		t.Fatalf("another owner's person lost members: %d", n)
	}
	if n := count(`SELECT count(*) FROM people_rejections WHERE owner_id = $1`, ownerB); n != 1 {
		t.Fatalf("another owner's rejections = %d, want 1", n)
	}
}

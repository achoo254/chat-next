package bridge

import (
	"context"
	"fmt"

	"app.local/server/internal/sealbox"
	"github.com/jackc/pgx/v5/pgxpool"
)

// secretPurpose separates the key of bridge secrets from every other use of
// SESSION_KEY: the login state of an external account opens only here.
const secretPurpose = "bridge-account-secret"

// resealBatch is how many rows one reseal round reads.
const resealBatch = 200

// NewSecretBox is the box that seals the login state of external accounts
// (external_accounts.secret and the copy in external_logouts). previous may
// be nil.
func NewSecretBox(sessionKey, previousKey []byte) (*sealbox.Box, error) {
	if previousKey == nil {
		return sealbox.New(sessionKey, secretPurpose)
	}
	return sealbox.New(sessionKey, secretPurpose, previousKey)
}

// SecretAAD binds a sealed secret to its account, owner and app, so a
// secret copied onto another row does not open.
func SecretAAD(accountID, ownerID int64, source string) []byte {
	return fmt.Appendf(nil, "bridge:%d:%d:%s", accountID, ownerID, source)
}

// ResealSecrets seals every stored secret again under sessionKey, opening
// it with sessionKey or previousKey (key rotation, docs/operations/key-rotation.md).
// A secret neither opens is counted as unreadable: that account must sign in
// again. Running it twice changes nothing.
func ResealSecrets(ctx context.Context, pool *pgxpool.Pool, sessionKey, previousKey []byte) (sealbox.Count, error) {
	var total sealbox.Count
	box, err := NewSecretBox(sessionKey, previousKey)
	if err != nil {
		return total, err
	}
	for _, table := range []string{"external_accounts", "external_logouts"} {
		n, err := resealTable(ctx, pool, box, table)
		total.Resealed += n.Resealed
		total.Current += n.Current
		total.Unreadable += n.Unreadable
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// resealTable reseals one table; table is a fixed name of this package,
// never input. Both tables hold the account (id, or account_id in the
// logout queue), owner and source that the AAD is made of.
func resealTable(ctx context.Context, pool *pgxpool.Pool, box *sealbox.Box, table string) (sealbox.Count, error) {
	var n sealbox.Count
	accountColumn := "id"
	if table == "external_logouts" {
		accountColumn = "account_id"
	}
	var after int64
	for {
		type row struct {
			id, account, owner int64
			source             string
			sealed             []byte
		}
		rs, err := pool.Query(ctx, fmt.Sprintf(`
			SELECT id, %[2]s, owner_id, source, secret FROM %[1]s
			WHERE id > $1 ORDER BY id LIMIT $2`, table, accountColumn), after, resealBatch)
		if err != nil {
			return n, fmt.Errorf("bridge: reseal %s: %w", table, err)
		}
		var rows []row
		for rs.Next() {
			var r row
			if err := rs.Scan(&r.id, &r.account, &r.owner, &r.source, &r.sealed); err != nil {
				rs.Close()
				return n, fmt.Errorf("bridge: reseal %s: %w", table, err)
			}
			rows = append(rows, r)
		}
		rs.Close()
		if err := rs.Err(); err != nil {
			return n, fmt.Errorf("bridge: reseal %s: %w", table, err)
		}
		if len(rows) == 0 {
			return n, nil
		}
		for _, r := range rows {
			after = r.id
			out, changed, err := box.Reseal(r.sealed, SecretAAD(r.account, r.owner, r.source))
			switch {
			case err != nil:
				n.Unreadable++
			case !changed:
				n.Current++
			default:
				tag, err := pool.Exec(ctx, fmt.Sprintf(`UPDATE %s SET secret = $3 WHERE id = $1 AND secret = $2`, table), r.id, r.sealed, out)
				if err != nil {
					return n, fmt.Errorf("bridge: reseal %s: %w", table, err)
				}
				if tag.RowsAffected() == 1 {
					n.Resealed++
				}
			}
		}
	}
}

package botupdates

import (
	"context"
	"fmt"

	"app.local/server/internal/sealbox"
	"github.com/jackc/pgx/v5/pgxpool"
)

// resealBatch is how many bots one ResealWebhookSecrets query reads.
const resealBatch = 500

// newSecretBox is the box of the webhook secrets at rest.
func newSecretBox(sessionKey, previousKey []byte) (*sealbox.Box, error) {
	return sealbox.New(sessionKey, "bot-webhook-secret", previousKey)
}

// ResealWebhookSecrets seals every stored webhook secret of tenant under
// sessionKey, opening it with sessionKey or previousKey (key rotation). A
// secret neither opens is counted as unreadable: its deliveries keep
// failing with secret_unreadable until the owner saves the webhook again.
func ResealWebhookSecrets(ctx context.Context, pool *pgxpool.Pool, tenantID string, sessionKey, previousKey []byte) (sealbox.Count, error) {
	var n sealbox.Count
	box, err := newSecretBox(sessionKey, previousKey)
	if err != nil {
		return n, err
	}
	var after int64
	for {
		type row struct {
			id     int64
			sealed []byte
		}
		var rows []row
		rs, err := pool.Query(ctx, `
			SELECT user_id, webhook_secret FROM bots
			WHERE tenant_id = $1 AND user_id > $2 AND webhook_secret IS NOT NULL
			ORDER BY user_id LIMIT $3`, tenantID, after, resealBatch)
		if err != nil {
			return n, fmt.Errorf("botupdates: reseal: %w", err)
		}
		for rs.Next() {
			var r row
			if err := rs.Scan(&r.id, &r.sealed); err != nil {
				rs.Close()
				return n, fmt.Errorf("botupdates: reseal: %w", err)
			}
			rows = append(rows, r)
		}
		rs.Close()
		if err := rs.Err(); err != nil {
			return n, fmt.Errorf("botupdates: reseal: %w", err)
		}
		if len(rows) == 0 {
			return n, nil
		}
		for _, r := range rows {
			after = r.id
			out, changed, err := box.Reseal(r.sealed, secretAAD(r.id))
			switch {
			case err != nil:
				n.Unreadable++
			case !changed:
				n.Current++
			default:
				ok, err := replaceSecret(ctx, pool, r.id, r.sealed, out)
				if err != nil {
					return n, err
				}
				if ok {
					n.Resealed++
				}
			}
		}
	}
}

// replaceSecret stores next when the bot still holds old: an owner who
// saved the webhook meanwhile wins.
func replaceSecret(ctx context.Context, pool *pgxpool.Pool, botID int64, old, next []byte) (bool, error) {
	tag, err := pool.Exec(ctx, `UPDATE bots SET webhook_secret = $3 WHERE user_id = $1 AND webhook_secret = $2`, botID, old, next)
	if err != nil {
		return false, fmt.Errorf("botupdates: replace webhook secret: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

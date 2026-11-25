package engine

import (
	"context"
	"fmt"

	"app.local/server/internal/bridge"
)

// recordOwnPhone records, once per connection, a keyed hash of the number the account was
// verified with in the other app as the phone number of the account owner, so people can find
// the owner by it. It is the only source of a user's number: a number a person types would
// prove nothing. A failure other than a wait the other app asked for is logged and tried
// again at the next connection.
func (r *runner) recordOwnPhone(ctx context.Context) error {
	if r.ownPhoneDone {
		return nil
	}
	reader, ok := r.adapter.(bridge.OwnPhoneReader)
	if !ok || r.e.db.phones == nil {
		r.ownPhoneDone = true
		return nil
	}
	raw, err := reader.OwnPhone(ctx, r.acct)
	if err != nil {
		if ctx.Err() != nil || isWait(err) {
			return err
		}
		r.ownPhoneDone = true
		r.logger.Warn("reading the account's own phone number failed; it is tried again at the next connection", "reason", err.Error())
		return nil
	}
	r.ownPhoneDone = true
	hash, ok := r.e.db.phones.Hash(raw)
	if !ok {
		return nil
	}
	if _, err := r.e.db.pool.Exec(ctx, `
		UPDATE users SET phone_hmac = $2 WHERE id = $1 AND deleted_at IS NULL AND phone_hmac IS DISTINCT FROM $2`,
		r.account.OwnerID, hash); err != nil {
		return fmt.Errorf("bridge: record own phone: %w", err)
	}
	return nil
}

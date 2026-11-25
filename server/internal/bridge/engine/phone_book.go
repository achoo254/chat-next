package engine

import (
	"context"
	"fmt"

	"app.local/server/internal/bridge"
)

// readPhoneBook fills, once per account, the phone numbers of people met before numbers
// were recorded: it reads the account's contacts (bridge.PhoneBook, read-only) and
// records the number of each one that already has a puppet. A contact without a puppet
// gets none: no user is made for someone the owner never talked with here. The read is
// marked done in external_accounts.phone_book_read_at; a failure other than a wait the
// other app asked for is logged and tried again at the next connection.
func (r *runner) readPhoneBook(ctx context.Context) error {
	if r.phoneBookDone {
		return nil
	}
	book, ok := r.adapter.(bridge.PhoneBook)
	if !ok || r.e.db.phones == nil {
		r.phoneBookDone = true
		return nil
	}
	db := r.e.db
	var done bool
	if err := db.pool.QueryRow(ctx, `SELECT phone_book_read_at IS NOT NULL FROM external_accounts WHERE id = $1`,
		r.account.ID).Scan(&done); err != nil {
		return fmt.Errorf("bridge: phone book state: %w", err)
	}
	if done {
		r.phoneBookDone = true
		return nil
	}
	contacts, err := book.PhoneContacts(ctx, r.acct)
	if err != nil {
		if ctx.Err() != nil || isWait(err) {
			return err // asked again after the wait
		}
		r.phoneBookDone = true
		r.logger.Warn("reading the contacts for phone numbers failed; it is tried again at the next connection", "reason", err.Error())
		return nil
	}
	for _, p := range contacts {
		if p.IsSelf {
			continue
		}
		if err := db.setPhone(ctx, r.account.ID, p); err != nil {
			return err
		}
	}
	if _, err := db.pool.Exec(ctx, `UPDATE external_accounts SET phone_book_read_at = now() WHERE id = $1`, r.account.ID); err != nil {
		return fmt.Errorf("bridge: mark phone book read: %w", err)
	}
	r.phoneBookDone = true
	r.logger.Info("contacts read for phone numbers", "contacts", len(contacts))
	return nil
}

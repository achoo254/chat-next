package bridge

import "context"

// OwnPhoneReader is implemented by an adapter that can read the phone number the account
// itself was verified with in the other app. The engine records a keyed hash of it for the
// account owner, so other people can find the owner by that number. A number the app does
// not show ("" with no error) records nothing.
type OwnPhoneReader interface {
	OwnPhone(ctx context.Context, acct Account) (string, error)
}

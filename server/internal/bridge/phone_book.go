package bridge

import "context"

// PhoneBook is implemented by an adapter that can read, without changing anything, the
// people the account keeps as contacts in the other app together with the phone numbers
// the app shows for them. The engine reads it once per account to fill the numbers of
// people met before numbers were recorded (Participant.PhoneKnown); a contact without a
// puppet in Chat is ignored. A throttle comes back as *RateLimitError like any other call.
type PhoneBook interface {
	PhoneContacts(ctx context.Context, acct Account) ([]Participant, error)
}

package zalo_test

import (
	"testing"

	"app.local/server/internal/bridge/adapters/zalo"
	"app.local/server/internal/bridge/contracttest"
)

// The declaration group needs no account: what the adapter says it supports
// (messages in and out, nothing else) must match the interfaces it implements.
// The shared messages group reads a history the adapter cannot page (Backfill
// hands over what it heard once), so the repeated-RandomID check of sending
// runs against the Zalo simulation instead (send_test.go), and by hand against
// a real account.
func TestZaloDeclaresWhatItImplements(t *testing.T) {
	contracttest.Run(t, func(t *testing.T) contracttest.Subject {
		a := zalo.New(zalo.Config{})
		t.Cleanup(a.Close)
		return contracttest.Subject{Adapter: a}
	})
}

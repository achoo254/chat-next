package zalo_test

import (
	"testing"

	"app.local/server/internal/bridge/adapters/zalo"
	"app.local/server/internal/bridge/contracttest"
)

// The declaration group needs no account: what the adapter says it supports
// (messages in, nothing out) must match the interfaces it implements. The
// groups that need a conversation run by hand against a real account.
func TestZaloDeclaresWhatItImplements(t *testing.T) {
	contracttest.Run(t, func(t *testing.T) contracttest.Subject {
		a := zalo.New(zalo.Config{})
		t.Cleanup(a.Close)
		return contracttest.Subject{Adapter: a}
	})
}

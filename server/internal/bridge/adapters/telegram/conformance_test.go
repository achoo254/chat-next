package telegram_test

import (
	"testing"

	"app.local/server/internal/bridge/adapters/telegram"
	"app.local/server/internal/bridge/contracttest"
)

// The declaration group of the shared suite needs no account: what the adapter says
// it supports must match the interfaces it implements. The groups that need an app
// run against a real account by hand (the live tests).
func TestTelegramDeclaresWhatItImplements(t *testing.T) {
	contracttest.Run(t, func(t *testing.T) contracttest.Subject {
		a := telegram.New(telegram.Config{})
		t.Cleanup(a.Close)
		return contracttest.Subject{Adapter: a}
	})
}

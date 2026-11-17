package bridge

import (
	"context"
	"testing"
)

// stub proves the Adapter interface is satisfiable without any app SDK.
type stub struct{}

func (stub) Name() string               { return "stub" }
func (stub) Capabilities() Capabilities { return Capabilities{CapHistory: true} }
func (stub) Login(context.Context, string, map[string]string) (LoginStep, error) {
	return LoginStep{Kind: StepDone}, nil
}
func (stub) Logout(context.Context, Account) error { return nil }
func (stub) ListConversations(context.Context, Account) ([]Conversation, error) {
	return nil, nil
}
func (stub) Backfill(context.Context, Account, string, Cursor, int) (Page, error) {
	return Page{Done: true}, nil
}
func (stub) Subscribe(context.Context, Account, chan<- Event) error { return nil }
func (stub) FetchMedia(context.Context, Account, string) (MediaStream, error) {
	return nil, nil
}

var _ Adapter = stub{}

func TestCapabilitiesHas(t *testing.T) {
	cs := stub{}.Capabilities()
	if !cs.Has(CapHistory) || cs.Has(CapMedia) {
		t.Fatalf("unexpected capabilities: %v", cs)
	}
}

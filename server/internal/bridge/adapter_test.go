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

// sender proves a Sender can be added without touching the Adapter interface.
type sender struct{ stub }

func (sender) Capabilities() Capabilities { return Capabilities{CapHistory: true, CapSend: true} }
func (sender) SendMessage(context.Context, Account, OutMessage) (SentRef, error) {
	return SentRef{}, nil
}
func (sender) EditMessage(context.Context, Account, EditRequest) error { return nil }
func (sender) DeleteMessages(context.Context, Account, Delete) error   { return nil }

var _ Sender = sender{}

func TestSendIsACapabilityNotARequirement(t *testing.T) {
	if (stub{}).Capabilities().Has(CapSend) {
		t.Fatal("an adapter without Sender must not declare CapSend")
	}
	if !(sender{}).Capabilities().Has(CapSend) {
		t.Fatal("a Sender declares CapSend")
	}
}

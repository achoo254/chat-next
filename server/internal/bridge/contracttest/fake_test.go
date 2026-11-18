package contracttest

import (
	"context"
	"testing"

	"app.local/server/internal/bridge"
)

func TestRepeatedRandomIDCreatesOneMessage(t *testing.T) {
	f := NewFake("fake")
	m := bridge.OutMessage{Conversation: "c1", Text: "hi", RandomID: 42}
	a, err := f.SendMessage(context.Background(), bridge.Account{}, m)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.SendMessage(context.Background(), bridge.Account{}, m)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Sent()) != 1 || a.IDs[0] != b.IDs[0] {
		t.Fatalf("a repeated RandomID must answer with the first message: sent=%d a=%v b=%v", len(f.Sent()), a.IDs, b.IDs)
	}
}

func TestAlbumGivesOneIDPerItem(t *testing.T) {
	f := NewFake("fake")
	ref, err := f.SendMessage(context.Background(), bridge.Account{}, bridge.OutMessage{Conversation: "c1", Media: make([]bridge.OutMedia, 3), RandomID: 7})
	if err != nil || len(ref.IDs) != 3 {
		t.Fatalf("want 3 ids, got %v err %v", ref.IDs, err)
	}
}

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

func TestTopicsAreListedPerConversationAndTravelOnMessages(t *testing.T) {
	f := NewFake("fake")
	f.AddTopic("g1", bridge.Topic{ID: "1", Title: "General"})
	f.AddTopic("g1", bridge.Topic{ID: "7", Title: "Hạ tầng", IconColor: 0x6FB9F0, Closed: true})
	got, err := f.ListTopics(context.Background(), bridge.Account{}, "g1")
	if err != nil || len(got) != 2 || got[1].Title != "Hạ tầng" || !got[1].Closed {
		t.Fatalf("topics = %+v, %v", got, err)
	}
	if other, _ := f.ListTopics(context.Background(), bridge.Account{}, "g2"); len(other) != 0 {
		t.Fatalf("another conversation has topics: %+v", other)
	}
	f.AddHistory("g1", bridge.Message{ID: "m1", Topic: "7"})
	page, err := f.Backfill(context.Background(), bridge.Account{}, "g1", bridge.Cursor{}, 10)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Topic != "7" {
		t.Fatalf("history = %+v, %v; want the message to keep its topic", page, err)
	}
	if !f.Capabilities().Has(bridge.CapTopics) {
		t.Fatal("the fake implements TopicReader and must declare CapTopics")
	}
}

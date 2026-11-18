package contracttest

import (
	"context"
	"slices"
	"strings"
	"testing"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
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

func conformanceSubject(t *testing.T, f *Fake) Subject {
	t.Helper()
	f.AddConversation(bridge.Conversation{ID: "c1", Kind: bridge.ConvGroup, Title: "c1"})
	f.AddHistory("c1",
		bridge.Message{ID: "1", Text: "một", Version: 1},
		bridge.Message{ID: "2", Text: "hai", Version: 1},
		bridge.Message{ID: "3", Text: "ba", Version: 1},
		bridge.Message{ID: "4", Text: "bốn", Version: 1},
	)
	return Subject{Adapter: f, Conversation: "c1", MessageIDs: []string{"4", "3", "2", "1"}}
}

func TestTheFakeConformsToTheContract(t *testing.T) {
	Run(t, func(t *testing.T) Subject { return conformanceSubject(t, NewFake("fake")) })
}

func TestAFakeWithFewFeaturesConformsAndRunsOnlyTheirGroups(t *testing.T) {
	Run(t, func(t *testing.T) Subject {
		f := NewFake("reader").Support(feature.Pins, feature.Support{In: true}).Support(feature.Topics, feature.Support{}).Support(feature.Messages, feature.Support{In: true})
		return conformanceSubject(t, f)
	})
}

// halfApp says it takes pins from Chat but is not a Pinner: the suite must notice.
type halfApp struct{ bridge.Adapter }

func (halfApp) Features() map[feature.Feature]feature.Support {
	return map[feature.Feature]feature.Support{feature.Messages: {In: true}, feature.Pins: {In: true, Out: true}}
}

func TestTheSuiteCatchesAnAdapterThatDeclaresMoreThanItImplements(t *testing.T) {
	problems := declarationProblems(Subject{Adapter: halfApp{NewFake("half")}})
	for _, want := range []string{"not both a bridge.Pinner and a bridge.Sender", "not a bridge.PinReader", "CapSend"} {
		if !slices.ContainsFunc(problems, func(p string) bool { return strings.Contains(p, want) }) {
			t.Errorf("no problem mentions %q: %v", want, problems)
		}
	}
	if got := declarationProblems(Subject{Adapter: NewFake("ok")}); len(got) != 0 {
		t.Fatalf("a correct adapter has problems: %v", got)
	}
}

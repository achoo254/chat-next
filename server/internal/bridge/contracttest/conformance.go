package contracttest

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// Subject is an adapter under test and the hooks the suite needs to drive the
// app behind it. Only Adapter is required: a group whose hook is nil is skipped,
// so an adapter can run the static checks with no app at all (a unit test) and the
// whole suite against a test account or a fake (by hand or in CI).
type Subject struct {
	Adapter bridge.Adapter
	Account bridge.Account
	// Conversation is the id of a conversation the account has, with at least
	// MessageIDs messages in it; empty skips the groups that need one.
	Conversation string
	// MessageIDs are the ids of messages of Conversation, newest first (at
	// least three when given).
	MessageIDs []string
}

// Run checks an adapter against the contract, feature by feature. What it
// checks follows what the adapter says it supports (bridge.FeaturesOf), so an
// adapter with a few features runs a few groups and one with many runs them all:
// adding a platform is writing the adapter and running this.
//
//	func TestMyAppConformance(t *testing.T) {
//		contracttest.Run(t, func(t *testing.T) contracttest.Subject { ... })
//	}
func Run(t *testing.T, newSubject func(t *testing.T) Subject) {
	t.Helper()
	t.Run("declaration", func(t *testing.T) {
		for _, problem := range declarationProblems(newSubject(t)) {
			t.Error(problem)
		}
	})
	t.Run("messages", func(t *testing.T) { checkMessages(t, newSubject(t)) })
	t.Run("pins", func(t *testing.T) { checkPins(t, newSubject(t)) })
	t.Run("dialogs", func(t *testing.T) { checkDialogs(t, newSubject(t)) })
	t.Run("reactions", func(t *testing.T) { checkReactions(t, newSubject(t)) })
}

// declarationProblems needs no app: what an adapter says it can do must match what
// it implements, and the names must be the ones the engine knows. It lists what is wrong.
func declarationProblems(s Subject) []string {
	var problems []string
	fail := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	a := s.Adapter
	if a.Name() == "" {
		fail("Name is empty: it keys every external row")
	}
	sup := bridge.FeaturesOf(a)
	caps := a.Capabilities()
	for f := range sup {
		if !feature.Valid(f) {
			fail("feature %q is not in the list of features (internal/bridge/feature)", f)
		}
	}
	_, sender := a.(bridge.Sender)
	_, pinReader := a.(bridge.PinReader)
	_, pinner := a.(bridge.Pinner)
	_, topicReader := a.(bridge.TopicReader)
	if sup[feature.Messages].Out && !sender {
		fail("messages go out but the adapter is not a bridge.Sender")
	}
	if sup[feature.Messages].Out != caps.Has(bridge.CapSend) {
		fail("messages out is %v but CapSend is %v", sup[feature.Messages].Out, caps.Has(bridge.CapSend))
	}
	if sup[feature.Pins].In && !pinReader {
		fail("pins come in but the adapter is not a bridge.PinReader")
	}
	if sup[feature.Pins].Out && (!pinner || !sender) {
		fail("pins go out but the adapter is not both a bridge.Pinner and a bridge.Sender")
	}
	if (sup[feature.Pins].In || sup[feature.Pins].Out) != caps.Has(bridge.CapPins) {
		fail("pins are supported = %v but CapPins is %v", sup[feature.Pins].In || sup[feature.Pins].Out, caps.Has(bridge.CapPins))
	}
	if sup[feature.Topics].In && !topicReader {
		fail("topics come in but the adapter is not a bridge.TopicReader")
	}
	if sup[feature.Topics].In != caps.Has(bridge.CapTopics) {
		fail("topics in is %v but CapTopics is %v", sup[feature.Topics].In, caps.Has(bridge.CapTopics))
	}
	if sup[feature.Topics].Out && !pinner {
		fail("topics go out (their pin) but the adapter is not a bridge.Pinner")
	}
	_, dialogReader := a.(bridge.DialogReader)
	_, dialogWriter := a.(bridge.DialogWriter)
	for _, f := range []feature.Feature{feature.Notify, feature.Dialog} {
		if sup[f].In && !dialogReader {
			fail("%s comes in but the adapter is not a bridge.DialogReader", f)
		}
		if sup[f].Out && !dialogWriter {
			fail("%s goes out but the adapter is not a bridge.DialogWriter", f)
		}
	}
	_, memberReader := a.(bridge.MemberReader)
	_, memberWriter := a.(bridge.MemberWriter)
	if sup[feature.Members].In && !memberReader {
		fail("members come in but the adapter is not a bridge.MemberReader")
	}
	if sup[feature.Members].Out && !memberWriter {
		fail("members go out but the adapter is not a bridge.MemberWriter")
	}
	_, inviteMgr := a.(bridge.InviteManager)
	_, lifecycle := a.(bridge.GroupLifecycle)
	if (sup[feature.Invites].In || sup[feature.Invites].Out) && !inviteMgr {
		fail("invites are supported but the adapter is not a bridge.InviteManager")
	}
	if sup[feature.Lifecycle].Out && !lifecycle {
		fail("lifecycle goes out but the adapter is not a bridge.GroupLifecycle")
	}
	_, infoReader := a.(bridge.InfoReader)
	_, infoWriter := a.(bridge.InfoWriter)
	if sup[feature.Info].In && !infoReader {
		fail("info comes in but the adapter is not a bridge.InfoReader")
	}
	if sup[feature.Info].Out && !infoWriter {
		fail("info goes out but the adapter is not a bridge.InfoWriter")
	}
	_, reactionReader := a.(bridge.ReactionReader)
	_, reactionWriter := a.(bridge.ReactionWriter)
	if sup[feature.Reactions].In && !reactionReader {
		fail("reactions come in but the adapter is not a bridge.ReactionReader")
	}
	if sup[feature.Reactions].Out && !reactionWriter {
		fail("reactions go out but the adapter is not a bridge.ReactionWriter")
	}
	for f, v := range sup {
		if !v.In && !v.Out {
			fail("feature %q is listed with neither direction: leave it out", f)
		}
	}
	return problems
}

func (s Subject) ready() bool { return s.Conversation != "" && len(s.MessageIDs) >= 3 }

// checkMessages reads the history and, if the app takes messages, sends one
// twice with the same RandomID.
func checkMessages(t *testing.T, s Subject) {
	if !s.ready() {
		t.Skip("no conversation given")
	}
	ctx := context.Background()
	convs, err := s.Adapter.ListConversations(ctx, s.Account)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(convs, func(c bridge.Conversation) bool { return c.ID == s.Conversation }) {
		t.Fatalf("ListConversations does not list %s", s.Conversation)
	}
	// The history, page by page, newest first, no id twice, and it ends.
	var got []string
	cur := bridge.Cursor{}
	for pages := 0; ; pages++ {
		if pages > 1000 {
			t.Fatal("Backfill never says Done")
		}
		page, err := s.Adapter.Backfill(ctx, s.Account, s.Conversation, cur, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range page.Messages {
			got = append(got, m.ID)
			if m.Conversation != s.Conversation {
				t.Errorf("message %s is of conversation %q, want %q", m.ID, m.Conversation, s.Conversation)
			}
		}
		if page.Done {
			break
		}
		if page.Next.Before == "" || page.Next == cur {
			t.Fatal("Backfill is not Done but gives no new cursor: the import would never end")
		}
		cur = page.Next
	}
	seen := map[string]bool{}
	for _, id := range got {
		if seen[id] {
			t.Errorf("message %s comes twice in the history", id)
		}
		seen[id] = true
	}
	for _, id := range s.MessageIDs {
		if !seen[id] {
			t.Errorf("message %s is not in the history", id)
		}
	}
	if sender, ok := s.Adapter.(bridge.Sender); ok && bridge.FeaturesOf(s.Adapter)[feature.Messages].Out {
		m := bridge.OutMessage{Conversation: s.Conversation, Text: "conformance", RandomID: 7_000_000_001}
		a, err := sender.SendMessage(ctx, s.Account, m)
		if err != nil {
			t.Fatal(err)
		}
		b, err := sender.SendMessage(ctx, s.Account, m)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(a.IDs, b.IDs) {
			t.Errorf("a repeated RandomID made a second message: %v then %v (an adapter that cannot promise this must not declare messages out)", a.IDs, b.IDs)
		}
		_ = sender.DeleteMessages(ctx, s.Account, bridge.Delete{Conversation: s.Conversation, IDs: a.IDs})
	}
}

// checkPins pins and unpins a message and reads the list back. Doing the same
// twice must be a success (the engine repeats a call it is not sure reached the app).
func checkPins(t *testing.T, s Subject) {
	sup := bridge.FeaturesOf(s.Adapter)[feature.Pins]
	if !sup.In && !sup.Out {
		t.Skip("the adapter has no pins")
	}
	if !s.ready() {
		t.Skip("no conversation given")
	}
	ctx := context.Background()
	id := s.MessageIDs[2]
	list := func() []string {
		pr, ok := s.Adapter.(bridge.PinReader)
		if !ok {
			return nil
		}
		ids, err := pr.ListPinned(ctx, s.Account, s.Conversation)
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	if sup.In {
		list() // reads without error
	}
	pinner, ok := s.Adapter.(bridge.Pinner)
	if !sup.Out || !ok {
		return
	}
	for _, step := range []struct {
		pinned bool
		times  int
	}{{true, 2}, {false, 2}} {
		for i := 0; i < step.times; i++ {
			if err := pinner.PinMessage(ctx, s.Account, s.Conversation, id, step.pinned); err != nil {
				if errors.Is(err, bridge.ErrNotAllowed) {
					t.Skipf("the test account may not pin here: %v", err)
				}
				t.Fatalf("PinMessage(%v) attempt %d: %v", step.pinned, i+1, err)
			}
		}
		if sup.In && slices.Contains(list(), id) != step.pinned {
			t.Errorf("after PinMessage(%v) the pinned list is %v", step.pinned, list())
		}
	}
}

// checkDialogs reads the state of a conversation and, if the app takes it, sets each
// kind twice to a state and back: setting what already is must succeed.
func checkDialogs(t *testing.T, s Subject) {
	sup := bridge.FeaturesOf(s.Adapter)
	if !sup[feature.Notify].In && !sup[feature.Notify].Out && !sup[feature.Dialog].In && !sup[feature.Dialog].Out {
		t.Skip("the adapter has no dialog state")
	}
	if !s.ready() {
		t.Skip("no conversation given")
	}
	ctx := context.Background()
	if r, ok := s.Adapter.(bridge.DialogReader); ok {
		got, err := r.DialogStates(ctx, s.Account, []string{s.Conversation})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := got[s.Conversation]; !ok {
			t.Fatalf("DialogStates does not answer for %s", s.Conversation)
		}
	}
	w, ok := s.Adapter.(bridge.DialogWriter)
	if !ok {
		return
	}
	read := func() bridge.DialogState {
		r, ok := s.Adapter.(bridge.DialogReader)
		if !ok {
			return bridge.DialogState{}
		}
		got, err := r.DialogStates(ctx, s.Account, []string{s.Conversation})
		if err != nil {
			t.Fatal(err)
		}
		return got[s.Conversation]
	}
	before := read()
	defer func() { // leave the conversation as it was
		_ = w.SetDialogPinned(ctx, s.Account, s.Conversation, before.Pinned)
		_ = w.SetUnreadMark(ctx, s.Account, s.Conversation, before.UnreadMark)
		_ = w.SetMute(ctx, s.Account, s.Conversation, before.MuteUntil)
	}()
	for i := 0; i < 2; i++ {
		if sup[feature.Dialog].Out {
			if err := w.SetDialogPinned(ctx, s.Account, s.Conversation, !before.Pinned); err != nil {
				if errors.Is(err, bridge.ErrNotAllowed) {
					t.Skipf("the test account may not do this here: %v", err)
				}
				t.Fatalf("SetDialogPinned attempt %d: %v", i+1, err)
			}
			if err := w.SetUnreadMark(ctx, s.Account, s.Conversation, !before.UnreadMark); err != nil {
				t.Fatalf("SetUnreadMark attempt %d: %v", i+1, err)
			}
		}
		if sup[feature.Notify].Out {
			if err := w.SetMute(ctx, s.Account, s.Conversation, 2147483647); err != nil {
				t.Fatalf("SetMute attempt %d: %v", i+1, err)
			}
		}
	}
	if _, ok := s.Adapter.(bridge.DialogReader); ok {
		now := read()
		if sup[feature.Dialog].Out && (now.Pinned == before.Pinned || now.UnreadMark == before.UnreadMark) {
			t.Errorf("the dialog state read back is %+v after setting it from %+v", now, before)
		}
		if sup[feature.Notify].Out && now.MuteUntil == before.MuteUntil && before.MuteUntil != 2147483647 {
			t.Errorf("the mute read back is %d after muting", now.MuteUntil)
		}
	}
}

// checkReactions reads the reactions of the newest message and, if the app takes them,
// sets the owner's reaction twice and removes it twice: repeating either must succeed,
// and what is read back must follow.
func checkReactions(t *testing.T, s Subject) {
	sup := bridge.FeaturesOf(s.Adapter)
	if !sup[feature.Reactions].In && !sup[feature.Reactions].Out {
		t.Skip("the adapter has no reactions")
	}
	if !s.ready() {
		t.Skip("no conversation given")
	}
	ctx := context.Background()
	id := s.MessageIDs[0]
	reader, canRead := s.Adapter.(bridge.ReactionReader)
	owner := func() (string, bool) {
		got, err := reader.MessageReactions(ctx, s.Account, s.Conversation, []string{id})
		if err != nil {
			t.Fatal(err)
		}
		for _, rs := range got {
			if rs.ID != id {
				continue
			}
			if !rs.OwnerKnown {
				return "", false
			}
			for _, r := range rs.List {
				if r.From.IsSelf {
					return r.Emoji, true
				}
			}
			return "", true
		}
		t.Fatalf("MessageReactions does not answer for message %s", id)
		return "", false
	}
	before, known := "", false
	if canRead {
		before, known = owner()
	}
	w, ok := s.Adapter.(bridge.ReactionWriter)
	if !ok {
		return
	}
	defer func() { _ = w.SetReaction(ctx, s.Account, s.Conversation, id, before) }() // leave it as it was
	for _, emoji := range []string{"👍", "👍", "", ""} {
		if err := w.SetReaction(ctx, s.Account, s.Conversation, id, emoji); err != nil {
			if errors.Is(err, bridge.ErrNotAllowed) {
				t.Skipf("the test account may not react here: %v", err)
			}
			t.Fatalf("SetReaction %q: %v", emoji, err)
		}
		if !canRead || !known {
			continue
		}
		if got, _ := owner(); got != emoji {
			t.Errorf("the owner's reaction read back is %q after setting %q", got, emoji)
		}
	}
}

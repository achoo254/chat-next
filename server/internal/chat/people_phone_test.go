package chat

import (
	"bytes"
	"context"
	"crypto/sha256"
	"slices"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"google.golang.org/protobuf/proto"
)

// setPhoneHash records a phone hash on a puppet, the way the bridge engine does.
func (h *harness) setPhoneHash(puppet int64, hash []byte) {
	h.t.Helper()
	if _, err := h.st.Pool().Exec(context.Background(), `UPDATE external_users SET phone_hmac = $2 WHERE user_id = $1`, puppet, hash); err != nil {
		h.t.Fatal(err)
	}
}

// suggestionPairs lists the suggestions as (reason, first, second) in the order given.
func suggestionPairs(list []*appv1.LinkSuggestion) [][3]int64 {
	out := make([][3]int64, 0, len(list))
	for _, s := range list {
		out = append(out, [3]int64{int64(s.GetReason()), s.GetFirst().GetUserId(), s.GetSecond().GetUserId()})
	}
	return out
}

func TestSamePhoneIsAStrongSuggestionListedBeforeNames(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	acct1, acct2 := h.bridgeAccount(owner, "tg-1"), h.bridgeAccount(owner, "zl-1")
	hash := sha256.Sum256([]byte("one number"))
	a, _ := h.puppetDM(owner, acct1, "Nguyễn Lan")
	b, _ := h.puppetDM(owner, acct2, "Bé Út")
	c, _ := h.puppetDM(owner, acct2, "Nguyễn Lan")
	d, _ := h.puppetDM(owner, acct2, "Nguyễn Lan")
	for _, id := range []int64{a, b, d} {
		h.setPhoneHash(id, hash[:])
	}

	phone := int64(appv1.LinkSuggestionReason_LINK_SUGGESTION_REASON_PHONE)
	name := int64(appv1.LinkSuggestionReason_LINK_SUGGESTION_REASON_NAME)
	// b and d share the number but are puppets of one account: never suggested. a and d match by
	// both, listed once, by phone; the phone suggestions come first.
	want := [][3]int64{{phone, a, b}, {phone, a, d}, {name, a, c}}
	if got := suggestionPairs(h.suggestions(owner, 0)); !slices.Equal(got, want) {
		t.Fatalf("suggestions = %v, want %v", got, want)
	}
	if got := suggestionPairs(h.suggestions(owner, b)); !slices.Equal(got, [][3]int64{{phone, a, b}}) {
		t.Fatalf("suggestions for b = %v", got)
	}

	// Rejecting and linking hide a phone pair like a name pair; nothing is linked on its own.
	if err := h.svc.RejectLinkSuggestion(ctx, owner, b, a); err != nil {
		t.Fatal(err)
	}
	if len(h.people(owner)) != 0 {
		t.Fatal("a suggestion linked people on its own")
	}
	h.link(owner, a, d)
	if got := suggestionPairs(h.suggestions(owner, 0)); !slices.Equal(got, [][3]int64{{name, a, c}}) {
		t.Fatalf("after reject and link = %v", got)
	}
}

func TestPhoneSuggestionsStayWithinOneOwner(t *testing.T) {
	h := newHarness(t, nil)
	hash := sha256.Sum256([]byte("one number"))
	owner, other := h.user("owner"), h.user("other")
	mine, _ := h.puppetDM(owner, h.bridgeAccount(owner, "tg-1"), "A")
	theirs1, _ := h.puppetDM(other, h.bridgeAccount(other, "tg-2"), "B")
	theirs2, _ := h.puppetDM(other, h.bridgeAccount(other, "zl-2"), "C")
	for _, id := range []int64{mine, theirs1, theirs2} {
		h.setPhoneHash(id, hash[:])
	}
	if got := h.suggestions(owner, 0); len(got) != 0 {
		t.Fatalf("the owner sees another owner's people: %v", suggestionPairs(got))
	}
	phone := int64(appv1.LinkSuggestionReason_LINK_SUGGESTION_REASON_PHONE)
	if got := suggestionPairs(h.suggestions(other, 0)); !slices.Equal(got, [][3]int64{{phone, min(theirs1, theirs2), max(theirs1, theirs2)}}) {
		t.Fatalf("other's suggestions = %v", got)
	}
}

// The hash stays on the server: no message of the people RPCs has a field for
// it, and an answer that comes from it does not carry its bytes.
func TestThePhoneHashIsInNoPeopleAnswer(t *testing.T) {
	for _, m := range []proto.Message{&appv1.PersonMember{}, &appv1.Person{}, &appv1.LinkSuggestion{},
		&appv1.ListLinkSuggestionsResponse{}, &appv1.ListPeopleResponse{}, &appv1.LinkUsersResponse{}} {
		fields := m.ProtoReflect().Descriptor().Fields()
		for i := range fields.Len() {
			if f := fields.Get(i); strings.Contains(strings.ToLower(string(f.Name())), "phone") {
				t.Errorf("%s has the field %s", m.ProtoReflect().Descriptor().FullName(), f.Name())
			}
		}
	}
	h := newHarness(t, nil)
	owner := h.user("owner")
	hash := sha256.Sum256([]byte("one number"))
	a, _ := h.puppetDM(owner, h.bridgeAccount(owner, "tg-1"), "A")
	b, _ := h.puppetDM(owner, h.bridgeAccount(owner, "zl-1"), "B")
	h.setPhoneHash(a, hash[:])
	h.setPhoneHash(b, hash[:])
	list := h.suggestions(owner, 0)
	if len(list) != 1 {
		t.Fatalf("suggestions = %d, want the phone pair", len(list))
	}
	h.link(owner, a, b)
	for _, m := range []proto.Message{&appv1.ListLinkSuggestionsResponse{Suggestions: list}, &appv1.ListPeopleResponse{People: h.people(owner)}} {
		wire, err := proto.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(wire, hash[:]) {
			t.Fatalf("%T carries the phone hash", m)
		}
	}
}

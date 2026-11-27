package zalo

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

func TestTargetKeepsGroupsAndPeopleApart(t *testing.T) {
	cases := []struct {
		conv      string
		to        string
		group, ok bool
	}{
		{"500", "500", false, true},
		{"g500", "500", true, true},
		{"g", "", false, false},
		{"gabc", "", false, false},
		{"G500", "", false, false},
		{"g500x", "", false, false},
		{"", "", false, false},
	}
	for _, c := range cases {
		to, group, ok := target(c.conv)
		if to != c.to || group != c.group || ok != c.ok {
			t.Errorf("target(%q) = %q, %v, %v; want %q, %v, %v", c.conv, to, group, ok, c.to, c.group, c.ok)
		}
	}
}

func TestGroupMessageOfAMemberAndOfTheOwner(t *testing.T) {
	now := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	member := wireEvent{Thread: threadGroup, GroupID: "900", GroupName: " Nhà mình ", MsgID: "1", UIDFrom: "501", IDTo: "900",
		DName: "Minh", PeerAvatar: "https://s120-ava-talk.zadn.vn/m.jpg", PeerSeen: now.UnixMilli(), MsgType: msgTypeText, Content: []byte(`"chào"`), TS: "1763700000000"}
	m, conv, err := mapMessage(member, now)
	if err != nil {
		t.Fatal(err)
	}
	if conv.ID != "g900" || conv.Kind != bridge.ConvGroup || conv.Title != "Nhà mình" || conv.Peer != nil || conv.PhotoRef != "" {
		t.Errorf("conversation = %+v", conv)
	}
	if m.Conversation != "g900" || m.Text != "chào" || m.From.ID != "501" || m.From.Name != "Minh" || m.From.NameUnknown ||
		!m.From.PhotoKnown || !m.From.SeenKnown || m.From.IsSelf || m.Peer != nil {
		t.Errorf("member message = %+v", m)
	}

	own := wireEvent{Thread: threadGroup, GroupID: "900", Self: true, MsgID: "2", UIDFrom: "999", IDTo: "900", DName: "Chủ", MsgType: msgTypeText, Content: []byte(`"ok"`)}
	m, conv, err = mapMessage(own, now)
	if err != nil {
		t.Fatal(err)
	}
	if !m.From.IsSelf || m.From.ID != "999" || m.From.Name != "" || conv.Title != "" {
		t.Errorf("own message = %+v in %+v, want the owner and a group not named yet", m, conv)
	}

	nameless := member
	nameless.DName = ""
	if m, _, _ := mapMessage(nameless, now); !m.From.NameUnknown || m.From.Name != "Zalo 501" {
		t.Errorf("a member without a name = %+v, want a stand-in name", m.From)
	}
	for _, bad := range []string{"", "g900", "abc"} {
		ev := member
		ev.GroupID = looseString(bad)
		if _, _, err := mapMessage(ev, now); err == nil {
			t.Errorf("group id %q was accepted", bad)
		}
	}
}

func TestAGroupIsListedOnceItsNameIsKnown(t *testing.T) {
	h := newHeardAccount(time.Now)
	unnamed := bridge.Conversation{ID: "g900", Kind: bridge.ConvGroup}
	h.record(unnamed, bridge.Message{Conversation: "g900", ID: "1"})
	if got := h.conversations(); len(got) != 0 {
		t.Fatalf("listed %+v before the group had a name", got)
	}
	h.record(bridge.Conversation{ID: "g900", Kind: bridge.ConvGroup, Title: "Nhà mình"}, bridge.Message{Conversation: "g900", ID: "2"})
	h.record(unnamed, bridge.Message{Conversation: "g900", ID: "3"})
	got := h.conversations()
	if len(got) != 1 || got[0].Title != "Nhà mình" {
		t.Fatalf("conversations = %+v, want the group under its name, kept when a later message has none", got)
	}
	if page := h.takeRecent("g900", 10); len(page) != 3 {
		t.Errorf("kept %d messages, want all three", len(page))
	}
}

func TestSendToAGroupGoesOutAsAGroupCommandOnce(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	m := bridge.OutMessage{Conversation: "g900", Text: "chào cả nhà", RandomID: 1}
	first, err := send(t, a, m)
	if err != nil {
		t.Fatal(err)
	}
	again, err := send(t, a, m)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.IDs) != 1 || !slices.Equal(first.IDs, again.IDs) || z.created("chào cả nhà") != 1 {
		t.Fatalf("refs %v then %v, %d created; want one message", first.IDs, again.IDs, z.created("chào cả nhà"))
	}
	z.set(func(z *zaloSim) {
		if len(z.sendCmds) != 1 || z.sendCmds[0].To != "900" || !z.sendCmds[0].Group {
			t.Errorf("send commands = %+v, want one to group 900", z.sendCmds)
		}
		if z.messages[len(z.messages)-1].peer != "g900" {
			t.Errorf("the message went to %q", z.messages[len(z.messages)-1].peer)
		}
	})
	// The group was not heard yet, so its own history was read to prove the account is in it.
	if z.historyReads() != 1 {
		t.Errorf("history reads = %d, want the group's page once", z.historyReads())
	}
}

// A group send whose answer and echo were lost is found in the group's own history
// once the listener is back, and is not sent again.
func TestALostGroupSendIsFoundInTheGroupsHistory(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	if _, err := send(t, a, bridge.OutMessage{Conversation: "g900", Text: "trước", RandomID: 6}); err != nil {
		t.Fatal(err)
	}
	z.set(func(z *zaloSim) { z.dropAnswers, z.listenerOff = 1, true })
	m := bridge.OutMessage{Conversation: "g900", Text: "một lần thôi", RandomID: 7}
	if _, err := send(t, a, m); err == nil {
		t.Fatal("the unanswered send succeeded")
	}
	waitPastLastTry(a)
	z.set(func(z *zaloSim) { z.listenerOff = false })
	ref, err := send(t, a, m)
	if err != nil {
		t.Fatal(err)
	}
	if z.created("một lần thôi") != 1 || z.sends() != 2 || len(ref.IDs) != 1 {
		t.Fatalf("created %d, sends %d, ref %v; want the first try found, not sent again", z.created("một lần thôi"), z.sends(), ref)
	}
}

func TestRecallAndReactionInAGroupNameTheGroup(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.SetReaction(ctx, testAccount, "g900", "4100", "👍"); err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteMessages(ctx, testAccount, bridge.Delete{Conversation: "g900", IDs: []string{"4100"}}); err != nil {
		t.Fatal(err)
	}
	z.set(func(z *zaloSim) {
		if len(z.reacts) != 1 || z.reacts[0].To != "900" || !z.reacts[0].Group || z.reacts[0].Icon == nil || *z.reacts[0].Icon != "/-strong" {
			t.Errorf("react commands = %+v", z.reacts)
		}
		if len(z.undos) != 1 || z.undos[0].To != "900" || !z.undos[0].Group {
			t.Errorf("undo commands = %+v", z.undos)
		}
	})
	for _, conv := range []string{"gx", "g"} {
		if err := a.SetReaction(ctx, testAccount, conv, "4100", "👍"); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("reaction in %q: %v, want refused", conv, err)
		}
	}
}

func TestGroupInfosReadsNamesAndPhotosOfGroupsOnly(t *testing.T) {
	z := newZaloSim(t)
	z.groups = map[string]string{"900": "Nhà mình"}
	a, _, _ := simAccount(t, z, false)
	infos, err := a.GroupInfos(context.Background(), testAccount, []string{"500", "g900", "g901"})
	if err != nil {
		t.Fatal(err)
	}
	want := bridge.GroupInfo{Title: "Nhà mình", About: "mô tả Nhà mình",
		PhotoID: "https://s120-ava-grp-talk.zadn.vn/900.jpg", PhotoRef: "avatar:https://s120-ava-grp-talk.zadn.vn/900.jpg"}
	if len(infos) != 1 || infos["g900"] != want {
		t.Errorf("infos = %+v, want only group 900", infos)
	}
	z.set(func(z *zaloSim) {
		if len(z.groupInfos) != 1 || !slices.Equal(z.groupInfos[0].Groups, []string{"900", "901"}) {
			t.Errorf("group_info commands = %+v, want one for 900 and 901", z.groupInfos)
		}
	})
}

func TestGroupInfosWithoutASidecarReadsNothing(t *testing.T) {
	a, _ := newTestAdapter(t, &fakeRunner{})
	infos, err := a.GroupInfos(context.Background(), testAccount, []string{"g900"})
	if err != nil || len(infos) != 0 {
		t.Fatalf("infos = %+v, err = %v; want nothing and no error", infos, err)
	}
}

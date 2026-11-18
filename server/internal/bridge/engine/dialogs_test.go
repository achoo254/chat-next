package engine_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

type ownerState struct {
	mute   int64
	pinned bool
	unread bool
}

func (e *env) ownerState(chatID int64) ownerState {
	e.t.Helper()
	var s ownerState
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT coalesce(mute_until, 0), pin_rank IS NOT NULL, unread_mark FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
		chatID, e.owner).Scan(&s.mute, &s.pinned, &s.unread); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *env) waitOwner(chatID int64, ok func(ownerState) bool, what string) {
	e.t.Helper()
	e.eventually(func() bool { return ok(e.ownerState(chatID)) }, func() string { return fmt.Sprintf("%s: owner state = %+v", what, e.ownerState(chatID)) })
}

func TestTheStateOfAChatInTheOtherAppReachesTheOwnersListAndChanges(t *testing.T) {
	e := newEnv(t)
	until := time.Now().Add(time.Hour).Unix()
	e.fake.SetDialogState("g1", bridge.DialogState{MuteUntil: until, Pinned: true, UnreadMark: true})
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	// the first look takes the other app as the source
	e.waitOwner(chatID, func(s ownerState) bool { return s.mute == until && s.pinned && s.unread }, "first look")
	// a change in the other app comes in on the next look
	e.fake.SetDialogState("g1", bridge.DialogState{})
	e.waitOwner(chatID, func(s ownerState) bool { return s.mute == 0 && !s.pinned && !s.unread }, "cleared in the other app")
}

func TestDialogStateSetInChatGoesOutAndIsNotReadBackAsAChangeFromElsewhere(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	until := time.Now().Add(2 * time.Hour).Unix()
	if _, err := e.chat.SetDialogMute(ctx, e.owner, chatID, 7200, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.SetDialogPinned(ctx, e.owner, chatID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.SetDialogUnreadMark(ctx, e.owner, chatID, true); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.DialogCalls()) == 3 }, func() string { return fmt.Sprint(e.fake.DialogCalls()) })
	st := e.fake.DialogState("g1")
	if st.MuteUntil < until-5 || st.MuteUntil > until+5 || !st.Pinned || !st.UnreadMark {
		t.Fatalf("the other app has %+v after the three changes", st)
	}
	// several looks later Chat still has what the owner set
	time.Sleep(250 * time.Millisecond)
	if s := e.ownerState(chatID); !s.pinned || !s.unread || s.mute == 0 {
		t.Fatalf("Chat lost the state the owner set: %+v", s)
	}
	// and a change made in the other app afterwards still comes in
	e.fake.SetDialogState("g1", bridge.DialogState{MuteUntil: st.MuteUntil, Pinned: false, UnreadMark: true})
	e.waitOwner(chatID, func(s ownerState) bool { return !s.pinned && s.unread }, "unpinned in the other app")
}

func TestWhileAChangeWaitsToGoOutTheOtherAppsOlderStateDoesNotOverwriteIt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	// the other app is throttled for a while: the pin waits in the outbox
	e.fake.FailPin(&bridge.RateLimitError{RetryAfter: 600 * time.Millisecond})
	if _, err := e.chat.SetDialogPinned(ctx, e.owner, chatID, true); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !e.ownerState(chatID).pinned {
			t.Fatal("the pin was undone by a look at the other app while it waited to go out")
		}
		time.Sleep(15 * time.Millisecond)
	}
	e.eventually(func() bool { return e.fake.DialogState("g1").Pinned }, func() string { return "the pin never went out" })
}

func TestAStateTheOtherAppRefusesIsPutBackToWhatItHas(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.fake.FailPin(fmt.Errorf("%w: refused", bridge.ErrNotAllowed))
	if _, err := e.chat.SetDialogUnreadMark(ctx, e.owner, chatID, true); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, 0, "set_unread_mark", "failed")
	e.waitOwner(chatID, func(s ownerState) bool { return !s.unread }, "refused change put back")
}

func TestOnlyTheLastStateOfAKindIsSent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.stop()
	for _, on := range []bool{true, false, true, false} {
		if _, err := e.chat.SetDialogPinned(ctx, e.owner, chatID, on); err != nil {
			t.Fatal(err)
		}
	}
	e.start()
	e.eventually(func() bool { return len(e.fake.DialogCalls()) == 1 }, func() string { return fmt.Sprint(e.fake.DialogCalls()) })
	if got := e.fake.DialogCalls()[0]; got != "pin:g1:false" {
		t.Fatalf("call = %s, want the last state (unpinned)", got)
	}
}

func TestAFeatureSwitchedOffNeitherReadsNorSendsItsDialogState(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	eng := e.start()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Dialog, feature.Off); err != nil {
		t.Fatal(err)
	}
	e.fake.SetDialogState("g1", bridge.DialogState{Pinned: true, UnreadMark: true, MuteUntil: time.Now().Add(time.Hour).Unix()})
	time.Sleep(200 * time.Millisecond)
	if s := e.ownerState(chatID); s.pinned || s.unread {
		t.Fatalf("dialog state came in with the feature off: %+v", s)
	}
	if _, err := e.chat.SetDialogPinned(ctx, e.owner, chatID, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	for _, c := range e.fake.DialogCalls() {
		if c == "pin:g1:true" {
			t.Fatal("a pin of the chat went out with the dialog feature off")
		}
	}
	// notify is a feature of its own: its state still came in...
	e.eventually(func() bool { return e.ownerState(chatID).mute != 0 }, func() string { return "mute did not come in" })
	// ...and when it is switched off too, a mute set in Chat stays in Chat
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Notify, feature.Off); err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.SetDialogMute(ctx, e.owner, chatID, 60, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	for _, c := range e.fake.DialogCalls() {
		if strings.HasPrefix(c, "mute:") {
			t.Fatal("a mute went out with the notify feature off")
		}
	}
}

func TestAChatThatOnlyReadsTakesStateButNeverSendsIt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetDialogState("g1", bridge.DialogState{Pinned: true})
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	e.waitOwner(chatID, func(s ownerState) bool { return s.pinned }, "state in")
	if _, err := e.chat.SetDialogMute(ctx, e.owner, chatID, 3600, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if n := len(e.fake.DialogCalls()); n != 0 {
		t.Fatalf("%d calls went to the other app from a chat that only reads", n)
	}
}

package engine_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/engine"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
)

// bareApp is an app that can only be read: it hides everything of the fake it wraps
// but the interface every adapter has, to stand for a platform with few features.
type bareApp struct{ bridge.Adapter }

func (b bareApp) Capabilities() bridge.Capabilities {
	return bridge.Capabilities{bridge.CapHistory: true, bridge.CapLive: true}
}

func (e *env) enableWith(conv bridge.Conversation) (*engine.Engine, int64) {
	e.t.Helper()
	eng := e.start()
	chatID, err := eng.EnableChat(context.Background(), e.account, conv, 100)
	if err != nil {
		e.t.Fatal(err)
	}
	return eng, chatID
}

func viewsByFeature(views []engine.FeatureView) map[feature.Feature]engine.FeatureView {
	out := map[feature.Feature]engine.FeatureView{}
	for _, v := range views {
		out[v.Feature] = v
	}
	return out
}

func TestTheFeaturesOfAChatAreThoseTheAppSupportsWithTheirDirection(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	views, err := eng.Features(ctx, e.owner, e.account, "g1")
	if err != nil {
		t.Fatal(err)
	}
	got := viewsByFeature(views)
	for _, f := range []feature.Feature{feature.Messages, feature.Pins, feature.Read} {
		if _, ok := got[f]; !ok {
			t.Errorf("%s is not listed for an app that supports it", f)
		}
	}
	if m, ok := got[feature.Members]; !ok || m.Direction != feature.In || m.Risk != feature.R3 {
		t.Errorf("members view = %+v: an app that does them lists them, following the chat like any feature (ADR 0024)", m)
	}
	if p := got[feature.Pins]; p.Direction != feature.Both && p.Direction != feature.In || !p.Default || p.Risk != feature.R1 {
		t.Errorf("pins view = %+v", p)
	}
	// the chat reads by default (messages in); pins follow it
	if got[feature.Messages].Direction != feature.In || got[feature.Pins].Direction != feature.In {
		t.Errorf("a chat that only reads has messages %s and pins %s", got[feature.Messages].Direction, got[feature.Pins].Direction)
	}
}

func TestAFeatureSwitchedOffNoLongerReceivesOrSends(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	eng := e.start()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Pins, feature.Off); err != nil {
		t.Fatal(err)
	}
	// inbound: the other app pins a message, Chat ignores it
	e.fake.Push(bridge.Event{Pin: &bridge.PinChange{Conversation: "g1", IDs: []string{"m1"}, Pinned: true}})
	// messages still come in
	e.fake.Push(bridge.Event{Message: func() *bridge.Message { m := e.msg("m3", lan, "tin 3", 3); return &m }()})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	if got := e.pinnedTexts(chatID); len(got) != 0 {
		t.Fatalf("a pin came in with pins off: %v", got)
	}
	// outbound: pinning in Chat is not queued
	seq := e.seqOf(chatID, "m1")
	if _, err := e.chat.PinMessage(ctx, e.owner, chatID, seq, false); err != nil {
		t.Fatal(err)
	}
	if n := e.pinRows(chatID); n != 0 {
		t.Fatalf("%d pin rows with pins off, want none", n)
	}
	// turned on again, the same pin from the other app comes in
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Pins, feature.Both); err != nil {
		t.Fatal(err)
	}
	e.fake.Push(bridge.Event{Pin: &bridge.PinChange{Conversation: "g1", IDs: []string{"m2"}, Pinned: true}})
	e.waitPinned(chatID, []string{"tin 1", "tin 2"})
}

func TestARowQueuedBeforeAFeatureWasSwitchedOffIsNotSent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	seq := e.seqOf(chatID, "m1")
	e.stop() // the row waits in the outbox
	if _, err := e.chat.PinMessage(ctx, e.owner, chatID, seq, false); err != nil {
		t.Fatal(err)
	}
	// switched off behind the back of the chat service (an older server, a manual change)
	if _, err := e.st.Pool().Exec(ctx, `
		INSERT INTO external_chat_features (account_id, external_chat_id, feature, direction) VALUES ($1, 'g1', 'pins', 'in')`, e.account); err != nil {
		t.Fatal(err)
	}
	e.start()
	e.waitOutbox(chatID, seq, "pin_message", "cancelled")
	if n := len(e.fake.Pins()); n != 0 {
		t.Fatalf("%d pins reached the other app, want none", n)
	}
}

func TestAFeatureTheAppCannotDoIsRefusedAndNotListed(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.adapter = bareApp{e.fake}
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	views, err := eng.Features(ctx, e.owner, e.account, "g1")
	if err != nil {
		t.Fatal(err)
	}
	got := viewsByFeature(views)
	if _, ok := got[feature.Pins]; ok {
		t.Error("pins are listed for an app that has none")
	}
	if m := got[feature.Messages]; !m.Supported.In || m.Supported.Out {
		t.Errorf("messages of a read-only app: %+v", m.Supported)
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Pins, feature.In); !errors.Is(err, engine.ErrFeatureUnsupported) {
		t.Errorf("setting pins on an app without them = %v, want ErrFeatureUnsupported", err)
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Messages, feature.Both); err == nil {
		t.Error("messages both ways on an app that cannot be written to was accepted")
	}
}

func TestSetFeatureOnlyForAChatOfTheOwner(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1"})
	if err := eng.SetFeature(ctx, e.owner+1000, e.account, "g1", feature.Pins, feature.Off); err == nil {
		t.Error("another user changed the features of the chat")
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "unknown-conv", feature.Pins, feature.Off); !errors.Is(err, engine.ErrNotFound) {
		t.Errorf("a conversation that is not synced = %v, want ErrNotFound", err)
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", "nope", feature.Both); err == nil {
		t.Error("an unknown feature was accepted")
	}
	_ = fmt.Sprint
	_ = chat.DirectionBoth
}

// A platform other than Telegram: it reads messages and pins and takes nothing from
// Chat. The engine and the features of its chats follow, with no change to either.
func TestAPlatformWithAnotherSetOfFeaturesGetsItsOwnFeaturesAndBehaviour(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.fake.Support(feature.Messages, feature.Support{In: true}).Support(feature.Pins, feature.Support{In: true}).Support(feature.Topics, feature.Support{})
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1), e.msg("m2", lan, "tin 2", 2))
	e.fake.SetPinned("g1", "m2")
	eng, chatID := e.enableWith(conv)
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
	e.waitPinned(chatID, []string{"tin 2"})
	got := viewsByFeature(mustFeatures(t, eng, e))
	if _, ok := got[feature.Topics]; ok {
		t.Error("topics are listed for a platform without them")
	}
	if p := got[feature.Pins]; !p.Supported.In || p.Supported.Out {
		t.Errorf("pins of a read-only platform: %+v", p.Supported)
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Pins, feature.Both); !errors.Is(err, engine.ErrFeatureUnsupported) {
		t.Errorf("pins both ways on a platform that only reads them = %v, want ErrFeatureUnsupported", err)
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Pins, feature.Off); err != nil {
		t.Errorf("switching a feature off is always possible: %v", err)
	}
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Messages, feature.Both); err == nil {
		t.Error("sending to a platform that takes no messages was accepted")
	}
}

func mustFeatures(t *testing.T, eng *engine.Engine, e *env) []engine.FeatureView {
	t.Helper()
	views, err := eng.Features(context.Background(), e.owner, e.account, "g1")
	if err != nil {
		t.Fatal(err)
	}
	return views
}

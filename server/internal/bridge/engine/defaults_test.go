package engine_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/engine"
	"app.local/server/internal/bridge/feature"
)

func (e *env) directionOf(chatID int64, feat feature.Feature) feature.Direction {
	e.t.Helper()
	st, err := e.chat.ImportedFeatures(context.Background(), e.owner, chatID)
	if err != nil {
		e.t.Fatal(err)
	}
	return st[feat].Direction
}

func TestADefaultChosenForTheAccountIsWhatANewChatStartsWithAndApplyAllChangesTheOthers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	old := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	eng, oldChat := e.enableWith(old)
	e.waitTexts(oldChat, []string{"tin 1"})
	// choosing without "apply to all" leaves the chat already synced alone
	if n, err := eng.SetFeatureDefault(ctx, e.owner, e.account, feature.Alerts, feature.In, false); err != nil || n != 0 {
		t.Fatalf("set default = %d, %v", n, err)
	}
	// a chat synced afterwards starts with it
	g2 := e.group("g2")
	newChat, err := eng.EnableChat(ctx, e.account, g2, 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := e.directionOf(newChat, feature.Alerts); got != feature.In {
		t.Fatalf("a new chat starts with alerts %s, want in", got)
	}
	// apply to all reaches the old chat too
	if n, err := eng.SetFeatureDefault(ctx, e.owner, e.account, feature.Alerts, feature.In, true); err != nil || n != 2 {
		t.Fatalf("apply to all = %d, %v, want 2 chats", n, err)
	}
	if got := e.directionOf(oldChat, feature.Alerts); got != feature.In {
		t.Fatalf("apply to all left the old chat at %s", got)
	}
	list, err := eng.FeatureDefaults(ctx, e.owner, e.account)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range list {
		if d.Feature == feature.Alerts && (!d.Set || d.Direction != feature.In) {
			t.Fatalf("listed %+v", d)
		}
		if d.Feature == feature.Messages || d.Risk == feature.R3 {
			t.Fatalf("%s must not be a default", d.Feature)
		}
	}
}

func TestADefaultRefusesWhatActsOnPeopleOrTheMessagesAndWhatTheAppCannotDo(t *testing.T) {
	e := newEnv(t)
	eng := e.start()
	ctx := context.Background()
	for _, f := range []feature.Feature{feature.Messages, feature.Members, feature.Invites, feature.Lifecycle} {
		if _, err := eng.SetFeatureDefault(ctx, e.owner, e.account, f, feature.Both, true); !errors.Is(err, engine.ErrFeatureUnsupported) {
			t.Errorf("default of %s = %v, want ErrFeatureUnsupported", f, err)
		}
	}
	if _, err := eng.SetFeatureDefault(ctx, e.owner, e.account, feature.Alerts, feature.Out, true); !errors.Is(err, engine.ErrFeatureUnsupported) {
		t.Errorf("alerts going out = %v, want ErrFeatureUnsupported", err)
	}
}

func TestWhatDidNotGoThroughIsListedForTheAccountAndCanBeRetriedOrGivenUp(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	eng := e.start()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Tên gốc", About: "x"})
	e.waitInfo(chatID, "Tên gốc", "x")
	e.fake.FailPin(fmt.Errorf("%w: CHAT_ADMIN_REQUIRED", bridge.ErrNotAllowed))
	title := "Không được phép"
	if _, err := e.chat.UpdateChatInfo(ctx, e.owner, &appv1.UpdateChatInfoRequest{ChatId: chatID, Title: &title}); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, 0, "set_info", "failed")
	list, err := eng.Problems(ctx, e.owner, e.account)
	if err != nil || len(list) != 1 {
		t.Fatalf("problems = %+v, %v", list, err)
	}
	p := list[0]
	if p.Feature != string(feature.Info) || p.Op != "set_info" || p.LastError == "" || p.ChatTitle == "" {
		t.Fatalf("problem = %+v", p)
	}
	// somebody else's account sees nothing and cannot touch it
	if err := eng.DismissProblem(ctx, e.owner+999, e.account, p.ID); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("dismissed by another owner = %v", err)
	}
	if err := eng.RetryProblem(ctx, e.owner, e.account, p.ID); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, 0, "set_info", "sent")
	if list, _ := eng.Problems(ctx, e.owner, e.account); len(list) != 0 {
		t.Fatalf("a retried problem that went through is still listed: %+v", list)
	}
	// and one given up
	e.fake.FailPin(fmt.Errorf("%w: CHAT_ADMIN_REQUIRED", bridge.ErrNotAllowed))
	title = "Lại không được"
	if _, err := e.chat.UpdateChatInfo(ctx, e.owner, &appv1.UpdateChatInfoRequest{ChatId: chatID, Title: &title}); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { l, _ := eng.Problems(ctx, e.owner, e.account); return len(l) == 1 }, func() string { return "no second problem" })
	l, _ := eng.Problems(ctx, e.owner, e.account)
	if err := eng.DismissProblem(ctx, e.owner, e.account, l[0].ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if l, _ := eng.Problems(ctx, e.owner, e.account); len(l) != 0 {
		t.Fatalf("dismissed problem still listed: %+v", l)
	}
}

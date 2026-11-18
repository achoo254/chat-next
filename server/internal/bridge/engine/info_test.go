package engine_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

func (e *env) chatInfo(chatID int64) (title, about string) {
	e.t.Helper()
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT title, about FROM chats WHERE id = $1`, chatID).Scan(&title, &about); err != nil {
		e.t.Fatal(err)
	}
	return
}

func (e *env) waitInfo(chatID int64, title, about string) {
	e.t.Helper()
	e.eventually(func() bool { t, a := e.chatInfo(chatID); return t == title && a == about },
		func() string {
			t, a := e.chatInfo(chatID)
			return fmt.Sprintf("info = %q / %q, want %q / %q", t, a, title, about)
		})
}

func TestTheTitleAndDescriptionOfAGroupInTheOtherAppComeInAndChange(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Nhóm làm việc", About: "Mô tả ban đầu"})
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	e.waitInfo(chatID, "Nhóm làm việc", "Mô tả ban đầu")
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Nhóm đổi tên", About: ""})
	e.waitInfo(chatID, "Nhóm đổi tên", "")
	// no service message is made up for a change nobody can be named for
	if got := e.texts(chatID); len(got) != 1 {
		t.Fatalf("messages = %v, want only the imported one", got)
	}
}

func TestTheTitleOrDescriptionChangedInChatIsSentAndNotReadBackOver(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Nhóm g1", About: ""})
	title, about := "Tên mới", "Mô tả mới"
	if _, err := e.chat.UpdateChatInfo(ctx, e.owner, &appv1.UpdateChatInfoRequest{ChatId: chatID, Title: &title, About: &about}); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.InfoCalls()) == 1 }, func() string { return fmt.Sprint(e.fake.InfoCalls()) })
	if got := e.fake.GroupInfo("g1"); got.Title != title || got.About != about {
		t.Fatalf("the other app has %+v", got)
	}
	time.Sleep(400 * time.Millisecond) // several looks at the other app
	if t2, a2 := e.chatInfo(chatID); t2 != title || a2 != about {
		t.Fatalf("Chat lost what the owner set: %q / %q", t2, a2)
	}
}

func TestInfoTheOtherAppRefusesIsPutBackToWhatItHas(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Tên gốc", About: "Mô tả gốc"})
	e.waitInfo(chatID, "Tên gốc", "Mô tả gốc")
	e.fake.FailPin(fmt.Errorf("%w: CHAT_ADMIN_REQUIRED", bridge.ErrNotAllowed))
	title := "Không được phép"
	if _, err := e.chat.UpdateChatInfo(ctx, e.owner, &appv1.UpdateChatInfoRequest{ChatId: chatID, Title: &title}); err != nil {
		t.Fatal(err)
	}
	e.waitOutbox(chatID, 0, "set_info", "failed")
	e.waitInfo(chatID, "Tên gốc", "Mô tả gốc")
}

func TestInfoSwitchedOffNeitherComesInNorGoesOut(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	eng := e.start()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Info, feature.Off); err != nil {
		t.Fatal(err)
	}
	before, _ := e.chatInfo(chatID)
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Từ app kia", About: "x"})
	title := "Từ Chat"
	if _, err := e.chat.UpdateChatInfo(ctx, e.owner, &appv1.UpdateChatInfoRequest{ChatId: chatID, Title: &title}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	if got, _ := e.chatInfo(chatID); got != "Từ Chat" || before == "Từ app kia" {
		t.Fatalf("title = %q: the other app's title came in with info off", got)
	}
	for _, c := range e.fake.InfoCalls() {
		if strings.Contains(c, "Từ Chat") {
			t.Fatal("the title went out with info off")
		}
	}
}

func TestWhileATitleWaitsToGoOutTheOtherAppsOlderOneDoesNotOverwriteIt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Tên cũ ở app kia", About: ""})
	e.waitInfo(chatID, "Tên cũ ở app kia", "")
	e.fake.FailPin(&bridge.RateLimitError{RetryAfter: 600 * time.Millisecond})
	title := "Tên mới ở Chat"
	if _, err := e.chat.UpdateChatInfo(ctx, e.owner, &appv1.UpdateChatInfoRequest{ChatId: chatID, Title: &title}); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(400 * time.Millisecond); time.Now().Before(deadline); time.Sleep(15 * time.Millisecond) {
		if got, _ := e.chatInfo(chatID); got != title {
			t.Fatalf("the title was overwritten with %q while it waited to go out", got)
		}
	}
	e.eventually(func() bool { return e.fake.GroupInfo("g1").Title == title }, func() string { return "the title never went out" })
}

package botupdates_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botapi"
	"app.local/server/internal/bottest"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/chat"
)

func newBotAPI(t *testing.T, env *bottest.Env, u *botupdates.Service) *botapi.Service {
	t.Helper()
	api, err := botapi.New(botapi.Config{TenantID: bottest.TenantID, PublicOrigin: bottest.PublicOrigin, AppScheme: bottest.AppScheme},
		env.Chat, env.Admin, u, env.Limiter, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	return api
}

// countText counts the bot's messages with text in chatID.
func countText(t *testing.T, env *bottest.Env, chatID, botID int64, text string) int {
	t.Helper()
	var n int
	if err := env.Store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM messages WHERE chat_id = $1 AND from_id = $2 AND text = $3`, chatID, botID, text).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestReplyActionIsSentOnceAcrossACrash(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "replybot")
	env.CatchUp()
	env.Updates.SetReply(newBotAPI(t, env, env.Updates).WebhookReply)
	// The first delivery "crashes" after the action ran, before the ack: it
	// hangs there until the process is stopping, then is abandoned.
	var crashed atomic.Bool
	release := make(chan struct{})
	botupdates.SetBeforeAck(env.Updates, func(int64, int64) bool {
		if !crashed.CompareAndSwap(false, true) {
			return false
		}
		<-release
		return true
	})
	rcv := newReceiver(t, func(w http.ResponseWriter, d delivery) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"method": "sendMessage", "chat_id": %d, "text": "pong", "reply_to_seq": 0}`, d.ChatID)
	})
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{DropPending: true})
	send(t, env, user, group, "ping")
	first := rcv.wait(5 * time.Second)
	eventually(t, "the reply", func() bool { return countText(t, env, group, botID, "pong") == 1 })
	// The process stops with the update unacknowledged; a new one sends it
	// again and the bot answers again with the same action.
	stopped := make(chan struct{})
	go func() {
		env.StopUpdates()
		close(stopped)
	}()
	time.Sleep(200 * time.Millisecond)
	close(release)
	<-stopped
	if n := info(t, env, botID).Pending; n != 1 {
		t.Fatalf("pending after the crash = %d", n)
	}
	restarted := bottest.NewUpdates(t, env.Store, env.Chat)
	bottest.EnableWebhooks(t, restarted)
	restarted.SetReply(newBotAPI(t, env, restarted).WebhookReply)
	t.Cleanup(bottest.RunUpdates(restarted))
	again := rcv.wait(5 * time.Second)
	if again.ID != first.ID {
		t.Fatalf("redelivered %d, want %d", again.ID, first.ID)
	}
	eventually(t, "the update acknowledged", func() bool {
		i, err := restarted.WebhookInfo(ctx, botID)
		return err == nil && i.Pending == 0
	})
	if n := countText(t, env, group, botID, "pong"); n != 1 {
		t.Fatalf("the reply was sent %d times", n)
	}
	// Each update has its own random_id: the next ping gets its own pong.
	send(t, env, user, group, "ping 2")
	eventually(t, "the second reply", func() bool { return countText(t, env, group, botID, "pong") == 2 })
}

func TestReplyAnswersCallback(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("cb_owner")
	botID, _ := env.Bot(owner, "cbreplybot")
	env.Updates.SetReply(newBotAPI(t, env, env.Updates).WebhookReply)
	rcv := newReceiver(t, func(w http.ResponseWriter, d delivery) {
		if d.Kind != "callback" {
			return
		}
		var cb struct {
			Callback struct {
				ID string `json:"id"`
			} `json:"callback"`
		}
		if err := json.Unmarshal(d.Body, &cb); err != nil {
			t.Error(err)
		}
		_, _ = fmt.Fprintf(w, `{"method": "answerCallback", "callback_id": %q, "text": "done"}`, cb.Callback.ID)
	})
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{})
	// The owner starts the bot; the bot posts a button through the API path.
	if _, err := env.Chat.StartBot(ctx, owner, &appv1.StartBotRequest{BotId: botID, RandomId: 77}); err != nil {
		t.Fatal(err)
	}
	chatID := rcv.wait(5 * time.Second).ChatID
	data := "go"
	sent, err := env.Chat.SendBotMessage(ctx, botID, botMessageWithButton(chatID, data))
	if err != nil {
		t.Fatal(err)
	}
	press, err := env.Chat.PressInlineButton(ctx, owner, &appv1.PressInlineButtonRequest{
		ChatId: chatID, Seq: sent.GetMessage().GetSeq(), CallbackData: []byte(data),
	})
	if err != nil {
		t.Fatal(err)
	}
	a, answered, err := env.Updates.AwaitAnswer(ctx, press.CallbackID, 5*time.Second)
	if err != nil || !answered || a.Text != "done" {
		t.Fatalf("answer = %+v %v %v", a, answered, err)
	}
}

func botMessageWithButton(chatID int64, data string) chat.BotMessage {
	return chat.BotMessage{ChatID: chatID, Text: "press", Markup: &appv1.ReplyMarkup{Kind: &appv1.ReplyMarkup_InlineKeyboard{
		InlineKeyboard: &appv1.InlineKeyboard{Rows: []*appv1.InlineKeyboardRow{{Buttons: []*appv1.InlineButton{{
			Text: "Go", Action: &appv1.InlineButton_CallbackData{CallbackData: []byte(data)},
		}}}}},
	}}}
}

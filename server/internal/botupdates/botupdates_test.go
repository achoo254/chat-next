package botupdates_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bottest"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/store/testdb"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

// talkativeBot is a bot without privacy mode in a group of a new user.
func talkativeBot(t *testing.T, env *bottest.Env, name string) (botID, user, group int64) {
	t.Helper()
	user = env.User("owner_" + name)
	botID, _ = env.Bot(user, name)
	off := false
	if _, err := env.Admin.UpdateBot(context.Background(), user, &appv1.UpdateBotRequest{BotId: botID, Privacy: &off}); err != nil {
		t.Fatal(err)
	}
	return botID, user, env.Group(user, botID)
}

func send(t *testing.T, env *bottest.Env, user, chatID int64, text string) {
	t.Helper()
	if _, err := env.Chat.SendMessage(context.Background(), user, &appv1.SendMessageRequest{ChatId: chatID, Text: text}); err != nil {
		t.Error(err)
	}
}

// stored returns the bot's update ids in order and next_update_id.
func stored(t *testing.T, env *bottest.Env, botID int64) ([]int64, int64) {
	t.Helper()
	ctx := context.Background()
	rows, err := env.Store.Pool().Query(ctx, `SELECT update_id FROM bot_updates WHERE bot_id = $1 ORDER BY update_id`, botID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	var next int64
	if err := env.Store.Pool().QueryRow(ctx, `SELECT next_update_id FROM bots WHERE user_id = $1`, botID).Scan(&next); err != nil {
		t.Fatal(err)
	}
	return ids, next
}

func cursor(t *testing.T, env *bottest.Env) int64 {
	t.Helper()
	var last int64
	if err := env.Store.Pool().QueryRow(context.Background(), `SELECT last_id FROM outbox_cursors WHERE consumer = 'bots'`).Scan(&last); err != nil {
		t.Fatal(err)
	}
	return last
}

func TestReplayIsIdempotent(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	start := cursor(t, env)
	botID, user, group := talkativeBot(t, env, "replaybot")
	for i := range 5 {
		send(t, env, user, group, fmt.Sprintf("m%d", i))
	}
	env.CatchUp()
	before, next := stored(t, env, botID)
	if len(before) != 7 { // the group's creation (member_changed and the message) and five messages
		t.Fatalf("stored %v", before)
	}
	// Another process replays the whole range from an old cursor.
	if _, err := env.Store.Pool().Exec(ctx, `UPDATE outbox_cursors SET last_id = $1 WHERE consumer = 'bots'`, start); err != nil {
		t.Fatal(err)
	}
	other := bottest.NewUpdates(t, env.Store, env.Chat)
	if err := other.CatchUp(ctx); err != nil {
		t.Fatal(err)
	}
	after, nextAfter := stored(t, env, botID)
	if fmt.Sprint(after) != fmt.Sprint(before) || nextAfter != next {
		t.Fatalf("replay changed updates: %v (next %d) -> %v (next %d)", before, next, after, nextAfter)
	}
}

func TestConcurrentConsumersKeepOneWriterPerBot(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, _, _ := talkativeBot(t, env, "sharedbot")
	other := bottest.NewUpdates(t, env.Store, env.Chat)
	const senders, each = 4, 15
	var wg sync.WaitGroup
	stop := make(chan struct{})
	consumersDone := make(chan struct{})
	go func() {
		defer close(consumersDone)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := other.CatchUp(ctx); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	for i := range senders {
		u := env.User(fmt.Sprintf("s%d", i))
		chatID := env.Group(u, botID)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range each {
				send(t, env, u, chatID, fmt.Sprintf("m%d", j))
			}
		}()
	}
	wg.Wait()
	close(stop)
	<-consumersDone
	env.CatchUp()
	ids, next := stored(t, env, botID)
	// Group creations (5, each a member_changed and a message) plus every
	// message, each exactly once.
	want := 2*(1+senders) + senders*each
	if len(ids) != want {
		t.Fatalf("stored %d updates, want %d", len(ids), want)
	}
	for i, id := range ids {
		if id != int64(i+1) {
			t.Fatalf("update ids are not 1..%d: %v", want, ids)
		}
	}
	if next != int64(want+1) {
		t.Fatalf("next_update_id = %d, want %d", next, want+1)
	}
}

func TestCursorWaitsForOpenTransactions(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "gapbot")
	env.CatchUp()
	// An outbox id issued to a transaction that has not committed yet.
	tx, err := env.Store.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var held int64
	if err := tx.QueryRow(ctx, `INSERT INTO outbox (kind, tenant_id, chat_id) VALUES ('chat_updated', $1, $2) RETURNING id`,
		bottest.TenantID, group).Scan(&held); err != nil {
		t.Fatal(err)
	}
	send(t, env, user, group, "after the gap")
	env.CatchUp()
	if ids, _ := stored(t, env, botID); len(ids) != 3 {
		t.Fatalf("message after the gap not delivered: %v", ids)
	}
	if c := cursor(t, env); c >= held {
		t.Fatalf("cursor %d passed the open id %d", c, held)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	env.CatchUp()
	if c := cursor(t, env); c <= held {
		t.Fatalf("cursor %d stuck below the committed id %d", c, held)
	}
	if ids, _ := stored(t, env, botID); len(ids) != 3 {
		t.Fatalf("updates after the gap closed: %v", ids)
	}
}

func TestAcknowledgedUpdatesAreNotRedelivered(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	start := cursor(t, env)
	botID, user, group := talkativeBot(t, env, "ackbot")
	for i := range 3 {
		send(t, env, user, group, fmt.Sprintf("m%d", i))
	}
	env.CatchUp()
	list, err := env.Updates.Poll(ctx, botID, 0, 100, 0)
	if err != nil || len(list) != 5 { // the group's creation (two updates) and three messages
		t.Fatalf("poll = %d updates, %v", len(list), err)
	}
	offset := list[len(list)-1].ID + 1
	if list, err := env.Updates.Poll(ctx, botID, offset, 100, 0); err != nil || len(list) != 0 {
		t.Fatalf("poll after ack = %v, %v", list, err)
	}
	before, next := stored(t, env, botID)
	// A restarted process replays the acknowledged range from an old cursor.
	if _, err := env.Store.Pool().Exec(ctx, `UPDATE outbox_cursors SET last_id = $1 WHERE consumer = 'bots'`, start); err != nil {
		t.Fatal(err)
	}
	restarted := bottest.NewUpdates(t, env.Store, env.Chat)
	if err := restarted.CatchUp(ctx); err != nil {
		t.Fatal(err)
	}
	after, nextAfter := stored(t, env, botID)
	if fmt.Sprint(after) != fmt.Sprint(before) || nextAfter != next {
		t.Fatalf("replay after ack changed updates: %v (next %d) -> %v (next %d)", before, next, after, nextAfter)
	}
	if list, err := restarted.Poll(ctx, botID, offset, 100, 0); err != nil || len(list) != 0 {
		t.Fatalf("acknowledged updates delivered again: %v, %v", list, err)
	}
	// Even a bot that rewinds its offset does not get them again.
	if list, err := restarted.Poll(ctx, botID, 0, 100, 0); err != nil || len(list) != 0 {
		t.Fatalf("rewound poll = %v, %v", list, err)
	}
}

func TestPoisonRowDoesNotStallOtherBots(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "poisonbot")
	env.CatchUp()
	// An outbox row whose log entry for the bot cannot be decoded.
	const pts = 1 << 40
	if _, err := env.Store.Pool().Exec(ctx, `INSERT INTO user_updates (user_id, pts, chat_id, "update") VALUES ($1, $2, $3, '\xffffff')`,
		botID, pts, group); err != nil {
		t.Fatal(err)
	}
	var poison int64
	if err := env.Store.Pool().QueryRow(ctx, `
		INSERT INTO outbox (kind, tenant_id, chat_id, actor_id, user_ids, pts) VALUES ('message_new', $1, $2, $3, $4, $5) RETURNING id`,
		bottest.TenantID, group, user, []int64{botID}, []int64{pts}).Scan(&poison); err != nil {
		t.Fatal(err)
	}
	rows, err := env.Chat.ReadOutboxIDs(ctx, []int64{poison})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.Chat.BotUpdates(ctx, rows); err == nil {
		t.Fatal("the poison row is readable")
	}
	send(t, env, user, group, "after the poison row")
	consumer := bottest.NewUpdates(t, env.Store, env.Chat)
	for range 3 { // the poison row is retried, then skipped
		if err = consumer.CatchUp(ctx); err == nil {
			break
		}
	}
	if err != nil {
		t.Fatalf("consumer still stuck: %v", err)
	}
	if c := cursor(t, env); c <= poison {
		t.Fatalf("cursor %d did not pass the poison row %d", c, poison)
	}
	list, err := env.Updates.Poll(ctx, botID, 0, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(list); n != 3 || !strings.Contains(string(list[n-1].Payload), "after the poison row") {
		t.Fatalf("updates = %d, last %s", n, list[n-1].Payload)
	}
}

func TestPollAfterShutdownIsRefused(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, _, _ := talkativeBot(t, env, "closingbot")
	waiting := make(chan error, 1)
	go func() {
		_, err := env.Updates.Poll(ctx, botID, 0, 100, 30*time.Second)
		waiting <- err
	}()
	time.Sleep(100 * time.Millisecond)
	env.Updates.ReleasePolls()
	select {
	case err := <-waiting:
		if err != nil {
			t.Fatalf("waiting poll ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiting poll not released")
	}
	if _, err := env.Updates.Poll(ctx, botID, 0, 100, 30*time.Second); !errors.Is(err, botupdates.ErrUnavailable) {
		t.Fatalf("poll after shutdown = %v", err)
	}
}

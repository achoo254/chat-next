package botupdates_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bottest"
	"app.local/server/internal/botupdates"
)

// A worker with nothing to deliver does not read the database on a timer:
// it wakes for new updates.
func TestIdleWorkerDoesNotPollTheDatabase(t *testing.T) {
	env := bottest.New(t)
	botID, user, group := talkativeBot(t, env, "idlebot")
	env.CatchUp()
	rcv := newReceiver(t, nil)
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{DropPending: true})
	send(t, env, user, group, "first")
	if d := rcv.wait(5 * time.Second); d.Text != "first" {
		t.Fatalf("delivered %q", d.Text)
	}
	eventually(t, "the update acknowledged", func() bool { return info(t, env, botID).Pending == 0 })
	time.Sleep(300 * time.Millisecond)
	before := botupdates.WorkerReads(env.Updates)
	// The previous dispatcher read every 2 seconds while idle.
	time.Sleep(2500 * time.Millisecond)
	if after := botupdates.WorkerReads(env.Updates); after != before {
		t.Fatalf("the idle worker read the database %d times", after-before)
	}
	send(t, env, user, group, "second")
	if d := rcv.wait(5 * time.Second); d.Text != "second" {
		t.Fatalf("delivered %q", d.Text)
	}
}

// A webhook answer's body is read for an action only up to 64 KiB: a
// larger 2xx answer still acknowledges the update, its action is ignored.
func TestOversizedAnswerIsDeliveredWithoutItsAction(t *testing.T) {
	env := bottest.New(t)
	botID, user, group := talkativeBot(t, env, "bigreplybot")
	env.CatchUp()
	env.Updates.SetReply(newBotAPI(t, env, env.Updates).WebhookReply)
	pad := strings.Repeat("x", 64<<10)
	rcv := newReceiver(t, func(w http.ResponseWriter, d delivery) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"method": "sendMessage", "chat_id": %d, "text": "too big", "pad": %q}`, d.ChatID, pad)
	})
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{DropPending: true})
	send(t, env, user, group, "hello")
	rcv.wait(5 * time.Second)
	eventually(t, "the update acknowledged", func() bool { return info(t, env, botID).Pending == 0 })
	time.Sleep(200 * time.Millisecond)
	if n := countText(t, env, group, botID, "too big"); n != 0 {
		t.Fatalf("the oversized answer's action ran (%d messages)", n)
	}
}

// The queue heads are read through bot_updates_pending_idx one queue at a
// time, so a long backlog in a few chats is not scanned on every round.
func TestHeadsQueryUsesThePendingIndex(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, _, _ := talkativeBot(t, env, "backlogbot")
	env.CatchUp()
	pool := env.Store.Pool()
	if _, err := pool.Exec(ctx, `UPDATE bot_updates SET acked = true WHERE bot_id = $1`, botID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO bot_updates (bot_id, update_id, outbox_id, kind, seq, chat_id, queue_key, payload, expires_at)
		SELECT $1, 1000000 + g, 1000000 + g, 'message', g, 70 + g % 3, 70 + g % 3, '{}', now() + interval '1 day'
		FROM generate_series(1, 30000) g`, botID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE bot_updates`); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := pool.QueryRow(ctx, `EXPLAIN (ANALYZE, FORMAT JSON) `+botupdates.HeadsQuery, botID, 1000).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var plan []struct {
		Plan planNode `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &plan); err != nil || len(plan) != 1 {
		t.Fatalf("plan: %v (%s)", err, raw)
	}
	var usesIndex bool
	var rowsRead float64
	plan[0].Plan.walk(func(n planNode) {
		if n.Relation != "bot_updates" {
			return
		}
		if n.Type == "Seq Scan" || n.Type == "Bitmap Heap Scan" {
			t.Errorf("%s on bot_updates", n.Type)
		}
		usesIndex = usesIndex || n.Index == "bot_updates_pending_idx"
		rowsRead += n.Rows * n.Loops
	})
	if !usesIndex {
		t.Errorf("the pending index is not used:\n%s", raw)
	}
	t.Logf("bot_updates rows read for 3 heads of 30000 pending: %v", rowsRead)
	// Three queues: a handful of probes, not the 30000 pending rows.
	if rowsRead > 50 {
		t.Errorf("read %v rows of bot_updates for 3 heads:\n%s", rowsRead, raw)
	}
	var heads int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM (`+botupdates.HeadsQuery+`) h`, botID, 1000).Scan(&heads); err != nil || heads != 3 {
		t.Fatalf("heads = %d, %v", heads, err)
	}
}

type planNode struct {
	Type     string     `json:"Node Type"`
	Relation string     `json:"Relation Name"`
	Index    string     `json:"Index Name"`
	Rows     float64    `json:"Actual Rows"`
	Loops    float64    `json:"Actual Loops"`
	Plans    []planNode `json:"Plans"`
}

func (n planNode) walk(fn func(planNode)) {
	fn(n)
	for _, c := range n.Plans {
		c.walk(fn)
	}
}

// The 24-hour numbers come from the stored updates too, so updates from
// before the hourly counters existed (or whose counters are lost) count.
func TestStatsCountStoredUpdatesWithoutCounters(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	botID, user, group := talkativeBot(t, env, "statsbot")
	env.CatchUp()
	first, err := env.Updates.Poll(ctx, botID, 0, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 3 {
		send(t, env, user, group, fmt.Sprintf("m%d", i))
	}
	env.CatchUp()
	list, err := env.Updates.Poll(ctx, botID, 0, 100, 0)
	if err != nil || len(list) != len(first)+3 {
		t.Fatalf("poll = %d, %v", len(list), err)
	}
	// Acknowledge all but the newest.
	if _, err := env.Updates.Poll(ctx, botID, list[len(list)-1].ID, 100, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Store.Pool().Exec(ctx, `DELETE FROM bot_delivery_counters WHERE bot_id = $1`, botID); err != nil {
		t.Fatal(err)
	}
	st, err := env.Updates.Stats(ctx, botID)
	if err != nil {
		t.Fatal(err)
	}
	if st.Received != int64(len(list)) || st.Delivered != int64(len(list)-1) || st.Failed != 0 || st.DeadLettered != 0 {
		t.Fatalf("stats without counters = %+v, want %d received, %d delivered", st, len(list), len(list)-1)
	}
	// Counters larger than what is stored (callbacks are kept 15 minutes) win.
	if _, err := env.Store.Pool().Exec(ctx, `
		INSERT INTO bot_delivery_counters (bot_id, hour, received, delivered, failed, dead_lettered)
		VALUES ($1, date_trunc('hour', now()), 50, 40, 7, 2)`, botID); err != nil {
		t.Fatal(err)
	}
	if st, _ := env.Updates.Stats(ctx, botID); st != (botupdates.Stats{Received: 50, Delivered: 40, Failed: 7, DeadLettered: 2}) {
		t.Fatalf("stats with counters = %+v", st)
	}
}

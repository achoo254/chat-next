package api_test

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/watch"
	"connectrpc.com/connect"
)

// The watchdog posts a problem seen in two checks in a row into the
// operators' "Vận hành chat" group it creates, then turns the same message
// to resolved when the problem is gone, also after a restart.
func TestWatchdogAlertsOperators(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	op := e.member(t, "watchop")
	var problems []watch.Problem
	check := func(context.Context) ([]watch.Problem, error) { return problems, nil }
	newWatcher := func() *watch.Watcher {
		return watch.New(watch.Config{
			TenantID: tenantID, Operators: []int64{op.userID}, Pool: e.store.Pool(), Chats: e.app.Chat, Hooks: e.app.Hooks,
			Checks: []watch.Check{check}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
	}
	w := newWatcher()
	problems = []watch.Problem{{Key: "memory_low", Name: "MemoryLow", Severity: "warning", Summary: "Máy còn 20% RAM khả dụng"}}
	if err := w.Once(ctx); err != nil {
		t.Fatal(err)
	}
	dialogs := func() []*appv1.Chat {
		t.Helper()
		resp, err := op.chats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{Limit: 50}))
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg.GetChats()
	}
	opsGroup := func() *appv1.Chat {
		for _, c := range dialogs() {
			if c.GetTitle() == "Vận hành chat" {
				return c
			}
		}
		return nil
	}
	if opsGroup() != nil {
		t.Fatal("one check is not enough to alert")
	}
	if err := w.Once(ctx); err != nil {
		t.Fatal(err)
	}
	group := opsGroup()
	if group == nil {
		t.Fatalf("no operators' group: %v", dialogs())
	}
	history := func() []*appv1.Message {
		t.Helper()
		h, err := op.messages.GetHistory(ctx, connect.NewRequest(&appv1.GetHistoryRequest{ChatId: group.GetId(), Limit: 20}))
		if err != nil {
			t.Fatal(err)
		}
		var out []*appv1.Message
		for _, m := range h.Msg.GetMessages() {
			if m.GetIntegrationLabel() != "" {
				out = append(out, m)
			}
		}
		return out
	}
	alerts := history()
	if len(alerts) != 1 || !strings.Contains(alerts[0].GetText(), "Máy còn 20% RAM khả dụng") {
		t.Fatalf("firing alert: %v", alerts)
	}
	// A restart forgets nothing; the problem is gone: the same message resolves.
	w = newWatcher()
	problems = nil
	if err := w.Once(ctx); err != nil {
		t.Fatal(err)
	}
	alerts = history()
	if len(alerts) != 1 || !strings.HasPrefix(alerts[0].GetText(), "Resolved MemoryLow") {
		t.Fatalf("resolved alert: %v", alerts)
	}
	t.Logf("resolved text: %q", alerts[0].GetText())
}

// Tenants share the outbox: rows of another tenant past a consumer's
// cursor wait for nobody, and only the consumers named are checked.
func TestWatchdogOutboxCountsOwnTenant(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	pool := e.store.Pool()
	const other = "watch-other"
	if _, err := pool.Exec(ctx, `
		INSERT INTO outbox_cursors (consumer, last_id) SELECT c, coalesce((SELECT max(id) FROM outbox), 0)
		FROM unnest(ARRAY['watch-own', 'watch-own:'||$1]) AS c`, other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO outbox (kind, tenant_id, created_at) VALUES ('read', $1, now() - interval '10 minutes')`, other); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM outbox WHERE tenant_id = $1`, other)
		_, _ = pool.Exec(context.Background(), `DELETE FROM outbox_cursors WHERE consumer LIKE 'watch-own%'`)
	})
	found, err := watch.Outbox(pool, tenantID, []string{"watch-own"}, time.Now)(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 0 {
		t.Fatalf("another tenant's row alerted: %+v", found)
	}
	found, err = watch.Outbox(pool, other, []string{"watch-own:" + other}, time.Now)(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].Key != "outbox_backlog:watch-own:"+other {
		t.Fatalf("own tenant's waiting row: %+v", found)
	}
}

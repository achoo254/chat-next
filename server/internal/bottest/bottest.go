// Package bottest builds the bot platform on a throwaway database for the
// tests of the bot packages: the chat core, bot management, the update
// consumer and the Bot API handler, wired as in the api role. Use it from
// tests whose TestMain runs testdb.Main.
package bottest

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"app.local/server/internal/botadmin"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/chat"
	"app.local/server/internal/ids"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
)

// Tenant settings of the environment.
const (
	TenantID     = "primary"
	PublicOrigin = "https://chat.example.test"
	Host         = "chat.example.test"
	AppScheme    = "com.example.chat"
)

// Quiet discards logs.
var Quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// Env is a wired bot platform.
type Env struct {
	T       testing.TB
	Store   *store.Store
	Chat    *chat.Service
	Admin   *botadmin.Service
	Updates *botupdates.Service
	Limiter *ratelimit.Memory
	n       int
}

// New builds the environment; the consumer loop runs until the test ends.
// The chat core's per-user limits are real; tests stay well below them.
func New(t testing.TB) *Env {
	t.Helper()
	st := testdb.Open(t)
	ctx := context.Background()
	if err := st.EnsureTenant(ctx, TenantID, "example.test", "example.test"); err != nil {
		t.Fatal(err)
	}
	gen, err := ids.NewSnowflake(7)
	if err != nil {
		t.Fatal(err)
	}
	limiter := ratelimit.NewMemory()
	previews := linkpreview.NewService(st.Pool(), linkpreview.NewFetcher(linkpreview.Options{}), Quiet)
	chatSvc, err := chat.New(chat.Config{TenantID: TenantID, PublicOrigin: PublicOrigin, AppScheme: AppScheme},
		chat.Deps{Pool: st.Pool(), IDs: gen, Previews: previews, Limiter: limiter, Logger: Quiet})
	if err != nil {
		t.Fatal(err)
	}
	if err := chatSvc.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(chatSvc.Stop)
	admin, err := botadmin.New(st.Pool(), TenantID, limiter, Quiet)
	if err != nil {
		t.Fatal(err)
	}
	updates := NewUpdates(t, st, chatSvc)
	chatSvc.SetCommitObserver(updates.Kick)
	loopCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		updates.Run(loopCtx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return &Env{T: t, Store: st, Chat: chatSvc, Admin: admin, Updates: updates, Limiter: limiter}
}

// NewUpdates returns another consumer on the same database, as a second
// api process would run.
func NewUpdates(t testing.TB, st *store.Store, chatSvc *chat.Service) *botupdates.Service {
	t.Helper()
	updates, err := botupdates.New(st.Pool(), chatSvc, AppScheme, Quiet)
	if err != nil {
		t.Fatal(err)
	}
	return updates
}

// User creates an account that anyone may add to groups.
func (e *Env) User(name string) int64 {
	e.T.Helper()
	e.n++
	ctx := context.Background()
	u, err := e.Store.UpsertIdPUser(ctx, TenantID, store.IdPProfile{
		Sub: fmt.Sprintf("acc_%s_%d", name, e.n), PreferredUsername: name, Name: name,
	})
	if err != nil {
		e.T.Fatal(err)
	}
	if _, err := e.Store.Pool().Exec(ctx, `INSERT INTO privacy_settings (user_id, add_to_groups) VALUES ($1, 1)`, u.ID); err != nil {
		e.T.Fatal(err)
	}
	return u.ID
}

// Bot creates a bot of owner and returns its id and a fresh token.
func (e *Env) Bot(owner int64, username string) (int64, string) {
	e.T.Helper()
	ctx := context.Background()
	bot, err := e.Admin.CreateBot(ctx, owner, username, "Bot "+username)
	if err != nil {
		e.T.Fatal(err)
	}
	_, token, err := e.Admin.ResetBotToken(ctx, owner, time.Now(), bot.GetUser().GetId())
	if err != nil {
		e.T.Fatal(err)
	}
	return bot.GetUser().GetId(), token
}

// Group creates a group of owner with members.
func (e *Env) Group(owner int64, members ...int64) int64 {
	e.T.Helper()
	resp, err := e.Chat.CreateGroup(context.Background(), owner, "group", members, false)
	if err != nil {
		e.T.Fatal(err)
	}
	if len(resp.GetFailedUserIds()) > 0 {
		e.T.Fatalf("CreateGroup failed for %v", resp.GetFailedUserIds())
	}
	return resp.GetChat().GetId()
}

// CatchUp runs the consumer until it reached the outbox head.
func (e *Env) CatchUp() {
	e.T.Helper()
	if err := e.Updates.CatchUp(context.Background()); err != nil {
		e.T.Fatal(err)
	}
}

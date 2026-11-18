// Package telegram is the Chat Bridge adapter for Telegram, on MTProto with
// the account of the user (not a bot): the official way to read a user's own
// conversations (ADR 0022). It also sends what the owner writes in Chat
// (send.go), only for chats the engine has linked in both directions.
//
// The adapter keeps one connection per account, shared by history reads,
// conversation listing and the live subscription, so Telegram sees one
// client.
package telegram

import (
	"context"
	"sync"
	"time"

	"app.local/server/internal/bridge"
)

// Name is the adapter's id in external accounts.
const Name = "telegram"

// connIdle is how long a connection nobody uses stays open, so a run of
// short calls (history pages) does not reconnect every time.
const connIdle = 20 * time.Second

// Config is what the app registered at my.telegram.org.
type Config struct {
	APIID   int
	APIHash string
}

// Adapter implements bridge.Adapter for Telegram.
type Adapter struct {
	cfg Config

	mu     sync.Mutex
	conns  map[string]*conn
	logins map[string]*login
}

var _ bridge.Adapter = (*Adapter)(nil)

// New returns the adapter; Close drops its connections.
func New(cfg Config) *Adapter {
	return &Adapter{cfg: cfg, conns: map[string]*conn{}, logins: map[string]*login{}}
}

// Name implements bridge.Adapter.
func (a *Adapter) Name() string { return Name }

// Capabilities implements bridge.Adapter: history, live updates, edits,
// deletes, media, sending and forum topics are all available.
func (a *Adapter) Capabilities() bridge.Capabilities {
	return bridge.Capabilities{bridge.CapHistory: true, bridge.CapLive: true, bridge.CapEdits: true, bridge.CapDeletes: true, bridge.CapMedia: true, bridge.CapSend: true, bridge.CapTopics: true, bridge.CapPins: true}
}

// Close drops every connection and open login.
func (a *Adapter) Close() {
	a.mu.Lock()
	conns := make([]*conn, 0, len(a.conns))
	for _, c := range a.conns {
		conns = append(conns, c)
	}
	logins := make([]*login, 0, len(a.logins))
	for _, l := range a.logins {
		logins = append(logins, l)
	}
	a.mu.Unlock()
	for _, c := range conns {
		c.live.stop()
	}
	for _, l := range logins {
		l.close()
	}
}

// Logout implements bridge.Adapter: it ends the session at Telegram, so it
// disappears from the user's list of devices.
func (a *Adapter) Logout(ctx context.Context, acct bridge.Account) error {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return err
	}
	defer release()
	_, err = c.live.client.API().AuthLogOut(ctx)
	return translate(err)
}

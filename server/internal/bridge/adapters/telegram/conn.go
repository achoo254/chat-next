package telegram

import (
	"context"
	"sync"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

// conn is the shared connection of one account.
type conn struct {
	a    *Adapter
	key  string
	live *live

	mu    sync.Mutex
	refs  int
	timer *time.Timer
	mgr   telegram.UpdateHandler
	// peers caches the addressable peer of each conversation, learned from
	// the dialog list (Telegram needs an access hash for users and channels).
	peers map[string]tg.InputPeerClass
	convs []bridge.Conversation
	book  *peerBook
}

// handle gives live updates to the subscription, if there is one.
func (c *conn) handle(ctx context.Context, u tg.UpdatesClass) error {
	c.mu.Lock()
	m := c.mgr
	c.mu.Unlock()
	if m == nil {
		return nil
	}
	return m.Handle(ctx, u)
}

func (c *conn) setManager(m telegram.UpdateHandler) {
	c.mu.Lock()
	c.mgr = m
	c.mu.Unlock()
}

// acquire returns the account's connection, opening it when there is none,
// and a release to call when done with it.
func (a *Adapter) acquire(ctx context.Context, acct bridge.Account) (*conn, func(), error) {
	a.mu.Lock()
	c := a.conns[acct.ID]
	if c != nil && c.live.failure() != nil {
		delete(a.conns, acct.ID)
		c = nil
	}
	if c == nil {
		c = &conn{a: a, key: acct.ID, peers: map[string]tg.InputPeerClass{}, book: newPeerBook()}
		c.live = a.startLive(acct.Session, telegram.UpdateHandlerFunc(c.handle), true)
		a.conns[acct.ID] = c
	}
	c.mu.Lock()
	c.refs++
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.mu.Unlock()
	a.mu.Unlock()
	if err := c.live.wait(ctx); err != nil {
		c.release()
		return nil, nil, err
	}
	return c, c.release, nil
}

// release ends one use; an unused connection closes after connIdle.
func (c *conn) release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refs--
	if c.refs > 0 {
		return
	}
	c.timer = time.AfterFunc(connIdle, func() {
		c.a.mu.Lock()
		c.mu.Lock()
		idle := c.refs == 0
		if idle && c.a.conns[c.key] == c {
			delete(c.a.conns, c.key)
		}
		c.mu.Unlock()
		c.a.mu.Unlock()
		if idle {
			c.live.stop()
		}
	})
}

package telegram

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

// live is a running MTProto client: connected, and (when it has a stored
// login) authorised. It runs in its own goroutine until stop is called or
// the connection fails.
type live struct {
	client  *telegram.Client
	storage *session.StorageMemory
	self    int64

	cancel context.CancelFunc
	ready  chan struct{}
	done   chan struct{}

	mu  sync.Mutex
	err error
}

// startLive connects a client. With requireAuth it checks the stored login
// still works and learns the account's id; a login that does not work is
// bridge.ErrSessionRevoked. sess is the stored session ("" for a new login).
func (a *Adapter) startLive(sess []byte, handler telegram.UpdateHandler, requireAuth bool) *live {
	l := &live{storage: &session.StorageMemory{}, ready: make(chan struct{}), done: make(chan struct{})}
	if len(sess) > 0 {
		_ = l.storage.StoreSession(context.Background(), sess)
	}
	opts := telegram.Options{SessionStorage: l.storage}
	if requireAuth {
		// Only a signed-in account's calls are repeated: a login step sent twice could send a
		// second code or leave a session behind that nobody holds.
		opts.Middlewares = []telegram.Middleware{retryInternal()}
	}
	if handler != nil {
		opts.UpdateHandler = handler
	}
	l.client = telegram.NewClient(a.cfg.APIID, a.cfg.APIHash, opts)
	runCtx, cancel := context.WithCancel(context.Background())
	l.cancel = cancel
	go func() {
		defer close(l.done)
		var readyOnce sync.Once
		signal := func() { readyOnce.Do(func() { close(l.ready) }) }
		err := l.client.Run(runCtx, func(ctx context.Context) error {
			if requireAuth {
				status, err := l.client.Auth().Status(ctx)
				if err != nil {
					return err
				}
				if !status.Authorized {
					return fmt.Errorf("%w: not authorised", bridge.ErrSessionRevoked)
				}
				l.self = status.User.ID
			}
			signal()
			<-ctx.Done()
			return nil
		})
		l.mu.Lock()
		if err != nil && !errors.Is(err, context.Canceled) {
			l.err = translate(err)
		}
		l.mu.Unlock()
		signal()
	}()
	return l
}

// wait blocks until the client is connected (and authorised) or has failed.
func (l *live) wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-l.ready:
	}
	select {
	case <-l.done:
		l.mu.Lock()
		defer l.mu.Unlock()
		if l.err != nil {
			return l.err
		}
		return errors.New("telegram: connection closed")
	default:
		return nil
	}
}

// failure is why the client stopped, nil while it runs.
func (l *live) failure() error {
	select {
	case <-l.done:
		l.mu.Lock()
		defer l.mu.Unlock()
		if l.err != nil {
			return l.err
		}
		return errors.New("telegram: connection closed")
	default:
		return nil
	}
}

func (l *live) stop() {
	l.cancel()
	<-l.done
}

// api is the raw client.
func (l *live) api() *tg.Client { return l.client.API() }

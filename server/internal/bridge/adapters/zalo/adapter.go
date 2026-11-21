// Package zalo is the Chat Bridge adapter for a personal Zalo account. Zalo has
// no official API for that, so the adapter drives the vendored zca-js sidecar
// (sidecar/dist/zalo-sidecar.cjs) over its stdio protocol, one process per
// login and one per subscribed account.
//
// This step only receives: QR login, live 1-1 text and sticker messages, and
// conversations heard since the process started. Nothing is sent to Zalo
// (no CapSend), groups are ignored, and there is no history beyond what this
// process heard (see Backfill).
package zalo

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// Name is the adapter's id in external accounts; it never changes.
const Name = "zalo"

// Config wires the adapter.
type Config struct {
	// Runner starts sidecar processes (ExecRunner in production).
	Runner Runner
	// Logger receives operational lines only: never message text, names,
	// ids, cookies, the imei or the QR image.
	Logger *slog.Logger
}

// timing holds the waits of the adapter; tests shorten them.
type timing struct {
	stopGrace    time.Duration // stdin closed -> kill
	readyTimeout time.Duration // start -> ready line
	firstQR      time.Duration // login_qr -> first QR image
	loginPoll    time.Duration // longest wait of one Login call for news
	loginTTL     time.Duration // an abandoned login is stopped after this
}

var defaultTiming = timing{stopGrace: 3 * time.Second, readyTimeout: 30 * time.Second,
	firstQR: 60 * time.Second, loginPoll: 25 * time.Second, loginTTL: 10 * time.Minute}

// Adapter implements bridge.Adapter for Zalo.
type Adapter struct {
	runner Runner
	logger *slog.Logger
	timing timing

	mu         sync.Mutex
	logins     map[string]*qrLogin
	subs       map[string]*subscription // by Account.ID
	heard      map[string]*heardAccount // by Account.ID
	rejections map[string]int           // consecutive refused session logins, by Account.ID
}

var (
	_ bridge.Adapter  = (*Adapter)(nil)
	_ bridge.Featured = (*Adapter)(nil)
)

// New returns the adapter; Close stops its sidecars.
func New(cfg Config) *Adapter {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Adapter{runner: cfg.Runner, logger: logger, timing: defaultTiming,
		logins: map[string]*qrLogin{}, subs: map[string]*subscription{}, heard: map[string]*heardAccount{}, rejections: map[string]int{}}
}

// Name implements bridge.Adapter.
func (a *Adapter) Name() string { return Name }

// Capabilities implements bridge.Adapter: live messages only, read only.
func (a *Adapter) Capabilities() bridge.Capabilities {
	return bridge.Capabilities{bridge.CapLive: true}
}

// Features implements bridge.Featured: messages come in; nothing goes out.
func (a *Adapter) Features() map[feature.Feature]feature.Support {
	return map[feature.Feature]feature.Support{feature.Messages: {In: true}}
}

// Close stops every login and subscription sidecar.
func (a *Adapter) Close() {
	a.mu.Lock()
	logins := make([]*qrLogin, 0, len(a.logins))
	for id, l := range a.logins {
		logins = append(logins, l)
		delete(a.logins, id)
	}
	subs := make([]*subscription, 0, len(a.subs))
	for _, s := range a.subs {
		subs = append(subs, s)
	}
	a.mu.Unlock()
	for _, l := range logins {
		l.mu.Lock()
		l.close()
		l.mu.Unlock()
	}
	for _, s := range subs {
		s.side.stop()
	}
}

// Logout implements bridge.Adapter. It stops the account's sidecar and forgets
// what it heard. The sidecar has no logout command yet, so the session is not
// ended at Zalo: the device stays in the phone's list until removed there.
func (a *Adapter) Logout(_ context.Context, acct bridge.Account) error {
	a.mu.Lock()
	s := a.subs[acct.ID]
	delete(a.heard, acct.ID)
	delete(a.rejections, acct.ID)
	a.mu.Unlock()
	if s != nil {
		s.loggedOut.Store(true)
		s.side.stop()
	}
	return nil
}

// ListConversations implements bridge.Adapter. The sidecar has no list of
// recent conversations, so this is the 1-1 conversations heard since this
// process started, the most recently active first. Conversations Chat already
// copied stay linked in the engine whether listed or not.
func (a *Adapter) ListConversations(_ context.Context, acct bridge.Account) ([]bridge.Conversation, error) {
	return a.heardFor(acct.ID).conversations(), nil
}

// Backfill implements bridge.Adapter. Zalo history is not reachable through
// the sidecar yet; what a new conversation gets is the messages this process
// heard in it (its first message among them), newest first, in one page.
func (a *Adapter) Backfill(_ context.Context, acct bridge.Account, conv string, cur bridge.Cursor, limit int) (bridge.Page, error) {
	if cur.Before != "" {
		return bridge.Page{Done: true}, nil
	}
	return bridge.Page{Messages: a.heardFor(acct.ID).recent(conv, limit), Done: true}, nil
}

// FetchMedia implements bridge.Adapter. No message carries media yet (stickers
// and files come in as a text label), so any ref is refused for good.
func (a *Adapter) FetchMedia(context.Context, bridge.Account, string) (bridge.MediaStream, error) {
	return nil, fmt.Errorf("%w: zalo media download is not supported yet", bridge.ErrNotAllowed)
}

// heardFor returns the account's heard conversations, creating them.
func (a *Adapter) heardFor(account string) *heardAccount {
	a.mu.Lock()
	defer a.mu.Unlock()
	h := a.heard[account]
	if h == nil {
		h = newHeardAccount()
		a.heard[account] = h
	}
	return h
}

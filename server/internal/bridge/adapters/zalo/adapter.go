// Package zalo is the Chat Bridge adapter for a personal Zalo account. Zalo has
// no official API for that, so the adapter drives the vendored zca-js sidecar
// (sidecar/dist/zalo-sidecar.cjs) over its stdio protocol, one process per
// login and one per subscribed account.
//
// It receives live 1-1 messages after a QR login (text, and photos, files and
// videos copied from Zalo's CDN, see message_media.go) and lists the
// conversations heard since the process started; it sends text to one person
// the account talks with (send.go). Groups are ignored, stickers and voice are
// a label, and there is no history beyond what this process heard (see Backfill).
package zalo

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
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
	stopGrace      time.Duration // stdin closed -> kill
	readyTimeout   time.Duration // start -> ready line
	firstQR        time.Duration // login_qr -> first QR image (in the background)
	loginStartWait time.Duration // longest wait of the first Login call
	loginPoll      time.Duration // longest wait of a later Login call for news
	loginIdle      time.Duration // a login nobody polls is stopped after this
	loginTTL       time.Duration // any login is stopped after this
	connect        time.Duration // login_session -> listener connected
	sendGap        time.Duration // least time between two sends of one account
	sendAnswer     time.Duration // send -> answer; also how long a try may still land
	historyAnswer  time.Duration // history -> page
}

// defaultTiming keeps every Login call far below the API server's 60 s write
// timeout (internal/api: http.Server.WriteTimeout): a start answers within
// 3 s and a poll within 20 s; Zalo is only waited for in the background.
var defaultTiming = timing{stopGrace: 3 * time.Second, readyTimeout: 10 * time.Second, firstQR: 30 * time.Second,
	loginStartWait: 3 * time.Second, loginPoll: 20 * time.Second, loginIdle: 45 * time.Second,
	loginTTL: 10 * time.Minute, connect: 2 * time.Minute,
	sendGap: 2 * time.Second, sendAnswer: 30 * time.Second, historyAnswer: 15 * time.Second}

// Adapter implements bridge.Adapter for Zalo.
type Adapter struct {
	runner   Runner
	logger   *slog.Logger
	timing   timing
	now      func() time.Time
	refusals *refusalTracker
	cdn      *cdnClient    // downloads photos and files from Zalo's CDN; nil is defaultCDN
	requests atomic.Uint64 // ids of commands the sidecar answers

	mu            sync.Mutex
	logins        map[string]*qrLogin
	loginFailedAt map[string]time.Time     // by Chat user: when a login last failed or was abandoned
	subs          map[string]*subscription // by Account.ID
	heard         map[string]*heardAccount // by Account.ID
	sending       map[string]*sendState    // by Account.ID
	// mismatched holds, by Account.ID, the fingerprint of a stored session
	// that logged in as another Zalo account; it is not tried again.
	mismatched map[string]string
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
	return newAdapter(cfg.Runner, logger, time.Now)
}

func newAdapter(runner Runner, logger *slog.Logger, now func() time.Time) *Adapter {
	return &Adapter{runner: runner, logger: logger, timing: defaultTiming, now: now, refusals: newRefusalTracker(now), cdn: defaultCDN,
		logins: map[string]*qrLogin{}, loginFailedAt: map[string]time.Time{}, subs: map[string]*subscription{},
		heard: map[string]*heardAccount{}, sending: map[string]*sendState{}, mismatched: map[string]string{}}
}

// Name implements bridge.Adapter.
func (a *Adapter) Name() string { return Name }

// Capabilities implements bridge.Adapter: live messages with the files they
// carry (received only), and text sent out.
func (a *Adapter) Capabilities() bridge.Capabilities {
	return bridge.Capabilities{bridge.CapLive: true, bridge.CapMedia: true, bridge.CapSend: true}
}

// Features implements bridge.Featured: messages come in (with photos, files and
// videos) and go out (text only). No edits, deletes, topics or pins.
func (a *Adapter) Features() map[feature.Feature]feature.Support {
	return map[feature.Feature]feature.Support{feature.Messages: {In: true, Out: true}}
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
		l.stop()
	}
	for _, l := range logins {
		<-l.finished // the sidecar is stopped when runQRLogin returns
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
	delete(a.sending, acct.ID)
	delete(a.mismatched, acct.ID)
	a.mu.Unlock()
	a.refusals.connected(acct.ID) // forget the streak with the session
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
// kept for it (its first message among them, up to maxRecentPerConv, none
// older than maxRecentAge), newest first, in one page. They are handed over
// once: a second Backfill of the conversation is empty.
func (a *Adapter) Backfill(_ context.Context, acct bridge.Account, conv string, cur bridge.Cursor, limit int) (bridge.Page, error) {
	if cur.Before != "" {
		return bridge.Page{Done: true}, nil
	}
	return bridge.Page{Messages: a.heardFor(acct.ID).takeRecent(conv, limit), Done: true}, nil
}

// FetchMedia implements bridge.Adapter: a person's photo or the file of a message,
// downloaded from Zalo's CDN by this process, not through the sidecar, and without
// the session (cdn_fetch.go). Any other ref is refused for good.
func (a *Adapter) FetchMedia(ctx context.Context, _ bridge.Account, ref string) (bridge.MediaStream, error) {
	cdn := a.cdn
	if cdn == nil {
		cdn = defaultCDN
	}
	if raw, ok := strings.CutPrefix(ref, avatarRef); ok {
		return fetchAvatar(ctx, cdn, raw)
	}
	if raw, ok := strings.CutPrefix(ref, mediaRef); ok {
		return fetchMessageFile(ctx, cdn, raw)
	}
	return nil, fmt.Errorf("%w: not a zalo media ref", bridge.ErrNotAllowed)
}

// heardFor returns the account's heard conversations, creating them.
func (a *Adapter) heardFor(account string) *heardAccount {
	a.mu.Lock()
	defer a.mu.Unlock()
	h := a.heard[account]
	if h == nil {
		h = newHeardAccount(a.now)
		a.heard[account] = h
	}
	return h
}

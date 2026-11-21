package zalo

import (
	"context"
	"strconv"
	"time"

	"app.local/server/internal/bridge"
)

// Limits on QR logins. Every signed-in Chat user may connect Zalo, and each
// login is a Node process that talks to Zalo from the server's address, so
// they are bounded on top of the engine's per-user rate.
const (
	// maxLoginsPerUser is how many logins one Chat user may have open.
	maxLoginsPerUser = 1
	// maxConcurrentLogins is how many logins the server runs at once.
	maxConcurrentLogins = 3
	// loginRetryGap is how long a user waits after a login failed or was
	// abandoned before starting another.
	loginRetryGap = 20 * time.Second
	// openLoginWait and busyLoginWait are round hints for the page's countdown
	// when the user already has a login open or the server is full: a login
	// nobody polls ends within loginIdle, a busy server frees a slot as soon as
	// any of the others finishes.
	openLoginWait = time.Minute
	busyLoginWait = 3 * time.Minute
)

// ownerKey names the Chat user of a Login call; calls that do not say share
// one key.
func ownerKey(ctx context.Context) string {
	if owner, ok := bridge.LoginOwner(ctx); ok {
		return strconv.FormatInt(owner, 10)
	}
	return ""
}

// admitLogin registers l if the limits allow it.
func (a *Adapter) admitLogin(l *qrLogin) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	for owner, at := range a.loginFailedAt {
		if now.Sub(at) >= loginRetryGap {
			delete(a.loginFailedAt, owner)
		}
	}
	open := 0
	for _, other := range a.logins {
		if other.owner == l.owner {
			open++
		}
	}
	switch {
	case open >= maxLoginsPerUser:
		return &bridge.LoginLimited{Reason: "a Zalo login is already open; finish it or wait a minute", Wait: openLoginWait}
	case !a.loginFailedAt[l.owner].IsZero():
		return &bridge.LoginLimited{Reason: "wait a few seconds before starting another Zalo login", Wait: loginRetryGap - now.Sub(a.loginFailedAt[l.owner])}
	case len(a.logins) >= maxConcurrentLogins:
		return &bridge.LoginLimited{Reason: "the server is running as many Zalo logins as it allows; try again in a few minutes", Wait: busyLoginWait}
	}
	a.logins[l.id] = l
	return nil
}

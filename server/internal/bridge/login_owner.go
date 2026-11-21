package bridge

import (
	"context"
	"errors"
)

// ErrLoginLimited is returned when a login cannot start now: the user already
// has one open, started one too recently, or the server runs as many as it
// allows. The engine's own per-user limit is the same error.
var ErrLoginLimited = errors.New("bridge: too many sign-in attempts")

type loginOwnerKey struct{}

// WithLoginOwner tells Adapter.Login which Chat user the login is for, so an
// adapter can limit logins per user. The engine sets it on every Login call.
func WithLoginOwner(ctx context.Context, owner int64) context.Context {
	return context.WithValue(ctx, loginOwnerKey{}, owner)
}

// LoginOwner is the Chat user of a Login call, false when the caller did not
// say.
func LoginOwner(ctx context.Context) (int64, bool) {
	owner, ok := ctx.Value(loginOwnerKey{}).(int64)
	return owner, ok
}

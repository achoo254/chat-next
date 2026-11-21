package bridge

import (
	"errors"
	"time"
)

// LoginLimited is ErrLoginLimited with how long the user should wait before
// starting a login again. Wait is a hint for the page's countdown: exact when
// the limit is a cool-down the adapter tracks, an upper bound or a round figure
// otherwise.
type LoginLimited struct {
	Reason string
	Wait   time.Duration
}

func (e *LoginLimited) Error() string {
	if e.Reason == "" {
		return ErrLoginLimited.Error()
	}
	return ErrLoginLimited.Error() + ": " + e.Reason
}

// Is makes errors.Is(err, ErrLoginLimited) true for a LoginLimited.
func (e *LoginLimited) Is(target error) bool { return target == ErrLoginLimited }

// LoginWait is the wait a login-limit error asks for, whole seconds rounded up,
// or 0 when err is not a LoginLimited or gives none.
func LoginWait(err error) int {
	var limited *LoginLimited
	if !errors.As(err, &limited) || limited.Wait <= 0 {
		return 0
	}
	return int((limited.Wait + time.Second - 1) / time.Second)
}

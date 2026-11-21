package bridge

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestLoginLimitedIsTheSentinelAndCarriesTheWait(t *testing.T) {
	err := fmt.Errorf("start: %w", &LoginLimited{Reason: "slow down", Wait: 1500 * time.Millisecond})
	if !errors.Is(err, ErrLoginLimited) {
		t.Fatal("a LoginLimited must match ErrLoginLimited")
	}
	if got := LoginWait(err); got != 2 {
		t.Fatalf("wait = %d, want 2 (rounded up)", got)
	}
	if got := LoginWait(ErrLoginLimited); got != 0 {
		t.Fatalf("the bare sentinel carries no wait, got %d", got)
	}
	if got := LoginWait(errors.New("other")); got != 0 {
		t.Fatalf("another error carries no wait, got %d", got)
	}
}

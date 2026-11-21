package rpc

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"connectrpc.com/connect"
)

func TestBridgeErrorTellsTheWaitOfALoginLimit(t *testing.T) {
	err := bridgeError(fmt.Errorf("login: %w", &bridge.LoginLimited{Reason: "cool-down", Wait: 12500 * time.Millisecond}))
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeResourceExhausted {
		t.Fatalf("want a ResourceExhausted connect error, got %v", err)
	}
	if want := "rate_limited: too many sign-in attempts; retry_after=13"; ce.Message() != want {
		t.Fatalf("message = %q, want %q", ce.Message(), want)
	}
}

func TestBridgeErrorKeepsTheOldMessageWithoutAWait(t *testing.T) {
	err := bridgeError(bridge.ErrLoginLimited)
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeResourceExhausted {
		t.Fatalf("want a ResourceExhausted connect error, got %v", err)
	}
	if want := "too many sign-in attempts; try again later"; ce.Message() != want {
		t.Fatalf("message = %q, want %q", ce.Message(), want)
	}
}

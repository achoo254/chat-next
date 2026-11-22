package telegram

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// scriptedInvoker answers each call with the next error of its script (nil once it runs out).
type scriptedInvoker struct {
	errs  []error
	calls int
}

func (s *scriptedInvoker) Invoke(context.Context, bin.Encoder, bin.Decoder) error {
	s.calls++
	if len(s.errs) == 0 {
		return nil
	}
	err := s.errs[0]
	s.errs = s.errs[1:]
	return err
}

var _ tg.Invoker = (*scriptedInvoker)(nil)

func shortWaits(t *testing.T) {
	t.Helper()
	saved := internalRetryWaits
	internalRetryWaits = []time.Duration{time.Millisecond, time.Millisecond}
	t.Cleanup(func() { internalRetryWaits = saved })
}

func TestRetryInternalRepeatsATelegramFaultUntilItPasses(t *testing.T) {
	shortWaits(t)
	inv := &scriptedInvoker{errs: []error{tgerr.New(500, "RPC_MCGET_FAIL")}}
	if err := retryInternal().Handle(inv).Invoke(context.Background(), nil, nil); err != nil {
		t.Fatalf("after one internal error = %v, want the retried call to pass", err)
	}
	if inv.calls != 2 {
		t.Fatalf("calls = %d, want 2", inv.calls)
	}
}

func TestRetryInternalGivesUpAfterItsRetries(t *testing.T) {
	shortWaits(t)
	fault := tgerr.New(500, "INTERNAL")
	inv := &scriptedInvoker{errs: []error{fault, fault, fault, fault}}
	err := retryInternal().Handle(inv).Invoke(context.Background(), nil, nil)
	if !isInternal(err) {
		t.Fatalf("err = %v, want the internal error once the retries are spent", err)
	}
	if inv.calls != 3 {
		t.Fatalf("calls = %d, want the call and two retries", inv.calls)
	}
}

func TestRetryInternalLeavesOtherErrorsAlone(t *testing.T) {
	shortWaits(t)
	for _, err := range []error{tgerr.New(400, "PEER_ID_INVALID"), tgerr.New(420, "FLOOD_WAIT_3"), errors.New("connection reset")} {
		inv := &scriptedInvoker{errs: []error{err}}
		if got := retryInternal().Handle(inv).Invoke(context.Background(), nil, nil); !errors.Is(got, err) {
			t.Fatalf("%v came back as %v", err, got)
		}
		if inv.calls != 1 {
			t.Fatalf("%v was retried: %d calls", err, inv.calls)
		}
	}
}

func TestRetryInternalStopsWaitingWhenTheCallIsCancelled(t *testing.T) {
	saved := internalRetryWaits
	internalRetryWaits = []time.Duration{time.Hour}
	t.Cleanup(func() { internalRetryWaits = saved })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	inv := &scriptedInvoker{errs: []error{tgerr.New(500, "RPC_MCGET_FAIL")}}
	if err := retryInternal().Handle(inv).Invoke(ctx, nil, nil); !isInternal(err) || inv.calls != 1 {
		t.Fatalf("err = %v after %d calls, want the internal error at once", err, inv.calls)
	}
}

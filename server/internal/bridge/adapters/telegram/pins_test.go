package telegram

import (
	"context"
	"errors"
	"slices"
	"testing"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tgerr"
)

func TestListPinnedReadsPageAfterPageUntilAShortOne(t *testing.T) {
	var offsets []int
	page := func(first, n int) []int {
		out := make([]int, n)
		for i := range out {
			out[i] = first - i
		}
		return out
	}
	got, err := listPinned(context.Background(), func(offset int) ([]int, error) {
		offsets = append(offsets, offset)
		switch len(offsets) {
		case 1:
			return page(500, pinPageMax), nil
		case 2:
			return page(400, pinPageMax), nil
		}
		return page(300, 3), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2*pinPageMax+3 || got[0] != 500 || got[len(got)-1] != 298 {
		t.Fatalf("got %d ids from %d down to %d", len(got), got[0], got[len(got)-1])
	}
	if want := []int{0, 401, 301}; !slices.Equal(offsets, want) {
		t.Fatalf("offsets = %v, want %v (each page continues below the last id of the one before)", offsets, want)
	}
}

func TestListPinnedStopsOnAnError(t *testing.T) {
	boom := errors.New("boom")
	if _, err := listPinned(context.Background(), func(int) ([]int, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestTranslatePin(t *testing.T) {
	for _, tc := range []struct {
		rpc  string
		want error // nil: the pin is already as asked, so the call succeeded
		not  bool  // true: ErrNotAllowed
	}{
		{rpc: "CHAT_NOT_MODIFIED"},
		{rpc: "PINNED_TOPIC_NOT_MODIFIED"},
		{rpc: "CHAT_ABOUT_NOT_MODIFIED"},
		{rpc: "CHAT_TITLE_NOT_MODIFIED"},
		{rpc: "CHAT_ADMIN_REQUIRED", not: true},
		{rpc: "PIN_RESTRICTED", not: true},
		{rpc: "PINNED_TOO_MUCH", not: true},
	} {
		err := translatePin(tgerr.New(400, tc.rpc))
		if tc.not != errors.Is(err, bridge.ErrNotAllowed) || (!tc.not && err != nil) {
			t.Errorf("%s -> %v, not allowed wanted = %v", tc.rpc, err, tc.not)
		}
	}
	if translatePin(nil) != nil {
		t.Error("nil became an error")
	}
}

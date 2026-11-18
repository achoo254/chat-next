package telegram

import (
	"context"
	"errors"
	"slices"
	"testing"
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

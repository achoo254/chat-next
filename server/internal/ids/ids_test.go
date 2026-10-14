package ids

import (
	"errors"
	"math"
	"testing"
)

func TestCheckSafe(t *testing.T) {
	for _, id := range []int64{0, 1, MaxSafeID - 1, MaxSafeID} {
		if err := CheckSafe(id); err != nil {
			t.Errorf("CheckSafe(%d) = %v, want nil", id, err)
		}
	}
	for _, id := range []int64{-1, math.MinInt64, MaxSafeID + 1, 1 << 53, math.MaxInt64} {
		if err := CheckSafe(id); !errors.Is(err, ErrUnsafeID) {
			t.Errorf("CheckSafe(%d) = %v, want ErrUnsafeID", id, err)
		}
	}
}

func TestShardedLayout(t *testing.T) {
	if MaxSafeID != 1<<(ShardBits+LocalBits)-1 {
		t.Fatalf("shard and local fields must fill exactly 53 bits")
	}
	cases := []struct{ shard, local, id int64 }{
		{0, 1, 1},
		{1, 1, 1<<43 | 1},
		{0, MaxLocal, MaxLocal},
		{MaxShard, 1, MaxShard<<43 | 1},
		{MaxShard, MaxLocal, MaxSafeID},
		{513, 123456789, 513<<43 | 123456789},
	}
	for _, c := range cases {
		id, err := MakeSharded(c.shard, c.local)
		if err != nil || id != c.id {
			t.Fatalf("MakeSharded(%d, %d) = %d, %v; want %d", c.shard, c.local, id, err, c.id)
		}
		if err := CheckSafe(id); err != nil {
			t.Fatalf("sharded id %d not safe: %v", id, err)
		}
		shard, err := ShardOf(id)
		if err != nil || shard != c.shard {
			t.Errorf("ShardOf(%d) = %d, %v; want %d", id, shard, err, c.shard)
		}
		local, err := LocalOf(id)
		if err != nil || local != c.local {
			t.Errorf("LocalOf(%d) = %d, %v; want %d", id, local, err, c.local)
		}
	}
}

func TestShardedRejectsOverflow(t *testing.T) {
	bad := []struct{ shard, local int64 }{
		{-1, 1}, {MaxShard + 1, 1}, {0, -1}, {0, MaxLocal + 1}, {MaxShard + 1, MaxLocal + 1},
		{0, 0}, {5, 0}, // local 0 would make shard 0's id the proto "none" value
	}
	for _, b := range bad {
		if _, err := MakeSharded(b.shard, b.local); !errors.Is(err, ErrOutOfRange) {
			t.Errorf("MakeSharded(%d, %d) error = %v, want ErrOutOfRange", b.shard, b.local, err)
		}
	}
	for _, id := range []int64{-1, MaxSafeID + 1} {
		if _, err := ShardOf(id); !errors.Is(err, ErrUnsafeID) {
			t.Errorf("ShardOf(%d) error = %v, want ErrUnsafeID", id, err)
		}
		if _, err := LocalOf(id); !errors.Is(err, ErrUnsafeID) {
			t.Errorf("LocalOf(%d) error = %v, want ErrUnsafeID", id, err)
		}
	}
}

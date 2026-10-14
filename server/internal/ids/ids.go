// Package ids implements the identifier contract of ADR 0001.
//
// Every id that leaves the server (user_id, chat_id, seq, pts, update_id)
// must stay below 2^53 so JavaScript clients can hold it in a number.
// user_id and chat_id carry a shard in their top bits:
//
//	53 bits = [shard: 10 bits][local: 43 bits]
//
// The local part starts at 1 because proto uses 0 for "none".
//
// Snowflake message keys are unique only while no two processes share a
// worker number. The deployment must lease worker numbers (for example a
// Postgres or Redis lease that also records the highest millisecond issued
// under it) so a worker is never held by two processes, and a process that
// takes over a worker starts after that millisecond. The lease is implemented
// with the backend services, not in this package.
//
// The TypeScript twin is packages/core/src/ids.
package ids

import (
	"errors"
	"fmt"
)

const (
	// MaxSafeID is the largest id that may be exposed outside the server
	// (Number.MAX_SAFE_INTEGER in JavaScript).
	MaxSafeID int64 = 1<<53 - 1

	// ShardBits is the width of the shard field of a sharded id.
	ShardBits = 10
	// LocalBits is the width of the per-shard local field of a sharded id.
	LocalBits = 43

	// MaxShard is the largest shard number.
	MaxShard int64 = 1<<ShardBits - 1
	// MaxLocal is the largest per-shard local id.
	MaxLocal int64 = 1<<LocalBits - 1
)

// ErrUnsafeID reports an external id outside [0, MaxSafeID].
var ErrUnsafeID = errors.New("ids: id outside the safe range [0, 2^53-1]")

// ErrOutOfRange reports a shard or local part outside its field width.
var ErrOutOfRange = errors.New("ids: sharded id part out of range")

// CheckSafe returns ErrUnsafeID (wrapped with the value) when id cannot be
// exposed to clients. Serializers call it for every external id.
func CheckSafe(id int64) error {
	if id < 0 || id > MaxSafeID {
		return fmt.Errorf("%w: %d", ErrUnsafeID, id)
	}
	return nil
}

// MakeSharded builds a sharded id from its shard and per-shard local part.
// local must be at least 1: proto uses 0 for "none", so no sharded id may be 0
// and every shard reserves local 0.
func MakeSharded(shard, local int64) (int64, error) {
	if shard < 0 || shard > MaxShard {
		return 0, fmt.Errorf("%w: shard %d not in [0, %d]", ErrOutOfRange, shard, MaxShard)
	}
	if local < 1 || local > MaxLocal {
		return 0, fmt.Errorf("%w: local %d not in [1, %d]", ErrOutOfRange, local, MaxLocal)
	}
	return shard<<LocalBits | local, nil
}

// ShardOf returns the shard of a sharded id.
func ShardOf(id int64) (int64, error) {
	if err := CheckSafe(id); err != nil {
		return 0, err
	}
	return id >> LocalBits, nil
}

// LocalOf returns the per-shard local part of a sharded id.
func LocalOf(id int64) (int64, error) {
	if err := CheckSafe(id); err != nil {
		return 0, err
	}
	return id & MaxLocal, nil
}

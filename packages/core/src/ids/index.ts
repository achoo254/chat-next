// Identifier contract (ADR 0001). External ids (user_id, chat_id, seq, pts,
// update_id) stay below 2^53 so they fit a JavaScript number exactly.
// user_id and chat_id carry a shard: 53 bits = [shard: 10 bits][local: 43 bits].
// Proto uses 0 for "none", so the local part of a sharded id starts at 1.
// Snowflake message keys are server-internal and have no client helper.
// The Go twin is server/internal/ids.

/** Largest id that may cross the client/server boundary (2^53 - 1). */
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

export const SHARD_BITS = 10;
export const LOCAL_BITS = 43;
export const MAX_SHARD = 2 ** SHARD_BITS - 1;
export const MAX_LOCAL = 2 ** LOCAL_BITS - 1;

// 2^43: multiplying and dividing by it is exact for safe integers, unlike
// bitwise operators, which truncate to 32 bits.
const LOCAL_RANGE = 2 ** LOCAL_BITS;

/**
 * Returns `id` as a number when it is an integer in [0, MAX_SAFE_ID] and
 * throws a RangeError otherwise. Accepts bigint because protobuf int64 fields
 * decode to bigint.
 */
export function assertSafeId(id: number | bigint): number {
	if (typeof id === "bigint") {
		if (id < 0n || id > BigInt(MAX_SAFE_ID)) {
			throw new RangeError(`id ${id} is outside the safe range [0, 2^53-1]`);
		}
		return Number(id);
	}
	if (!Number.isInteger(id) || id < 0 || id > MAX_SAFE_ID) {
		throw new RangeError(`id ${id} is not an integer in the safe range [0, 2^53-1]`);
	}
	return id;
}

/**
 * Builds a sharded id; throws a RangeError when a part does not fit its field
 * or `local` is 0 (an id of 0 means "none" on the wire).
 */
export function makeShardedId(shard: number, local: number): number {
	if (!Number.isInteger(shard) || shard < 0 || shard > MAX_SHARD) {
		throw new RangeError(`shard ${shard} is not an integer in [0, ${MAX_SHARD}]`);
	}
	if (!Number.isInteger(local) || local < 1 || local > MAX_LOCAL) {
		throw new RangeError(`local ${local} is not an integer in [1, ${MAX_LOCAL}]`);
	}
	return shard * LOCAL_RANGE + local;
}

/** Returns the shard of a sharded id. */
export function shardOf(id: number | bigint): number {
	return Math.floor(assertSafeId(id) / LOCAL_RANGE);
}

/** Returns the per-shard local part of a sharded id. */
export function localOf(id: number | bigint): number {
	return assertSafeId(id) % LOCAL_RANGE;
}

import { describe, expect, it } from "vitest";
import {
	LOCAL_BITS,
	MAX_LOCAL,
	MAX_SAFE_ID,
	MAX_SHARD,
	SHARD_BITS,
	assertSafeId,
	localOf,
	makeShardedId,
	shardOf,
} from "../src/index.ts";

describe("assertSafeId", () => {
	it("accepts the safe range boundaries", () => {
		for (const id of [0, 1, MAX_SAFE_ID - 1, MAX_SAFE_ID]) {
			expect(assertSafeId(id)).toBe(id);
		}
		expect(assertSafeId(BigInt(MAX_SAFE_ID))).toBe(MAX_SAFE_ID);
		expect(assertSafeId(0n)).toBe(0);
	});

	it("rejects negative, fractional, non-finite and oversized ids", () => {
		for (const id of [-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SAFE_ID + 1, 2 ** 53, 2 ** 63]) {
			expect(() => assertSafeId(id)).toThrow(RangeError);
		}
		for (const id of [-1n, 2n ** 53n, 2n ** 63n - 1n]) {
			expect(() => assertSafeId(id)).toThrow(RangeError);
		}
	});
});

describe("sharded ids", () => {
	it("fills exactly 53 bits", () => {
		expect(SHARD_BITS + LOCAL_BITS).toBe(53);
		expect(makeShardedId(MAX_SHARD, MAX_LOCAL)).toBe(MAX_SAFE_ID);
	});

	it.each([
		[0, 1, 1],
		[1, 1, 2 ** 43 + 1],
		[0, MAX_LOCAL, MAX_LOCAL],
		[MAX_SHARD, 1, MAX_SHARD * 2 ** 43 + 1],
		[MAX_SHARD, MAX_LOCAL, MAX_SAFE_ID],
		[513, 123456789, 513 * 2 ** 43 + 123456789],
	])("round-trips shard %i local %i", (shard, local, id) => {
		expect(makeShardedId(shard, local)).toBe(id);
		expect(shardOf(id)).toBe(shard);
		expect(localOf(id)).toBe(local);
		expect(shardOf(BigInt(id))).toBe(shard);
		expect(localOf(BigInt(id))).toBe(local);
	});

	it("rejects parts outside their fields", () => {
		const bad: [number, number][] = [
			[-1, 1],
			[MAX_SHARD + 1, 1],
			[0.5, 1],
			[0, -1],
			[0, 0],
			[5, 0],
			[0, MAX_LOCAL + 1],
			[0, 1.5],
		];
		for (const [shard, local] of bad) {
			expect(() => makeShardedId(shard, local)).toThrow(RangeError);
		}
	});

	it("rejects unsafe ids when splitting", () => {
		expect(() => shardOf(MAX_SAFE_ID + 1)).toThrow(RangeError);
		expect(() => localOf(-1)).toThrow(RangeError);
	});
});

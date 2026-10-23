import { describe, expect, it } from "vitest";
import { LeaderLock, soloLocks } from "../src/leader.ts";

describe("soloLocks", () => {
	it("makes the only page the leader at once when the WebView has no Web Locks", async () => {
		const lock = new LeaderLock(soloLocks, "chat-core-leader:localhost");
		let leader = false;
		const errors: unknown[] = [];
		const held = lock.acquire(async () => {
			leader = true;
		}, (err) => errors.push(err));
		await Promise.resolve();
		expect(leader).toBe(true);
		lock.release();
		await held;
		expect(errors).toEqual([]);
	});
});

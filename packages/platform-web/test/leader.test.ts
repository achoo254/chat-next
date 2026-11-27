import { describe, expect, it, vi } from "vitest";
import { LeaderLock, soloLocks, type LockManagerLike } from "../src/leader.ts";

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

/**
 * Chrome's stuck line: the lock is free, yet the request at the head of the line (a tab Chrome froze) is never
 * granted, so nothing queued behind it ever is either. Only a steal is granted.
 */
class StuckLine implements LockManagerLike {
	readonly waiting: { name: string; signal: AbortSignal | undefined; reject: (err: unknown) => void }[] = [];
	holder: string | null = null;
	steals = 0;

	request(name: string, options: { mode: "exclusive"; signal?: AbortSignal; steal?: boolean }, callback: () => Promise<void>): Promise<void> {
		if (options.steal === true) {
			this.steals += 1;
			this.holder = name;
			return callback().finally(() => {
				this.holder = null;
			});
		}
		return new Promise((_resolve, reject) => {
			const entry = { name, signal: options.signal, reject };
			this.waiting.push(entry);
			options.signal?.addEventListener("abort", () => {
				this.waiting.splice(this.waiting.indexOf(entry), 1);
				reject(new DOMException("aborted", "AbortError"));
			});
		});
	}

	query(): Promise<{ held: { name: string }[]; pending: { name: string }[] }> {
		return Promise.resolve({ held: this.holder === null ? [] : [{ name: this.holder }], pending: this.waiting.map((w) => ({ name: w.name })) });
	}
}

describe("a stuck line", () => {
	it("takes the free lock over once the line stays stuck, and leads once", async () => {
		const locks = new StuckLine();
		const lock = new LeaderLock(locks, "leader", 10);
		let leads = 0;
		const errors: unknown[] = [];
		const held = lock.acquire(async () => {
			leads += 1;
		}, (err) => errors.push(err));
		await vi.waitFor(() => expect(leads).toBe(1));
		expect(locks.steals).toBe(1);
		expect(locks.holder).toBe("leader");
		// Out of the line: nothing of this tab waits there any more.
		expect(locks.waiting).toEqual([]);
		lock.release();
		await held;
		expect(locks.holder).toBeNull();
		expect(errors).toEqual([]);
	});

	it("waits its turn while another tab holds the lock", async () => {
		const locks = new StuckLine();
		locks.holder = "leader";
		const lock = new LeaderLock(locks, "leader", 10);
		let leads = 0;
		void lock.acquire(async () => {
			leads += 1;
		}, () => undefined);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(leads).toBe(0);
		expect(locks.steals).toBe(0);
		lock.release();
	});
});

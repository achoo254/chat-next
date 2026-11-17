// The reload of a chat's window must not run back to back while events keep
// arriving (an import filling a chat), or the list redraws and rescrolls
// continuously.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalescer } from "../src/messaging/data/store.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A task that finishes at once, counting its runs. */
function counted(): { task: () => Promise<void>; runs: () => number } {
	let runs = 0;
	return {
		task: () => {
			runs++;
			return Promise.resolve();
		},
		runs: () => runs,
	};
}

describe("Coalescer", () => {
	it("starts the first run at once", async () => {
		const c = counted();
		new Coalescer(c.task, 750).run();
		expect(c.runs()).toBe(1);
	});

	it("holds a rerun until the minimum gap has passed, and collapses the events into one", async () => {
		const c = counted();
		const refresh = new Coalescer(c.task, 750);
		refresh.run();
		for (let i = 0; i < 50; i++) refresh.run();
		await vi.advanceTimersByTimeAsync(700);
		expect(c.runs()).toBe(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(c.runs()).toBe(2);
		// Nothing more is queued once the events stop.
		await vi.advanceTimersByTimeAsync(5000);
		expect(c.runs()).toBe(2);
	});

	it("keeps pacing a steady stream: about one run per gap, not one per event", async () => {
		const c = counted();
		const refresh = new Coalescer(c.task, 750);
		for (let ms = 0; ms < 3000; ms += 10) {
			refresh.run();
			await vi.advanceTimersByTimeAsync(10);
		}
		expect(c.runs()).toBeLessThanOrEqual(5);
		expect(c.runs()).toBeGreaterThanOrEqual(3);
	});

	it("without a gap reruns straight away as before", async () => {
		const c = counted();
		let release: () => void = () => {};
		let first = true;
		const refresh = new Coalescer(() => {
			if (!first) return c.task();
			first = false;
			c.task();
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		refresh.run();
		refresh.run();
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(c.runs()).toBe(2);
	});
});

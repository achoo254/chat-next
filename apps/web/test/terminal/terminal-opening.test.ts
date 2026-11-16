// A pane that just attached keeps its opening screen until the terminal is drawn: it opens once the first
// output went quiet, at once when something else shows the session, and after a bounded wait otherwise.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_MAX_MS, OPEN_QUIET_MS, OPEN_SETTLE_MS, OpeningGate } from "../../src/terminal/terminal-opening.ts";

let opened = 0;
const gate = () => new OpeningGate(() => (opened += 1), () => Date.now());

beforeEach(() => {
	vi.useFakeTimers();
	opened = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the opening screen of a pane", () => {
	it("stays while the program draws, and goes once the output went quiet", () => {
		const g = gate();
		g.content();
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(OPEN_QUIET_MS / 2);
			g.content();
		}
		expect(opened).toBe(0);
		vi.advanceTimersByTime(OPEN_QUIET_MS + 60);
		expect(opened).toBe(1);
		expect(g.opened).toBe(true);
	});

	it("goes after a bounded wait when the output streams on", () => {
		const g = gate();
		for (let t = 0; t < OPEN_SETTLE_MS + 200; t += 40) {
			g.content();
			vi.advanceTimersByTime(40);
		}
		expect(opened).toBe(1);
	});

	it("goes when nothing comes at all", () => {
		gate();
		vi.advanceTimersByTime(OPEN_MAX_MS - 100);
		expect(opened).toBe(0);
		vi.advanceTimersByTime(200);
		expect(opened).toBe(1);
	});

	it("goes at once when the preview shows the session, and only once", () => {
		const g = gate();
		g.open();
		g.open();
		g.content();
		vi.advanceTimersByTime(OPEN_MAX_MS);
		expect(opened).toBe(1);
	});

	it("never calls back after the pane went", () => {
		const g = gate();
		g.content();
		g.dispose();
		vi.advanceTimersByTime(OPEN_MAX_MS);
		expect(opened).toBe(0);
	});
});

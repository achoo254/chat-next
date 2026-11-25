// The watched machine's clock against the viewer's: the skew is estimated
// from the events pushed live (a lower bound per event, the largest kept),
// within ±MAX_SKEW_MS, never from CI or bottleneck times; the sink publishes
// it; and the card's runtime and done hold read right with the machine 5 s
// ahead of the viewer or 5 s behind.
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityCardOf, DONE_HOLD_MS } from "../../../src/machines/observatory/activity-card-model.ts";
import { machineNow, MAX_SKEW_MS, refineSkew } from "../../../src/machines/observatory/machine-clock.ts";
import { sessionSink, type Held } from "../../../src/machines/observatory/use-observatory-session.ts";
import { useTickingNow } from "../../../src/machines/observatory/use-tool-content.ts";
import { played } from "../../observatory/render-fixtures.ts";
import { lifecycle, numbered, prompt, snapshot, T0, tool } from "./live-map-fixtures.ts";

afterEach(() => vi.useRealTimers());

describe("refineSkew", () => {
	it("reads the machine 5 s ahead or 5 s behind from a fresh event", () => {
		const e = prompt(1, 0);
		expect(refineSkew(null, [e], T0 - 5_000)).toBe(5_000);
		expect(refineSkew(null, [e], T0 + 5_000)).toBe(-5_000);
	});

	it("keeps the largest bound: an event delivered late does not pull it back, a fresher one raises it", () => {
		let skew = refineSkew(null, [prompt(1, 0)], T0 + 2_000);
		expect(skew).toBe(-2_000);
		skew = refineSkew(skew, [prompt(2, 0)], T0 + 9_000);
		expect(skew).toBe(-2_000);
		skew = refineSkew(skew, [prompt(3, 1_000)], T0 + 1_100);
		expect(skew).toBe(-100);
	});

	it("takes a finished call at its end, not its start", () => {
		const ended = tool("r1", 0, { success: true, durationMs: 60_000 });
		expect(refineSkew(null, [ended], T0 + 60_000 - 5_000)).toBe(5_000);
	});

	it("ignores bounds past MAX_SKEW_MS (a backlog), CI events (GitHub's clock) and an empty batch", () => {
		expect(refineSkew(null, [prompt(1, 0)], T0 + MAX_SKEW_MS + 1)).toBeNull();
		expect(refineSkew(null, [lifecycle("ci_finished", "c1", 0, { flag: true })], T0 - 5_000)).toBeNull();
		expect(refineSkew(3_000, [], T0)).toBe(3_000);
	});
});

describe("the sink's skew", () => {
	it("is 0 from a snapshot alone, then follows the events pushed live", () => {
		let viewer = T0 + 60 * 60_000;
		let held: Held = { state: null, failure: null, disconnected: false, skewMs: 0 };
		const sink = sessionSink((change) => {
			held = change(held);
		}, () => viewer);
		// An hour-old snapshot says nothing about the clocks.
		sink.snapshot(snapshot([prompt(1, 0)], { seq: 1 }));
		expect(held.skewMs).toBe(0);
		viewer = T0 + 10_000 - 5_000;
		sink.events(1n, numbered([prompt(2, 10_000)], 2));
		expect(held.skewMs).toBe(5_000);
		viewer = T0 + 20_000 + 5_000;
		sink.events(1n, numbered([prompt(3, 20_000)], 3));
		// A bound below the estimate (or the same event delivered late) does not lower it.
		expect(held.skewMs).toBe(5_000);
	});
});

describe("the card in the machine's clock", () => {
	for (const skew of [5_000, -5_000]) {
		it(`reads the runtime and the done hold right with the machine ${skew > 0 ? "ahead" : "behind"} by 5 s`, () => {
			const run = played([prompt(1, 0), tool("b1", 500, { toolName: "Bash", station: "SANDBOX" })]);
			// The viewer's clock reads 5 s off the machine's: a second after the call started there.
			const viewer = T0 + 1_500 - skew;
			const card = activityCardOf(run.state, machineNow(viewer, skew));
			expect(card.subject.kind === "run" && card.subject.call.runtimeMs).toBe(1_000);
			const done = played([prompt(1, 0), tool("b1", 500, { toolName: "Bash", station: "SANDBOX", success: true, durationMs: 1_000 })]);
			const end = T0 + 1_500;
			expect(activityCardOf(done.state, machineNow(end + DONE_HOLD_MS - 100 - skew, skew)).subject.kind).toBe("done");
			expect(activityCardOf(done.state, machineNow(end + DONE_HOLD_MS + 100 - skew, skew)).subject.kind).not.toBe("done");
		});
	}

	it("ticks in the machine's time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const { result } = renderHook(() => useTickingNow(false, 1, 100, 5_000));
		expect(result.current).toBe(T0 + 5_000);
	});
});

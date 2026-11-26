// A tool call that has just ended is not on the machine yet ("not_yet"): the card asks again by
// itself until the content is there, a bounded number of times, and stops when the call changes.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMapContent } from "../../../src/machines/observatory/live-map-types.ts";
import type { ObservatoryLink } from "../../../src/machines/observatory/observatory-client.ts";
import { useToolContent, type ContentSource } from "../../../src/machines/observatory/use-tool-content.ts";

const asked = vi.fn<(eventId: string) => Promise<LiveMapContent>>();

vi.mock("../../../src/machines/observatory/observatory-client.ts", () => ({
	eventContent: (_link: unknown, _session: string, eventId: string) => asked(eventId),
}));

const source: ContentSource = { link: {} as ObservatoryLink, sessionId: "s1", online: true };
const NOT_YET: LiveMapContent = { eventId: "tool:t1", state: "not_yet", text: "" };
const STORED: LiveMapContent = { eventId: "tool:t1", state: "stored", text: JSON.stringify({ output: "xong" }) };

/** Moves the clock in small steps, each flushed by React, as the real clock does between renders. */
async function settle(ms: number): Promise<void> {
	for (let left = ms; ; left -= 250) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(Math.min(left, 250));
		});
		if (left <= 250) return;
	}
}

describe("useToolContent while the machine has not stored the call yet", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		asked.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks again until the content is stored, then stops asking", async () => {
		asked.mockResolvedValueOnce(NOT_YET).mockResolvedValueOnce(NOT_YET).mockResolvedValue(STORED);
		const view = renderHook(() => useToolContent(source, "tool:t1", true, false));
		await settle(0);
		expect(view.result.current.kind).toBe("not_yet");
		await settle(1500);
		expect(view.result.current.kind).toBe("not_yet");
		await settle(1500);
		expect(view.result.current.kind).toBe("ok");
		const calls = asked.mock.calls.length;
		await settle(20_000);
		expect(asked.mock.calls.length).toBe(calls);
	});

	it("gives up after a bounded number of asks when the machine never stores it", async () => {
		asked.mockResolvedValue(NOT_YET);
		const view = renderHook(() => useToolContent(source, "tool:t1", true, false));
		await settle(60_000);
		expect(view.result.current.kind).toBe("not_yet");
		expect(asked.mock.calls.length).toBe(9);
	});

	it("does not keep asking for a call the viewer moved away from", async () => {
		asked.mockResolvedValue(NOT_YET);
		const view = renderHook(({ id }) => useToolContent(source, id, true, false), { initialProps: { id: "tool:t1" } });
		await settle(0);
		view.rerender({ id: "tool:t2" });
		await settle(0);
		const idsBefore = asked.mock.calls.map(([id]) => id);
		expect(idsBefore).toContain("tool:t2");
		view.unmount();
		const calls = asked.mock.calls.length;
		await settle(20_000);
		expect(asked.mock.calls.length).toBe(calls);
	});
});

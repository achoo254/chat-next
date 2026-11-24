// "Is this machine's session list still on its way": a screen shows a
// skeleton then, never "nothing waits for you" or the first steps.
import { describe, expect, it } from "vitest";
import { isListLoading, type Conn } from "../../src/machines/machine-status.ts";

const view = (conn: Conn, listed: boolean) => ({ conn, state: { listed } });

describe("isListLoading", () => {
	it("is loading while the link is connecting or reconnecting", () => {
		expect(isListLoading(view({ kind: "connecting" }, false))).toBe(true);
		expect(isListLoading(view({ kind: "retrying", attempt: 2 }, false))).toBe(true);
	});

	it("is loading when the link is open but the thread list has not arrived", () => {
		expect(isListLoading(view({ kind: "on" }, false))).toBe(true);
	});

	it("is settled once the thread list arrived", () => {
		expect(isListLoading(view({ kind: "on" }, true))).toBe(false);
	});

	it("is settled for a machine that cannot answer: offline, blocked or too old", () => {
		expect(isListLoading(view({ kind: "offline", lastSeenMs: 0 }, false))).toBe(false);
		expect(isListLoading(view({ kind: "blocked", reason: "revoked" }, false))).toBe(false);
		expect(isListLoading(view({ kind: "update" }, false))).toBe(false);
	});
});

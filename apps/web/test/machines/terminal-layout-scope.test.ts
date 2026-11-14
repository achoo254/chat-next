// A stored dock layout restored against the machine's sessions: after the
// machine's terminal process restarts it numbers sessions from 1 again, so a
// stored number may now belong to another session's AI and must not show it.
import { describe, expect, it } from "vitest";
import { addTab, EMPTY_LAYOUT, panesOf, pruneForScope, type DockLayout } from "../../src/terminal/terminal-layout.ts";

const panes = (l: DockLayout) => l.tabs.flatMap((t) => panesOf(t.root)).map((p) => ({ session: p.session, ai: p.ai === true }));

describe("restoring a stored layout", () => {
	it("keeps this session's AI and plain shells", () => {
		const stored = addTab(addTab(EMPTY_LAYOUT, 1, true), 2);
		const kept = pruneForScope(stored, [{ session: 1, threadId: "t-a" }, { session: 2, threadId: "" }], "t-a");
		expect(panes(kept)).toEqual([{ session: 1, ai: true }, { session: 2, ai: false }]);
	});

	it("drops a number that now holds another session's AI, or a shell where the AI was", () => {
		const stored = addTab(addTab(EMPTY_LAYOUT, 1, true), 2);
		// Session 1 is now another session's AI; session 2 is now an AI too, not a shell.
		const kept = pruneForScope(stored, [{ session: 1, threadId: "t-b" }, { session: 2, threadId: "t-a" }], "t-a");
		expect(panes(kept)).toEqual([]);
		const shellNow = pruneForScope(addTab(EMPTY_LAYOUT, 3, true), [{ session: 3, threadId: "" }], "t-a");
		expect(panes(shellNow)).toEqual([]);
	});

	it("drops sessions the machine no longer has, and any AI on the machine's own terminal page", () => {
		const stored = addTab(addTab(EMPTY_LAYOUT, 4), 5, true);
		expect(panes(pruneForScope(stored, [{ session: 5, threadId: "t-a" }], undefined))).toEqual([]);
	});
});

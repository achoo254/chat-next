// The browser tab in the dock's layout: one tab for the machine's browser, no session behind it, kept
// through what drops dead sessions and through the store's round trip.
import { describe, expect, it } from "vitest";
import { addBrowserTab, addTab, closePane, EMPTY_LAYOUT, panesOf, parseLayout, prune, pruneForScope, sessionsOf } from "../../src/terminal/terminal-layout.ts";

const withShell = addTab(EMPTY_LAYOUT, 3);

describe("the browser tab of the layout", () => {
	it("adds one tab, shows it, and shows the same one again instead of a second", () => {
		const once = addBrowserTab(withShell);
		expect(once.tabs).toHaveLength(2);
		const browser = once.tabs.find((t) => panesOf(t.root).some((p) => p.browser === true));
		expect(browser?.id).toBe(once.active);
		const back = { ...once, active: withShell.tabs[0]?.id ?? "" };
		const again = addBrowserTab(back);
		expect(again.tabs).toHaveLength(2);
		expect(again.active).toBe(browser?.id);
	});

	it("holds no session: the sessions the layout shows are the terminals'", () => {
		expect([...sessionsOf(addBrowserTab(withShell))]).toEqual([3]);
		expect([...sessionsOf(addBrowserTab(EMPTY_LAYOUT))]).toEqual([]);
	});

	it("stays when the machine has no such session (a dead terminal goes, the browser does not)", () => {
		const layout = addBrowserTab(withShell);
		const pruned = prune(layout, new Set());
		expect(pruned.tabs).toHaveLength(1);
		const left = pruned.tabs[0];
		expect(left === undefined ? undefined : panesOf(left.root)[0]?.browser).toBe(true);
		const scoped = pruneForScope(layout, [], undefined);
		expect(scoped.tabs.map((t) => panesOf(t.root)[0]?.browser === true)).toEqual([true]);
	});

	it("survives being stored and read back, and closes like any pane", () => {
		const layout = addBrowserTab(withShell);
		expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
		const browserTab = layout.tabs.find((t) => panesOf(t.root).some((p) => p.browser === true));
		const pane = browserTab === undefined ? undefined : panesOf(browserTab.root)[0];
		expect(closePane(layout, pane?.id ?? "").tabs).toHaveLength(1);
	});
});

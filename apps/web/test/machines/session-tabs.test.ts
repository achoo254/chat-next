// A session's terminal tabs under its row in the AI Agent column: named as
// the dock names them, checked against the machine's list as the dock checks
// them, and the shells in them kept out of the workspace's loose shells; the
// docks' store tells the column when a layout changes.
import { create } from "@bufbuild/protobuf";
import { TermSessionInfoSchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it, vi } from "vitest";
import { sessionTabShells, sessionTabs } from "../../src/machines/session-tabs.tsx";
import type { MachineView } from "../../src/machines/use-machines.ts";
import { addTab, EMPTY_LAYOUT, layoutStore, splitPane } from "../../src/terminal/terminal-layout.ts";

const term = (session: number, title: string, threadId = "") => create(TermSessionInfoSchema, { session, title, threadId, cwd: "/w/app" });
const names = { ai: "Claude Code", tab: (n: number) => `Terminal ${n}` };

describe("sessionTabs", () => {
	const layout = addTab(addTab(addTab(EMPTY_LAYOUT, 1, true), 2), 3);

	it("names each tab as the dock does and marks the one in front", () => {
		const tabs = sessionTabs({ ...layout, active: layout.tabs[1]?.id ?? "" }, [term(1, "✳ Sửa lỗi sidebar", "t1"), term(2, "zsh"), term(3, "")], "t1", names);
		expect(tabs.map((x) => [x.title, x.ai, x.active])).toEqual([
			["Sửa lỗi sidebar", true, false],
			["zsh", false, true],
			["Terminal 3", false, false],
		]);
	});

	it("drops what the machine no longer runs for the session, and keeps the stored tabs before its list came", () => {
		// Session 3 ended; session 1 is now another session's AI.
		const tabs = sessionTabs(layout, [term(1, "", "t2"), term(2, "")], "t1", names);
		expect(tabs.map((x) => x.title)).toEqual(["Terminal 1"]);
		expect(sessionTabs(layout, undefined, "t1", names).map((x) => x.title)).toEqual(["Claude Code", "Terminal 2", "Terminal 3"]);
		expect(sessionTabs(undefined, [], "t1", names)).toEqual([]);
	});
});

describe("sessionTabShells", () => {
	it("collects the shells in the docks of the machine's own sessions only", () => {
		// The AI's tab, and a shell tab split in two.
		const one = addTab(addTab(EMPTY_LAYOUT, 1, true), 2);
		const withSplit = splitPane(one, one.tabs[1]?.focus ?? "", "row", 4);
		const known = new Map([
			["m1/s/t1", withSplit],
			["m1/s/gone", addTab(EMPTY_LAYOUT, 5)],
			["m1", addTab(EMPTY_LAYOUT, 6)],
			["m2/s/t1", addTab(EMPTY_LAYOUT, 7)],
		]);
		const machine = { entry: { ref: "m1" }, state: { threads: [{ id: "t1" }] } } as unknown as MachineView;
		expect([...sessionTabShells(known, machine)].sort()).toEqual([2, 4]);
	});
});

describe("the docks' store", () => {
	it("tells who watches when a layout is saved, and knows it", async () => {
		const store = layoutStore(undefined);
		const seen = vi.fn();
		const stop = store.subscribe(seen);
		const before = store.version();
		const layout = addTab(EMPTY_LAYOUT, 3);
		await store.save("m1/s/t1", layout);
		expect(seen).toHaveBeenCalledTimes(1);
		expect(store.version()).not.toBe(before);
		expect(store.known().get("m1/s/t1")).toEqual(layout);
		await store.loadAll();
		stop();
		await store.save("m1/s/t1", EMPTY_LAYOUT);
		expect(seen).toHaveBeenCalledTimes(1);
	});
});

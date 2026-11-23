// The automatic answers Advisor gave (the list "Câu trả lời gần đây") survive
// a reload of the page, and go with the sign-out.
import { beforeEach, describe, expect, it } from "vitest";
import { AdvisorStore, MAX_HISTORY, type HistoryEntry } from "../../src/advisor/advisor-store.ts";

const KEY = "advisor:history";

function entry(id: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
	return { id, machine: "7", threadId: `t-${id}`, title: "Phiên", text: "Phương án A (82%)", target: `/ai/7/s/t-${id}`, at: 1_000, unavailable: "", ...extra };
}

beforeEach(() => window.localStorage.clear());

describe("the history of automatic answers", () => {
	it("is still there for a store made after a reload, newest first", () => {
		const first = new AdvisorStore();
		first.addHistory(entry("a"));
		first.addHistory(entry("b"));
		const reloaded = new AdvisorStore();
		expect(reloaded.snapshot().history.map((h) => h.id)).toEqual(["b", "a"]);
		expect(reloaded.snapshot().history[0]).toEqual(entry("b"));
	});

	it("keeps no more than the limit, dropping the oldest", () => {
		const store = new AdvisorStore();
		for (let i = 0; i < MAX_HISTORY + 3; i++) store.addHistory(entry(String(i)));
		const ids = new AdvisorStore().snapshot().history.map((h) => h.id);
		expect(ids).toHaveLength(MAX_HISTORY);
		expect(ids[0]).toBe(String(MAX_HISTORY + 2));
	});

	it("remembers an answer whose session turned out gone", () => {
		const store = new AdvisorStore();
		store.addHistory(entry("a"));
		store.markUnavailable("a", "missing");
		expect(new AdvisorStore().snapshot().history[0]?.unavailable).toBe("missing");
	});

	it("does not list the same answer twice", () => {
		const store = new AdvisorStore();
		store.addHistory(entry("a"));
		store.addHistory(entry("a"));
		expect(new AdvisorStore().snapshot().history).toHaveLength(1);
	});

	it("is cleared from the device by a sign-out", () => {
		const store = new AdvisorStore();
		store.addHistory(entry("a"));
		store.forgetAll();
		expect(window.localStorage.getItem(KEY)).toBeNull();
		expect(new AdvisorStore().snapshot().history).toEqual([]);
	});

	it("ignores what is not a well-formed entry", () => {
		window.localStorage.setItem(KEY, JSON.stringify([null, 5, { id: "x" }, { ...entry("bad"), at: "now" }, { ...entry("ok"), unavailable: "weird" }]));
		const history = new AdvisorStore().snapshot().history;
		expect(history.map((h) => h.id)).toEqual(["ok"]);
		expect(history[0]?.unavailable).toBe("");
	});

	it("starts empty on unreadable storage", () => {
		window.localStorage.setItem(KEY, "{not json");
		expect(new AdvisorStore().snapshot().history).toEqual([]);
	});
});

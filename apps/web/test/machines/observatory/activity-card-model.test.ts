// The activity card's model: its subject by priority (a permission request,
// the newest running call, the call that just ended held 1.6 s after its end,
// thinking, idle with the last job), the runtime this time against the p95
// of the session's earlier calls of the same kind (the current one never in
// its own history), the turn's journey folded, the content read for the card,
// and the districts' boards.
import { describe, expect, it } from "vitest";
import { activityCardOf, DONE_HOLD_MS, journeyOf, parseToolContent } from "../../../src/machines/observatory/activity-card-model.ts";
import { districtBoardOf } from "../../../src/machines/observatory/district-board-model.ts";
import { played } from "../../observatory/render-fixtures.ts";
import { api, lifecycle, prompt, subagent, T0, tool } from "./live-map-fixtures.ts";

const read = (use: string, ms: number, took?: number, ok = true) => tool(use, ms, { target: `src/${use}.ts`, ...(took === undefined ? {} : { success: ok, durationMs: took }) });

describe("the card's subject", () => {
	it("is a permission request first, even while a call runs", () => {
		const { state } = played([prompt(1, 0), read("r1", 10), lifecycle("permission_request", "q", 20, { station: "SANDBOX", label: "Bash" })]);
		const card = activityCardOf(state, T0 + 2_020);
		expect(card.subject).toMatchObject({ kind: "wait", what: "Bash", waitingMs: 2_000, eventId: "event:q" });
		expect(card.status).toBe("wait");
	});

	it("is the newest running call, with its runtime so far", () => {
		const { state } = played([prompt(1, 0), read("r1", 10), tool("b1", 500, { toolName: "Bash", station: "SANDBOX", target: "pnpm" })]);
		const card = activityCardOf(state, T0 + 1_500);
		expect(card.subject.kind).toBe("run");
		if (card.subject.kind !== "run") return;
		expect(card.subject.call).toMatchObject({ eventId: "tool:b1", place: "sandbox", tool: "Bash", running: true, runtimeMs: 1_000 });
		expect(card.status).toBe("run");
		expect(card.ticking).toBe(true);
	});

	it("holds the call that ended for 1.6 s after its END, then shows thinking", () => {
		const { state } = played([prompt(1, 0), read("r1", 10, 5_000)]);
		const end = T0 + 10 + 5_000;
		const held = activityCardOf(state, end + DONE_HOLD_MS - 10);
		expect(held.subject.kind).toBe("done");
		expect(held.status).toBe("ok");
		expect(activityCardOf(state, end + DONE_HOLD_MS + 10).subject.kind).toBe("think");
	});

	it("shows a failed call as an error", () => {
		const { state } = played([prompt(1, 0), read("r1", 10, 100, false)]);
		expect(activityCardOf(state, T0 + 200).status).toBe("err");
	});

	it("counts the API requests while thinking, and is idle with the last job after the turn", () => {
		const thinking = played([prompt(1, 0), api("a1", 100), api("a2", 200)]).state;
		const card = activityCardOf(thinking, T0 + 10_000);
		expect(card.subject).toMatchObject({ kind: "think", apiTurns: 2 });
		const idle = played([prompt(1, 0), read("r1", 10, 200), lifecycle("stop", "s", 400)]).state;
		const after = activityCardOf(idle, T0 + 60_000);
		expect(after.subject.kind).toBe("idle");
		if (after.subject.kind === "idle") expect(after.subject.last?.eventId).toBe("tool:r1");
		expect(after.ticking).toBe(false);
	});

	it("names a subagent's call", () => {
		const { state } = played([prompt(1, 0), subagent("ag", 5), tool("r1", 10, { agentId: "ag" })]);
		const card = activityCardOf(state, T0 + 100);
		if (card.subject.kind !== "run") throw new Error("not running");
		expect(card.subject.call.agent).toBe("Explore");
	});
});

describe("the p95 history", () => {
	it("excludes the current run, running or ended, and counts the earlier ones", () => {
		const earlier = [read("a", 0, 100), read("b", 200, 200), read("c", 500, 300)];
		const running = activityCardOf(played([prompt(1, -10), ...earlier, read("d", 1_000)]).state, T0 + 1_400);
		if (running.subject.kind !== "run") throw new Error("not running");
		expect(running.subject.call.history).toEqual({ p95Ms: 300, count: 3 });
		expect(running.subject.call.overP95).toBe(true);
		const ended = activityCardOf(played([prompt(1, -10), ...earlier, read("d", 1_000, 10_000)]).state, T0 + 11_000);
		if (ended.subject.kind !== "done") throw new Error("not done");
		expect(ended.subject.call.history).toEqual({ p95Ms: 300, count: 3 });
		expect(ended.subject.call.runtimeMs).toBe(10_000);
		expect(ended.calls).toBe(4);
	});

	it("is none on the first call of its kind, and kept apart per release step", () => {
		const first = activityCardOf(played([prompt(1, 0), read("a", 10)]).state, T0 + 50);
		if (first.subject.kind !== "run") throw new Error("not running");
		expect(first.subject.call.history).toBeNull();
		const git = activityCardOf(
			played([prompt(1, 0), tool("c", 10, { station: "GIT", stationFlags: 1, success: true, durationMs: 400 }), tool("p", 500, { station: "GIT", stationFlags: 2 })]).state,
			T0 + 600,
		);
		if (git.subject.kind !== "run") throw new Error("not running");
		expect(git.subject.call.step).toBe("push");
		expect(git.subject.call.history).toBeNull();
	});
});

describe("the journey", () => {
	it("goes through the turn's districts, folding repeats and marking failures, the last 12", () => {
		const { state } = played([prompt(1, 0), read("a", 10, 10), read("b", 30, 10), read("c", 50, 10, false), api("x", 70), tool("t", 90, { station: "TESTING" }), lifecycle("permission_request", "q", 100, { station: "SANDBOX" })]);
		expect(journeyOf(state.log)).toEqual([
			{ place: "core", count: 1, failed: false },
			{ place: "files", count: 3, failed: true },
			{ place: "core", count: 1, failed: false },
			{ place: "testing", count: 1, failed: false },
			{ place: "security", count: 1, failed: false },
		]);
		const many = played([prompt(1, 0), ...Array.from({ length: 30 }, (_, i) => tool(`t${i}`, 10 + i, { station: i % 2 === 0 ? "FILES" : "SANDBOX" }))]).state;
		expect(journeyOf(many.log)).toHaveLength(12);
	});

	it("starts again at a new prompt", () => {
		const { state } = played([prompt(1, 0), read("a", 10, 10), prompt(2, 100), tool("t", 110, { station: "TESTING" })]);
		expect(journeyOf(state.log).map((s) => s.place)).toEqual(["core", "testing"]);
	});
});

describe("the content read for the card", () => {
	it("takes the input's description, the output's last line and the whole output", () => {
		const text = JSON.stringify({ input: JSON.stringify({ command: "pnpm install", description: "Cài dependencies" }), output: "Progress\nDone in 2.6s · 812 packages\n" });
		expect(parseToolContent(text)).toEqual({ description: "Cài dependencies", outputLine: "Done in 2.6s · 812 packages", output: "Progress\nDone in 2.6s · 812 packages" });
	});

	it("reads a description out of an input cut short, falls back to the error, and never throws", () => {
		expect(parseToolContent(JSON.stringify({ input: '{"description":"Chạy test","command":"pnpm te', error: "FAIL a.test.ts\n1 failed, 41 passed" }))).toEqual({ description: "Chạy test", outputLine: "1 failed, 41 passed", output: "FAIL a.test.ts\n1 failed, 41 passed" });
		expect(parseToolContent("not json\nlast")).toEqual({ description: "", outputLine: "last", output: "not json\nlast" });
		expect(parseToolContent("null")).toEqual({ description: "", outputLine: "", output: "" });
	});
});

describe("a district's board", () => {
	it("lists the running calls first then the newest ended, up to its rows", () => {
		const { state } = played([prompt(1, 0), read("a", 10, 10), read("b", 30, 10), read("c", 50, 10), read("d", 70, 10), read("e", 90, 10), read("f", 200)]);
		const board = districtBoardOf(state, "files", T0 + 500);
		if (board.kind !== "calls") throw new Error("not calls");
		expect(board.rows.map((r) => r.eventId)).toEqual(["tool:f", "tool:e", "tool:d", "tool:c"]);
		expect(board.rows[0]).toMatchObject({ running: true, runtimeMs: 300 });
	});

	it("shows the model's last request at the core, the drones at their area, the context at the reservoir", () => {
		const { state } = played([prompt(1, 0), api("a", 10), subagent("ag", 20)]);
		expect(districtBoardOf(state, "core", T0)).toMatchObject({ kind: "model", apiTurns: 1 });
		expect(districtBoardOf(state, "orchestrator", T0)).toEqual({ kind: "subagents", running: ["Explore"] });
		expect(districtBoardOf(state, "monitoring", T0).kind).toBe("context");
	});
});

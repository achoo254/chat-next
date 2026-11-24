// The Live Map's state from a session's events: the same scene from a
// snapshot or event by event, whatever the arrival order of a provisional
// event and its stored version; unknown stations at the core; unknown kinds
// moving seq only; the watch's epoch and seq rules; and the animations queued.
import { describe, expect, it } from "vitest";
import {
	ANIMATION_CAP,
	applyEvents,
	foldScene,
	emptyScene,
	coreOf,
	fromSnapshot,
	LOG_CAP,
	parseTodoCounts,
	reduce,
	REORDER_WINDOW_MS,
	takeAnimations,
	withEarlier,
	type LiveMapState,
} from "../../../src/machines/observatory/live-map-state.ts";
import type { LiveMapEvent } from "../../../src/machines/observatory/live-map-types.ts";
import { api, bottleneck, info, lifecycle, numbered, prompt, snapshot, subagent, tool, unknown } from "./live-map-fixtures.ts";

/** Everything but the animations queued on the way. */
const settled = (s: LiveMapState) => ({ ...s, animations: [] });

const start = (seq = 0) => fromSnapshot(snapshot([], { seq }));

/** Applies `events` one frame each, failing on a gap. */
function live(state: LiveMapState, events: readonly LiveMapEvent[]): LiveMapState {
	let s = state;
	for (const e of events) {
		const next = applyEvents(s, s.epoch, [e]);
		expect(next.needSnapshot).toBe(false);
		s = next.state;
	}
	return s;
}

const session = [
	prompt(1, 0),
	api("a1", 100),
	tool("t1", 200, { success: true, durationMs: 40 }),
	tool("t2", 300, { station: "SANDBOX", toolName: "Bash" }),
	subagent("ag1", 400),
	tool("t3", 500, { agentId: "ag1", station: "TESTING", success: false }),
	tool("t4", 600, { mcpServer: "github", toolName: "mcp__github__get", station: "MCP", success: true }),
	lifecycle("todo_counts", "todo1", 700, { label: "2/1/3" }),
	lifecycle("stop", "stop1", 800),
];

describe("the Live Map state", () => {
	it("is the same from a snapshot as event by event", () => {
		const fromSnap = fromSnapshot(snapshot(session, { seq: session.length }));
		const byEvent = live(start(), numbered(session));
		expect(settled(byEvent)).toEqual(settled(fromSnap));
		expect(fromSnap.animations).toEqual([]);
	});

	it("is the same with a provisional event and its stored version out of order as with the stored version alone", () => {
		const stored = tool("t9", 250, { station: "GIT", toolName: "Bash", success: true, durationMs: 900 });
		const provisional = tool("t9", 250, { station: "GIT", toolName: "Bash", provisional: true });
		const onlyStored = live(start(), numbered([...session.slice(0, 3), stored, ...session.slice(3)]));
		// The provisional one first, the rest, then the stored one late (after newer events).
		const mixed = live(start(), numbered([...session.slice(0, 3), provisional, ...session.slice(3), stored]));
		expect(settled(mixed).scene).toEqual(settled(onlyStored).scene);
		expect(mixed.log.map((e) => e.id)).toEqual(onlyStored.log.map((e) => e.id));
		expect(mixed.log.find((e) => e.id === "tool:t9")).toMatchObject({ provisional: false, success: true });
	});

	it("orders events by time then id, whatever order they arrive in", () => {
		const shuffled = [session[4], session[0], session[8], session[2], session[1], session[7], session[3], session[6], session[5]].filter((e): e is LiveMapEvent => e !== undefined);
		const a = live(start(), numbered(shuffled));
		const b = live(start(), numbered(session));
		expect(a.scene).toEqual(b.scene);
		expect(a.log.map((e) => e.id)).toEqual(b.log.map((e) => e.id));
		// Two events in the same millisecond: by id.
		const same = live(start(), numbered([tool("b", 10), tool("a", 10)]));
		expect(same.log.map((e) => e.id)).toEqual(["tool:a", "tool:b"]);
	});

	it("places a station it does not know at the core", () => {
		const s = live(start(), numbered([tool("x", 0, { station: "LIBRARY" }), tool("y", 10, { station: "", success: true })]));
		expect(s.scene.stations.CORE.running).toEqual(["tool:x"]);
		expect(s.scene.stations.CORE.calls).toBe(1);
	});

	it("moves seq on for an event of a kind it does not know, and nothing else", () => {
		const before = live(start(), numbered(session));
		const after = applyEvents(before, before.epoch, [unknown(900, before.seq + 1)]);
		expect(after.needSnapshot).toBe(false);
		expect(after.state.seq).toBe(before.seq + 1);
		expect({ ...after.state, seq: before.seq }).toEqual(before);
	});

	it("asks for a snapshot on another epoch or a gap in seq, and drops what it has applied", () => {
		const s = live(start(5), numbered([prompt(1, 0)], 6));
		expect(applyEvents(s, 2n, numbered([prompt(2, 10)], 7))).toEqual({ state: s, needSnapshot: true });
		// Already applied: dropped.
		expect(applyEvents(s, 1n, numbered([prompt(2, 10)], 6))).toEqual({ state: s, needSnapshot: false });
		// The events before the gap apply; the rest waits for the snapshot.
		const gap = applyEvents(s, 1n, [prompt(2, 10, 7), prompt(3, 20, 9)]);
		expect(gap.needSnapshot).toBe(true);
		expect(gap.state.seq).toBe(7);
		expect(gap.state.log.map((e) => e.id)).toEqual(["prompt:p1", "prompt:p2"]);
	});

	it("works out the core's state from the events", () => {
		const core = (events: LiveMapEvent[]) => live(start(), numbered(events)).scene.core;
		expect(core([])).toBe("idle");
		expect(core([prompt(1, 0)])).toBe("thinking");
		expect(core([prompt(1, 0), lifecycle("permission_request", "r1", 10, { station: "SANDBOX", label: "Bash" })])).toBe("waiting_permission");
		expect(core([prompt(1, 0), lifecycle("permission_request", "r1", 10, { station: "SANDBOX" }), lifecycle("permission_decision", "d1", 20, { station: "SANDBOX" })])).toBe("thinking");
		// No decision event: the call running at that station answers the request.
		expect(core([prompt(1, 0), lifecycle("permission_request", "r1", 10, { station: "SANDBOX" }), tool("t1", 20, { station: "SANDBOX" })])).toBe("thinking");
		expect(core([prompt(1, 0), lifecycle("compact_start", "c1", 10)])).toBe("compacting");
		expect(core([prompt(1, 0), lifecycle("compact_start", "c1", 10), tool("t1", 15), lifecycle("compact_end", "c2", 20)])).toBe("thinking");
		expect(core([prompt(1, 0), lifecycle("stop", "s1", 10)])).toBe("waiting_user");
		expect(core([prompt(1, 0), lifecycle("stop_failure", "s1", 10)])).toBe("failed");
		expect(core([prompt(1, 0), lifecycle("stop", "s1", 10), prompt(2, 20)])).toBe("thinking");
		// Notifications: a permission prompt waits, an idle prompt ends the turn.
		expect(core([prompt(1, 0), lifecycle("notification", "n1", 10, { label: "permission_prompt" })])).toBe("waiting_permission");
		expect(core([prompt(1, 0), lifecycle("notification", "n1", 10, { label: "idle_prompt" })])).toBe("waiting_user");
		// A compaction outside a turn goes back to waiting for the user, or to idle when nothing had happened.
		expect(core([prompt(1, 0), lifecycle("stop", "s1", 10), lifecycle("compact_start", "c1", 20), lifecycle("compact_end", "c2", 30)])).toBe("waiting_user");
		expect(core([lifecycle("compact_start", "c1", 20), lifecycle("compact_end", "c2", 30)])).toBe("idle");
		// A subagent's API request is not the main thread's.
		expect(core([prompt(1, 0), lifecycle("stop", "s1", 10), api("sub", 20, { agentId: "ag1" })])).toBe("waiting_user");
	});

	it("keeps thinking after the main turn stops while a subagent runs, and waits for the user once it ended", () => {
		const running = live(start(), numbered([prompt(1, 0), subagent("ag1", 5), lifecycle("stop", "s1", 10)]));
		expect(coreOf(running)).toBe("thinking");
		const done = live(start(), numbered([prompt(1, 0), subagent("ag1", 5, 8), lifecycle("stop", "s1", 10)]));
		expect(coreOf(done)).toBe("waiting_user");
		expect(coreOf({ ...running, info: info({ endedAt: running.newestAt }) })).toBe("idle");
	});

	it("is idle once the session ended after its last event", () => {
		const s = live(start(), numbered([prompt(1, 0), lifecycle("stop", "s1", 10)]));
		expect(coreOf(s)).toBe("waiting_user");
		expect(coreOf({ ...s, info: info({ endedAt: s.newestAt }) })).toBe("idle");
		expect(coreOf({ ...s, info: info({ endedAt: s.newestAt - 1 }) })).toBe("waiting_user");
	});

	it("clears the running calls when the turn ends, and never counts a denied or blocked call as running", () => {
		const s = live(start(), numbered([prompt(1, 0), tool("t1", 10), tool("t2", 20, { station: "SANDBOX" }), lifecycle("permission_denied", "d2", 25, { toolUseId: "t2", station: "SANDBOX" })]));
		expect(s.scene.stations.FILES.running).toEqual(["tool:t1"]);
		expect(s.scene.stations.SANDBOX.running).toEqual([]);
		// The denied call's stored version after the denial still does not run.
		const again = live(s, numbered([tool("t3", 30, { station: "SANDBOX" }), lifecycle("hook_block", "b3", 31, { toolUseId: "t3", station: "SANDBOX" })], s.seq + 1));
		expect(again.scene.stations.SANDBOX.running).toEqual([]);
		const stopped = live(again, numbered([lifecycle("stop", "s1", 40)], again.seq + 1));
		expect(stopped.scene.stations.FILES.running).toEqual([]);
	});

	it("ends the turn at a call the person interrupted (Esc or Ctrl+C sends no Stop), not at a call that failed on its own", () => {
		const running = live(start(), numbered([prompt(1, 0), tool("t1", 10), tool("t2", 20, { station: "SANDBOX", toolName: "Bash" })]));
		const interrupted = live(running, numbered([tool("t2", 20, { station: "SANDBOX", toolName: "Bash", success: false, durationMs: 400, error: "interrupted" })], running.seq + 1));
		expect(interrupted.scene).toMatchObject({ core: "waiting_user", inTurn: false });
		expect(interrupted.scene.stations.FILES.running).toEqual([]);
		expect(interrupted.scene.stations.SANDBOX).toMatchObject({ running: [], calls: 1, failures: 1 });
		const failed = live(running, numbered([tool("t2", 20, { station: "SANDBOX", toolName: "Bash", success: false, durationMs: 400, error: "failed" })], running.seq + 1));
		expect(failed.scene.core).toBe("thinking");
		expect(failed.scene.stations.FILES.running).toEqual(["tool:t1"]);
	});

	it("takes the main agent's speed over its whole duration when the first token's time is unknown, and keeps it past a request without numbers", () => {
		const base = { kind: "api", agentId: "", model: "claude-opus", seq: 0, provisional: false } as const;
		const noTtft: LiveMapEvent = { ...base, id: "api:a1", at: 0, outputTokens: 300, durationMs: 1_500 };
		const noNumbers: LiveMapEvent = { ...base, id: "api:a2", at: 10 };
		const s = live(start(), numbered([noTtft, noNumbers]));
		expect(s.scene.tokensPerSecond).toBeCloseTo(200);
	});

	it("reads no speed from a request that streamed for a few milliseconds, and falls back on its whole duration when only the stretch after the first token is that short", () => {
		const base = { kind: "api", agentId: "", model: "claude-opus", seq: 0, provisional: false } as const;
		const speed = (over: { durationMs: number; ttftMs: number }): number | null => {
			const e: LiveMapEvent = { ...base, id: "api:s", at: 0, outputTokens: 100, ...over };
			return live(start(), numbered([e])).scene.tokensPerSecond;
		};
		expect(speed({ durationMs: 3, ttftMs: 0 })).toBeNull();
		expect(speed({ durationMs: 5_000, ttftMs: 4_998 })).toBe(20);
		expect(speed({ durationMs: 3_000, ttftMs: 1_000 })).toBe(50);
	});

	it("keeps each station's running calls, queue, latest call, counts and failures", () => {
		const s = live(
			start(),
			numbered([
				prompt(1, 0),
				lifecycle("permission_request", "r1", 5, { station: "GIT" }),
				lifecycle("permission_request", "r2", 6, { station: "GIT" }),
				tool("t1", 10, { success: true }),
				tool("t2", 20, { success: false }),
				tool("t3", 30),
			]),
		);
		expect(s.scene.stations.FILES).toEqual({ running: ["tool:t3"], queued: 0, last: "tool:t2", calls: 2, failures: 1, bottleneck: "none" });
		expect(s.scene.stations.GIT.queued).toBe(2);
		// A call ran after the requests: the machine's rule says thinking.
		expect(s.scene.core).toBe("thinking");
		// The call ends: its stored version replaces the running one.
		const ended = live(s, numbered([tool("t3", 30, { success: true })], s.seq + 1));
		expect(ended.scene.stations.FILES).toMatchObject({ running: [], last: "tool:t3", calls: 3 });
	});

	it("keeps subagents at the station of their latest call, MCP wires per server, the to-do board and the main model's speed", () => {
		const s = live(start(), numbered(session));
		expect(s.scene.subagents.ag1).toEqual({ agentId: "ag1", agentType: "Explore", running: true, station: "TESTING" });
		expect(s.scene.mcp.github).toEqual({ server: "github", running: 0, calls: 1, failures: 0 });
		expect(s.scene.todo).toEqual({ pending: 2, inProgress: 1, done: 3 });
		expect(s.scene.model).toBe("claude-opus");
		// 500 tokens over 3 000 ms less 500 ms to the first token.
		expect(s.scene.tokensPerSecond).toBeCloseTo(200);
		const done = live(s, numbered([subagent("ag1", 400, 2_000)], s.seq + 1));
		expect(done.scene.subagents.ag1?.running).toBe(false);
		// A subagent's own API request does not change the main agent's model.
		expect(live(s, numbered([api("sub", 900, { agentId: "ag1", model: "claude-haiku" })], s.seq + 1)).scene.model).toBe("claude-opus");
		expect(parseTodoCounts("garbled")).toBeNull();
	});

	it("raises a station's bottleneck level while a finding is open, alert over warn", () => {
		const s = live(start(), numbered([bottleneck("slow", 0, "SANDBOX", "warn", true), bottleneck("loop", 10, "SANDBOX", "alert", true)]));
		expect(s.scene.stations.SANDBOX.bottleneck).toBe("alert");
		const closed = live(s, numbered([bottleneck("loop", 10, "SANDBOX", "alert", false)], s.seq + 1));
		expect(closed.scene.stations.SANDBOX.bottleneck).toBe("warn");
		const none = live(closed, numbered([bottleneck("slow", 0, "SANDBOX", "warn", false)], closed.seq + 1));
		expect(none.scene.stations.SANDBOX.bottleneck).toBe("none");
	});

	it("queues an animation per event with its id, plays a call's end once, and not late news", () => {
		let s = live(start(), numbered([prompt(1, 0), tool("t1", 100, { provisional: true })]));
		expect(s.animations).toEqual([
			{ eventId: "prompt:p1", station: "CORE", cue: "prompt" },
			{ eventId: "tool:t1", station: "FILES", cue: "tool-start" },
		]);
		// The stored version of a call still running: nothing new to play.
		s = live(s, numbered([tool("t1", 100)], s.seq + 1));
		expect(s.animations).toHaveLength(2);
		s = live(s, numbered([tool("t1", 100, { success: true })], s.seq + 1));
		expect(s.animations.at(-1)).toEqual({ eventId: "tool:t1", station: "FILES", cue: "tool-end" });
		// An event older than the window behind the newest one counts but does not play.
		s = live(s, numbered([prompt(2, 10_000), tool("late", 10_000 - REORDER_WINDOW_MS - 1, { success: true })], s.seq + 1));
		expect(s.animations.map((a) => a.eventId)).not.toContain("tool:late");
		expect(s.scene.stations.FILES.calls).toBe(2);
		const [taken, rest] = takeAnimations(s);
		expect(taken.length).toBeGreaterThan(0);
		expect(rest.animations).toEqual([]);
		expect(rest.scene).toBe(s.scene);
	});

	it("keeps at most ANIMATION_CAP animations when nothing takes them", () => {
		const events = Array.from({ length: ANIMATION_CAP + 10 }, (_, i) => prompt(i, i));
		const s = live(start(), numbered(events));
		expect(s.animations).toHaveLength(ANIMATION_CAP);
		expect(s.animations[0]?.eventId).toBe("prompt:p10");
	});

	it("folds events past LOG_CAP into its base scene without changing the scene", () => {
		const events = Array.from({ length: LOG_CAP + 50 }, (_, i) => tool(`t${i}`, i * 10, { success: i % 7 !== 0 }));
		const s = fromSnapshot(snapshot(events, { seq: 1 }));
		expect(s.log).toHaveLength(LOG_CAP);
		expect(s.floor).toEqual({ at: events[49]?.at, id: "tool:t49" });
		expect(s.scene).toEqual(foldScene(emptyScene(), events));
		// An event older than what is kept no longer changes anything.
		const late = live(s, numbered([tool("t0", 0, { success: true })], 2));
		expect(late.scene).toEqual(s.scene);
	});

	it("places a page of older events in order without animating or moving seq", () => {
		const s = live(start(), numbered(session.slice(4)));
		const paged = withEarlier(s, session.slice(0, 4), "");
		expect(paged.seq).toBe(s.seq);
		expect(paged.animations).toEqual(s.animations);
		expect(paged.scene).toEqual(live(start(), numbered(session)).scene);
		expect(paged.earlier).toBe("");
	});

	it("takes the session's row and live state from a snapshot and a session event, the window's assumption included", () => {
		const liveState = {
			core: "thinking" as const,
			tokensPerSecond: 50,
			contextPercent: 40,
			contextTokens: 80_000,
			contextWindow: 200_000,
			contextWindowAssumed: true,
			mainModel: "claude-sonnet-5-5",
			running: [{ station: "FILES", count: 1 }],
			openBottlenecks: 0,
		};
		const s = fromSnapshot(snapshot([], { info: null, live: liveState }));
		expect(s.live?.contextWindowAssumed).toBe(true);
		const next = reduce(s, { kind: "session", info: snapshot([]).info, live: { ...liveState, contextWindow: 1_000_000, contextWindowAssumed: false }, id: "session", at: 0, seq: 1, provisional: false });
		expect(next.info?.projectKey).toBe("github.com/acme/app");
		expect(next.live).toMatchObject({ contextWindow: 1_000_000, contextWindowAssumed: false });
		expect(next.log).toEqual([]);
	});
});

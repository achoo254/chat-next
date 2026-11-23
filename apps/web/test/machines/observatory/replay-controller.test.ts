// Replaying a session: the scene rebuilt at any moment equals the scene a live
// view showed at that moment, on a generated session of more than 2 000
// events where provisional versions come first and stored ones later and out
// of order; the history built from a snapshot and older pages gives the same;
// a later version of an id replaces the earlier one (a provisional end after
// the stored start), a call interrupted by the person ends the turn; findings open and
// close by their own times; the context's fill follows the machine's rule;
// playing squeezes long silences; the cap, the checkpoints, the timeline and
// the cursor.
import { describe, expect, it } from "vitest";
import { coreOf, fromSnapshot, reduce, type LiveMapState } from "../../../src/machines/observatory/live-map-state.ts";
import type { LiveMapEvent } from "../../../src/machines/observatory/live-map-types.ts";
import { contextWindowOf, LONG_WINDOW, STANDARD_WINDOW } from "../../../src/machines/observatory/model-window.ts";
import {
	advance,
	CHECKPOINT_EVERY,
	cursorAt,
	detailsExpired,
	DETAIL_RETENTION_MS,
	eventStep,
	focusedAt,
	goLive,
	historyOf,
	LIVE_CURSOR,
	marksOf,
	needsEarlier,
	nextSpeed,
	pageBack,
	played,
	REPLAY_BUFFER_CAP,
	SILENCE_PLAYED_MS,
	stateAt,
	timelineOf,
	togglePlay,
	withLive,
	withPage,
	type ReplayHistory,
} from "../../../src/machines/observatory/replay-controller.ts";
import { api, info, lifecycle, prompt, snapshot, subagent, T0, tool } from "./live-map-fixtures.ts";

type ApiWithContext = Extract<LiveMapEvent, { kind: "api" }> & { readonly contextTokens: number };

const apiWith = (key: string, ms: number, contextTokens: number, over: Partial<Extract<LiveMapEvent, { kind: "api" }>> = {}): ApiWithContext => {
	const e = api(key, ms, over);
	if (e.kind !== "api") throw new Error("api fixture");
	return { ...e, contextTokens };
};

/** A small deterministic random source (mulberry32). */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Arrival {
	readonly t: number;
	readonly order: number;
	readonly e: LiveMapEvent;
}

const STATIONS = ["FILES", "SANDBOX", "TESTING", "GIT", "MCP", "EXTERNAL", "SKILLS", "MEMORY"] as const;

/**
 * A working session as the machine sends it: every event's provisional
 * version arrives at its own time (a tool's end at its end), the stored
 * version later after a random delay (so stored versions of neighbours cross
 * each other), carrying what was known when it arrived. Findings open, a few
 * are raised (and stay open), others close.
 */
function session(minEvents: number, seed: number): { arrivals: Arrival[]; finals: Map<string, LiveMapEvent>; end: number } {
	const r = random(seed);
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
	const arrivals: Arrival[] = [];
	const finals = new Map<string, LiveMapEvent>();
	let order = 0;
	const arrive = (t: number, e: LiveMapEvent): void => {
		arrivals.push({ t, order: order++, e });
		finals.set(e.id, e);
	};
	/** The provisional version now, the stored one after a delay. */
	const provisionalThenStored = (e: LiveMapEvent): void => {
		arrive(e.at - T0, { ...e, provisional: true });
		arrive(e.at - T0 + Math.floor(r() * 8_000), { ...e, provisional: false });
	};
	let ms = 1_000;
	let n = 0;
	let context = 20_000;
	while (finals.size < minEvents) {
		n += 1;
		provisionalThenStored(prompt(n, ms));
		const ops = 3 + Math.floor(r() * 12);
		for (let i = 0; i < ops; i++) {
			ms += 100 + Math.floor(r() * 2_500);
			const kind = r();
			const key = `${n}-${i}`;
			if (kind < 0.45) {
				const station = pick(STATIONS);
				const duration = 50 + Math.floor(r() * 4_000);
				const success = r() > 0.1;
				// Some failures are the person interrupting the turn (Esc, Ctrl+C): the turn ends with them.
				const error = success ? undefined : r() < 0.3 ? "interrupted" : "failed";
				const over = { station, durationMs: duration, success, ...(error === undefined ? {} : { error }), ...(station === "MCP" ? { mcpServer: pick(["s1", "s2"]) } : {}) };
				const start = tool(key, ms, { station, ...(station === "MCP" ? { mcpServer: over.mcpServer } : {}), provisional: true });
				const ended = tool(key, ms, over);
				arrive(ms, start);
				// The store took the call while it ran: its stored version (not provisional) says it runs.
				const early = ms + Math.floor(r() * 3_000);
				if (early < ms + duration) arrive(early, { ...start, provisional: false });
				// The spool's tail reads its end before the store has it: a provisional version after the stored one.
				arrive(ms + duration, { ...ended, provisional: true });
				arrive(ms + duration + Math.floor(r() * 8_000), ended);
			} else if (kind < 0.6) {
				context += Math.floor(r() * 4_000);
				const sub = r() < 0.3 ? "a1" : "";
				provisionalThenStored(apiWith(key, ms, context, { agentId: sub, model: "claude-sonnet-5-5", outputTokens: 100 + Math.floor(r() * 900), durationMs: 1_000 + Math.floor(r() * 4_000) }));
			} else if (kind < 0.7) {
				provisionalThenStored(lifecycle("permission_request", `${key}-q`, ms, { station: "SANDBOX" }));
				ms += 300 + Math.floor(r() * 2_000);
				provisionalThenStored(lifecycle(r() < 0.8 ? "permission_decision" : "permission_denied", `${key}-d`, ms, { station: "SANDBOX" }));
			} else if (kind < 0.78) {
				const endedAt = T0 + ms + 2_000 + Math.floor(r() * 15_000);
				const started = subagent(`sa${key}`, ms);
				arrive(ms, { ...started, provisional: true });
				arrive(ms + 500, started);
				const stopped = subagent(`sa${key}`, ms, endedAt);
				arrive(endedAt - T0, stopped);
			} else if (kind < 0.84) {
				provisionalThenStored(lifecycle("compact_start", `${key}-cs`, ms));
				ms += 500 + Math.floor(r() * 3_000);
				provisionalThenStored(lifecycle("compact_end", `${key}-ce`, ms));
			} else if (kind < 0.9) {
				provisionalThenStored(lifecycle("todo_counts", `${key}-todo`, ms, { station: "ORCHESTRATOR", label: `${Math.floor(r() * 5)}/${Math.floor(r() * 2)}/${Math.floor(r() * 5)}` }));
			} else if (kind < 0.95) {
				const station = pick(STATIONS);
				const opened = T0 + ms;
				const base = { kind: "bottleneck" as const, rule: "tool_slow", subkey: key, station, evidenceIds: [`tool:${key}`], seq: 0, id: `bottleneck:tool_slow:${key}`, at: opened, provisional: false };
				const open = { ...base, severity: "warn" as const, open: true, openedAt: opened, updatedAt: opened, closedAt: 0 };
				arrive(ms, open);
				if (r() < 0.5) {
					const closedAt = opened + 1_000 + Math.floor(r() * 20_000);
					arrive(closedAt - T0, { ...open, open: false, updatedAt: closedAt, closedAt });
				} else {
					// Raised and still open at the end: the time of the change is kept.
					const raisedAt = opened + 1_000 + Math.floor(r() * 20_000);
					arrive(raisedAt - T0, { ...open, severity: "alert", updatedAt: raisedAt });
				}
			} else {
				provisionalThenStored(lifecycle("notification", `${key}-n`, ms, { label: r() < 0.5 ? "permission_prompt" : "idle_prompt" }));
			}
		}
		ms += 200 + Math.floor(r() * 1_000);
		provisionalThenStored(lifecycle(r() < 0.95 ? "stop" : "stop_failure", `${n}-stop`, ms));
		// Thinking time between turns, sometimes a long silence.
		ms += r() < 0.2 ? 15_000 + Math.floor(r() * 60_000) : 500 + Math.floor(r() * 5_000);
	}
	arrivals.sort((a, b) => a.t - b.t || a.order - b.order);
	const last = arrivals[arrivals.length - 1];
	return { arrivals, finals, end: last === undefined ? T0 : T0 + last.t };
}

/** The live view at each sample moment: every arrival up to it applied in arrival order. */
function liveScenes(arrivals: readonly Arrival[], every: number): { at: number; state: LiveMapState }[] {
	let state = fromSnapshot(snapshot([], { info: info() }));
	const out: { at: number; state: LiveMapState }[] = [];
	arrivals.forEach((a, i) => {
		state = reduce(state, a.e);
		const next = arrivals[i + 1];
		// Sample only once every arrival of this millisecond is in.
		if (i % every === 0 && (next === undefined || next.t !== a.t)) out.push({ at: T0 + a.t, state });
	});
	return out;
}

const ordered = (events: Iterable<LiveMapEvent>): LiveMapEvent[] => [...events].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

describe("replaying a session", () => {
	const { arrivals, finals } = session(2_200, 7);
	const samples = liveScenes(arrivals, 23);

	it("generates a session of more than 2 000 events with provisional versions first", () => {
		expect(finals.size).toBeGreaterThan(2_000);
		const firstProvisional = new Map<string, boolean>();
		for (const a of arrivals) if (!firstProvisional.has(a.e.id)) firstProvisional.set(a.e.id, a.e.provisional);
		expect([...firstProvisional.values()].filter(Boolean).length).toBeGreaterThan(1_500);
		expect(samples.length).toBeGreaterThan(200);
	});

	it("rebuilds from the arrivals the scene a live view showed at every sampled moment", () => {
		let history = historyOf(snapshot([], { info: info() }));
		let i = 0;
		for (const sample of samples) {
			const batch: LiveMapEvent[] = [];
			while (i < arrivals.length && T0 + (arrivals[i]?.t ?? 0) <= sample.at) batch.push((arrivals[i++] as Arrival).e);
			history = withLive(history, batch);
			const replayed = stateAt(history, sample.at);
			expect(replayed.scene).toEqual(sample.state.scene);
			expect(coreOf(replayed)).toBe(coreOf(sample.state));
		}
		// The rest arrives: every earlier moment still replays the same.
		history = withLive(
			history,
			arrivals.slice(i).map((a) => a.e),
		);
		for (const sample of samples) expect(stateAt(history, sample.at).scene).toEqual(sample.state.scene);
	});

	it("rebuilds the same from the stored events: the snapshot's newest, then older pages", async () => {
		const stored = ordered(finals.values());
		const PAGE = 500;
		const cursorOf = (end: number): string => (end <= 0 ? "" : `before:${end}`);
		const first = snapshot(stored.slice(-PAGE), { info: info(), earlier: cursorOf(stored.length - PAGE) });
		const asked: string[] = [];
		const page = (earlier: string): Promise<{ events: LiveMapEvent[]; earlier: string }> => {
			asked.push(earlier);
			const end = Number(earlier.slice("before:".length));
			return Promise.resolve({ events: stored.slice(Math.max(0, end - PAGE), end), earlier: cursorOf(end - PAGE) });
		};
		const start = historyOf(first);
		expect(needsEarlier(start)).toBe(true);
		const history = await pageBack(start, page);
		expect(needsEarlier(history)).toBe(false);
		expect(asked.length).toBe(Math.ceil((stored.length - PAGE) / PAGE));
		expect(history.events.length).toBe(stored.length);
		expect(history.checkpoints.map((c) => c.index)).toEqual(Array.from({ length: Math.floor(stored.length / CHECKPOINT_EVERY) + 1 }, (_, k) => k * CHECKPOINT_EVERY));
		for (const sample of samples) {
			const replayed = stateAt(history, sample.at);
			expect(replayed.scene).toEqual(sample.state.scene);
			expect(replayed.animations).toEqual([]);
		}
	});

	it("stops paging when a page does not move the cursor", async () => {
		const start = historyOf(snapshot([prompt(1, 10)], { earlier: "x" }));
		const history = await pageBack(start, () => Promise.resolve({ events: [], earlier: "x" }));
		expect(needsEarlier(history)).toBe(false);
	});
});

describe("versions of one event", () => {
	it("takes the later version of an id, as the live view does: a provisional end after the stored start, a stored version after a provisional one", () => {
		const storedRunning = tool("t1", 1_000);
		const provisionalEnded = tool("t1", 1_000, { success: true, durationMs: 200, provisional: true });
		const storedEnded = tool("t1", 1_000, { success: true, durationMs: 200 });
		let h = historyOf(snapshot([prompt(1, 0), storedRunning]));
		h = withLive(h, [provisionalEnded]);
		expect(h.byId.get("tool:t1")).toEqual(provisionalEnded);
		expect(stateAt(h, T0 + 1_500).scene.stations.FILES).toMatchObject({ running: [], calls: 1 });
		h = withLive(h, [storedEnded]);
		expect(h.byId.get("tool:t1")).toEqual(storedEnded);
		h = withPage(historyOf(snapshot([tool("t1", 1_000, { provisional: true })])), [storedEnded], "");
		expect(h.byId.get("tool:t1")).toEqual(storedEnded);
		expect(h.events).toHaveLength(1);
	});

	it("ends the turn at a call interrupted by the person, once it ended, as the live view does", () => {
		const events = [prompt(1, 0), tool("t1", 1_000, { station: "SANDBOX" }), tool("t2", 1_500, { station: "TESTING", success: false, durationMs: 2_000, error: "interrupted" })];
		const h = historyOf(snapshot(events));
		const during = stateAt(h, T0 + 2_000);
		expect(coreOf(during)).toBe("thinking");
		expect(during.scene.stations.TESTING.running).toEqual(["tool:t2"]);
		const after = stateAt(h, T0 + 3_500);
		expect(coreOf(after)).toBe("waiting_user");
		expect(after.scene.stations.SANDBOX.running).toEqual([]);
		expect(after.live).toMatchObject({ core: "waiting_user", running: [] });
		expect(after.scene).toEqual(fromSnapshot(snapshot(events)).scene);
	});

	it("shows a tool call running before its end and ended from then on", () => {
		const h = historyOf(snapshot([prompt(1, 0), tool("t1", 1_000, { success: false, durationMs: 4_000 })]));
		const running = stateAt(h, T0 + 2_000).scene.stations.FILES;
		expect(running.running).toEqual(["tool:t1"]);
		expect(running.calls).toBe(0);
		const ended = stateAt(h, T0 + 5_000).scene.stations.FILES;
		expect(ended).toMatchObject({ running: [], calls: 1, failures: 1, last: "tool:t1" });
		// Before the call, nothing at all.
		expect(stateAt(h, T0 + 500).scene.stations.FILES.running).toEqual([]);
	});

	it("opens a finding at opened_at, closes it at closed_at, and gives the earlier level before a change", () => {
		const opened = T0 + 1_000;
		const closed = { kind: "bottleneck" as const, rule: "repeat_read", subkey: "", station: "FILES", severity: "warn" as const, open: false, openedAt: opened, updatedAt: opened + 5_000, closedAt: opened + 5_000, evidenceIds: [], seq: 0, at: opened, id: "bottleneck:repeat_read:", provisional: false };
		const raised = { ...closed, rule: "tool_slow", station: "MCP", id: "bottleneck:tool_slow:", severity: "alert" as const, open: true, updatedAt: opened + 3_000, closedAt: 0 };
		const h = historyOf(snapshot([closed, raised]));
		const before = stateAt(h, opened - 1);
		expect(before.scene.stations.FILES.bottleneck).toBe("none");
		expect(before.live?.openBottlenecks).toBe(0);
		const during = stateAt(h, opened + 2_000);
		expect(during.scene.stations.FILES.bottleneck).toBe("warn");
		expect(during.scene.stations.MCP.bottleneck).toBe("warn");
		expect(during.live?.openBottlenecks).toBe(2);
		const raisedNow = stateAt(h, opened + 4_000);
		expect(raisedNow.scene.stations.MCP.bottleneck).toBe("alert");
		const after = stateAt(h, opened + 5_000);
		expect(after.scene.stations.FILES.bottleneck).toBe("none");
		expect(after.live?.openBottlenecks).toBe(1);
	});

	it("shows a subagent running until it stopped", () => {
		const h = historyOf(snapshot([subagent("a1", 1_000, T0 + 9_000)]));
		expect(stateAt(h, T0 + 5_000).scene.subagents.a1?.running).toBe(true);
		expect(stateAt(h, T0 + 9_000).scene.subagents.a1?.running).toBe(false);
	});

	it("is idle only once the session ended, not before", () => {
		const h = historyOf(snapshot([prompt(1, 1_000)], { info: info({ endedAt: T0 + 10_000 }) }));
		expect(coreOf(stateAt(h, T0 + 5_000))).toBe("thinking");
		expect(stateAt(h, T0 + 5_000).info?.endedAt).toBe(0);
		expect(coreOf(stateAt(h, T0 + 10_000))).toBe("idle");
	});
});

describe("the session's live state at a moment", () => {
	it("works the context's fill out by the machine's window rule, approximate when assumed", () => {
		const h = historyOf(
			snapshot([
				apiWith("1", 1_000, 50_000, { model: "claude-sonnet-5-5" }),
				apiWith("2", 2_000, 90_000, { model: "claude-sonnet-5-5", agentId: "a1" }),
				apiWith("3", 3_000, 250_000, { model: "claude-sonnet-5-5" }),
				apiWith("4", 4_000, 100_000, { model: "claude-sonnet-5-5" }),
			]),
		);
		const early = stateAt(h, T0 + 2_500).live;
		// A subagent's request is not the main thread's.
		expect(early).toMatchObject({ contextTokens: 50_000, contextWindow: STANDARD_WINDOW, contextWindowAssumed: true, contextPercent: 25, mainModel: "claude-sonnet-5-5" });
		// Once the context went past the standard window, the long one is known.
		expect(stateAt(h, T0 + 4_000).live).toMatchObject({ contextTokens: 100_000, contextWindow: LONG_WINDOW, contextWindowAssumed: false, contextPercent: 10 });
	});

	it("has no percent for a model that is not a Claude model id, or a request that did not say its context", () => {
		expect(stateAt(historyOf(snapshot([apiWith("1", 1_000, 50_000, { model: "gpt-5" })])), T0 + 2_000).live?.contextPercent).toBeNull();
		const unsaid = stateAt(historyOf(snapshot([api("1", 1_000, { model: "claude-opus-5-5" })])), T0 + 2_000).live;
		expect(unsaid).toMatchObject({ contextPercent: null, contextWindow: STANDARD_WINDOW, contextWindowAssumed: true });
	});

	it("takes the session's own model before any request, and counts running calls by station", () => {
		const h = historyOf(snapshot([prompt(1, 0), tool("t1", 1_000, { station: "SANDBOX" }), tool("t2", 1_100)], { info: info({ mainModel: "claude-opus-5-5" }) }));
		expect(stateAt(h, T0 + 2_000).live).toMatchObject({
			core: "thinking",
			mainModel: "claude-opus-5-5",
			running: [
				{ station: "FILES", count: 1 },
				{ station: "SANDBOX", count: 1 },
			],
		});
	});

	it("mirrors the machine's model windows", () => {
		expect(contextWindowOf("claude-sonnet-5-5")).toEqual({ tokens: STANDARD_WINDOW, assumed: true });
		expect(contextWindowOf("claude-haiku-4-5-20251001")).toEqual({ tokens: STANDARD_WINDOW, assumed: true });
		expect(contextWindowOf("claude-opus-5-5[1m]")).toEqual({ tokens: LONG_WINDOW, assumed: false });
		expect(contextWindowOf("claude-sonnet-5-5", STANDARD_WINDOW + 1)).toEqual({ tokens: LONG_WINDOW, assumed: false });
		for (const unknown of ["", null, "sonnet", "gpt-5", "claude-opus-4-6-thinking", "claude-sonnet-x"]) expect(contextWindowOf(unknown)).toBeUndefined();
	});
});

describe("the buffer", () => {
	const many = (n: number, from = 0): LiveMapEvent[] => Array.from({ length: n }, (_, i) => prompt(from + i, (from + i) * 10));

	it("stops paging back at the cap and starts the replay at the oldest event held", () => {
		const newest = many(REPLAY_BUFFER_CAP - 100, 200);
		const h = withPage(historyOf(snapshot(newest, { earlier: "more" })), many(200), "older");
		expect(h.events).toHaveLength(REPLAY_BUFFER_CAP);
		expect(h.partial).toBe(true);
		expect(needsEarlier(h)).toBe(false);
		expect(timelineOf(h).start).toBe(h.events[0]?.at);
	});

	it("folds the oldest live events into the base past the cap and keeps the scene", () => {
		let h: ReplayHistory = historyOf(snapshot(many(REPLAY_BUFFER_CAP)));
		h = withLive(h, many(1, REPLAY_BUFFER_CAP));
		expect(h.events.length).toBe(REPLAY_BUFFER_CAP - CHECKPOINT_EVERY);
		expect(h.floor?.id).toBe(`prompt:p${CHECKPOINT_EVERY}`);
		const last = h.events[h.events.length - 1];
		expect(stateAt(h, last?.at ?? 0).scene.core).toBe("thinking");
	});
});

describe("playing and the cursor", () => {
	const h = historyOf(snapshot([prompt(1, 0), prompt(2, 1_000), prompt(3, 61_000), prompt(4, 62_000)], { info: info({ startedAt: T0 }) }));
	const t = timelineOf(h);

	it("plays the events' own clock at the speed, a long silence in one second", () => {
		expect(t).toEqual({ start: T0, end: T0 + 62_000, times: [T0, T0 + 1_000, T0 + 61_000, T0 + 62_000] });
		expect(advance(t, T0, 500, 1)).toBe(T0 + 500);
		expect(advance(t, T0, 250, 4)).toBe(T0 + 1_000);
		// The 60 s silence plays in SILENCE_PLAYED_MS: halfway through it after half of that.
		expect(advance(t, T0 + 1_000, SILENCE_PLAYED_MS / 2, 1)).toBe(T0 + 31_000);
		expect(advance(t, T0 + 1_000, SILENCE_PLAYED_MS, 1)).toBe(T0 + 61_000);
		expect(advance(t, T0, 100_000, 16)).toBe(T0 + 62_000);
	});

	it("steps between events, plays, pauses, changes speed and goes back live", () => {
		expect(eventStep(t, T0 + 1_000, 1)).toBe(T0 + 61_000);
		expect(eventStep(t, T0 + 1_000, -1)).toBe(T0);
		expect(eventStep(t, T0, -1)).toBe(T0);
		let c = togglePlay(LIVE_CURSOR, t);
		expect(c).toEqual({ mode: "replay", at: T0, playing: true, speed: 1 });
		c = nextSpeed(nextSpeed(c));
		expect(c.speed).toBe(16);
		expect(nextSpeed(c).speed).toBe(1);
		c = played(c, t, 10_000);
		expect(c).toEqual({ mode: "replay", at: T0 + 62_000, playing: false, speed: 16 });
		c = cursorAt(c, t, T0 - 5);
		expect(c).toMatchObject({ at: T0, playing: false });
		expect(goLive(c)).toEqual({ mode: "live", speed: 16 });
	});

	it("opens a link's moment, or its event's own time", () => {
		expect(focusedAt(h, { at: 5 })).toBe(5);
		expect(focusedAt(h, { event: "prompt:p3" })).toBe(T0 + 61_000);
		expect(focusedAt(h, { event: "nope" })).toBeNull();
		expect(focusedAt(h, {})).toBeNull();
	});

	it("knows a session past the machine's 90 days", () => {
		expect(detailsExpired(info({ endedAt: T0 }), T0 + DETAIL_RETENTION_MS + 1)).toBe(true);
		expect(detailsExpired(info({ endedAt: T0 }), T0 + DETAIL_RETENTION_MS)).toBe(false);
		expect(detailsExpired(null, T0)).toBe(false);
	});

	it("marks stretches of the bar by their busiest station, failures and findings", () => {
		const marked = historyOf(
			snapshot([
				tool("t1", 0, { success: false, durationMs: 10 }),
				tool("t2", 100, { station: "SANDBOX", success: true, durationMs: 10 }),
				tool("t3", 200, { station: "SANDBOX", success: true, durationMs: 10 }),
				prompt(1, 10_000),
			], { info: info({ startedAt: T0 }) }),
		);
		const marks = marksOf(marked, timelineOf(marked), 10);
		expect(marks).toHaveLength(2);
		expect(marks[0]).toMatchObject({ count: 3, station: "SANDBOX", failed: true, bottleneck: false });
		expect(marks[1]).toMatchObject({ count: 1, station: "CORE" });
	});
});

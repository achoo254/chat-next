// Every row of the Live Map's prop table, from events through the real
// reducer to the director's moves: the thing that moves, where, in which tone,
// and always with its source event's id; the scene's still look (bottleneck
// glows, desk lamp, closed gate, queues, parked drones, core fill and turn);
// a burst at one station played as one batch with a count; a click on a moving
// piece finding its event.
import { describe, expect, it } from "vitest";
import { applyEvents, type LiveMapState } from "../../src/machines/observatory/live-map-state.ts";
import type { LiveMapEvent, LiveMapLiveState } from "../../src/machines/observatory/live-map-types.ts";
import { AnimationDirector, BATCH_LIMIT, HIT_RADIUS } from "../../src/machines/observatory/render/animation-director.ts";
import { FLAG, lookOf, movesOf, pathPoint, queueOverflow, spinSpeed, wireSlot, type Move } from "../../src/machines/observatory/render/prop-map.ts";
import { api, bottleneck, lifecycle, prompt, subagent, tool } from "../machines/observatory/live-map-fixtures.ts";
import { played, shippedAssets } from "./render-fixtures.ts";

const { scene } = shippedAssets();

/** The moves each event plays, in order, as the director starts them (2 s apart, so no batch). */
function movesOfEvents(events: readonly LiveMapEvent[]): Move[][] {
	const { perEvent } = played(events);
	// Replay through the reducer again, event by event, so each animation sees the state right after its event.
	const out: Move[][] = [];
	let i = 0;
	for (const anims of perEvent) {
		const state = played(events.slice(0, i + 1)).state;
		const byId = new Map(state.log.map((e) => [e.id, e]));
		out.push(anims.flatMap((a) => movesOf(a, byId.get(a.eventId), state, scene)));
		i += 1;
	}
	return out;
}

const kinds = (moves: readonly Move[]): string[] => moves.map((m) => `${m.kind}@${m.place}:${m.tone}`);
const last = <T>(list: readonly T[]): T => {
	const x = list[list.length - 1];
	if (x === undefined) throw new Error("empty");
	return x;
};

describe("the prop table", () => {
	it("UserPromptSubmit: an envelope flies from the user desk into the core", () => {
		const [moves = []] = movesOfEvents([prompt(1, 0)]);
		expect(kinds(moves)).toEqual(["envelope@user-desk:normal"]);
		expect(moves[0]?.eventId).toBe("prompt:p1");
		const path = moves[0]?.path ?? [];
		expect(path[0]).toEqual(scene.places["user-desk"].overlays.envelopeStart?.points[0]);
		expect(last(path)).toEqual(scene.places.core.overlays.sphere?.points[0]);
	});

	it("api_request: a beam from the core to the cloud and a point on the monitoring screen", () => {
		const moves = last(movesOfEvents([prompt(1, 0), api("a1", 100)]));
		expect(kinds(moves)).toEqual(["beam@external:normal", "monitor-dot@monitoring:normal"]);
		expect(moves.every((m) => m.eventId === "api:a1")).toBe(true);
	});

	it("api_error 429: the cloud flickers orange three times, red when it repeats", () => {
		const first = lifecycle("api_error", "e1", 100, { station: "EXTERNAL", number: 429, flag: true });
		const again = lifecycle("api_error", "e2", 5_000, { station: "EXTERNAL", number: 429, flag: true });
		const moves = movesOfEvents([first, again]);
		expect(moves[0]?.map((m) => [m.kind, m.tone, m.flashes])).toEqual([["cloud-flicker", "warn", 3]]);
		expect(moves[1]?.map((m) => [m.kind, m.tone])).toEqual([["cloud-flicker", "error"]]);
		expect(kinds(last(movesOfEvents([lifecycle("api_error", "e3", 100, { station: "EXTERNAL", number: 500 })])))).toEqual(["cloud-flicker@external:error"]);
	});

	it("WebFetch, WebSearch: a beam to the cloud, red when it fails", () => {
		const moves = movesOfEvents([tool("w1", 0, { toolName: "WebFetch", station: "EXTERNAL", target: "example.com" }), tool("w1", 900, { toolName: "WebFetch", station: "EXTERNAL", success: false })]);
		expect(kinds(moves[0] ?? [])).toEqual(["beam@external:normal"]);
		expect(kinds(moves[1] ?? [])).toEqual(["beam@external:error"]);
	});

	it("mcp tools: the server's wire lights, red when it fails; the 7th server and later share the last wire", () => {
		const moves = movesOfEvents([tool("m1", 0, { toolName: "mcp__a__x", mcpServer: "a", station: "MCP" }), tool("m1", 400, { toolName: "mcp__a__x", mcpServer: "a", station: "MCP", success: false })]);
		expect(kinds(moves[1] ?? [])).toEqual(["wire@mcp:error"]);
		expect(moves[1]?.[0]?.path[0]).toEqual(scene.places.mcp.overlays.sockets?.points[0]);
		const servers = ["a", "b", "c", "d", "e", "f", "g"];
		expect(wireSlot(servers.slice(0, 6), "f", 6)).toBe(5);
		expect(wireSlot(servers, "e", 6)).toBe(4);
		expect(wireSlot(servers, "f", 6)).toBe(5);
		expect(wireSlot(servers, "g", 6)).toBe(5);
	});

	it("mcp_connection failing: the wire goes grey", () => {
		expect(kinds(last(movesOfEvents([lifecycle("mcp_connection", "c1", 0, { station: "MCP", label: "failed", flag: true })])))).toEqual(["wire-down@mcp:muted"]);
	});

	it("Skill: a scroll flies towards the core", () => {
		const moves = last(movesOfEvents([tool("s1", 0, { toolName: "Skill", station: "SKILLS" }), tool("s1", 300, { toolName: "Skill", station: "SKILLS", success: true })]));
		expect(kinds(moves)).toEqual(["scroll@skills:normal"]);
		expect(last(moves[0]?.path ?? [])).toEqual(scene.places.core.overlays.sphere?.points[0]);
	});

	it("InstructionsLoaded and a write to a memory file: a jar lights", () => {
		const instruction: LiveMapEvent = { kind: "instruction", memoryType: "Project", loadReason: "session_start", id: "instruction:1:start:CLAUDE.md", at: 0, seq: 0, provisional: false };
		expect(kinds(last(movesOfEvents([instruction])))).toEqual(["jar@memory:normal"]);
		const write = last(movesOfEvents([tool("mw", 0, { toolName: "Write", station: "MEMORY", stationFlags: FLAG.write | FLAG.memory }), tool("mw", 200, { toolName: "Write", station: "MEMORY", stationFlags: FLAG.write | FLAG.memory, success: true })]));
		expect(kinds(write)).toEqual(["jar@memory:normal"]);
	});

	it("Read, Grep, Glob: a document circles the tree; Edit, Write: a document flies into it; red when they fail", () => {
		expect(kinds(last(movesOfEvents([tool("r1", 0), tool("r1", 100, { success: true })])))).toEqual(["document-orbit@files:normal"]);
		expect(kinds(last(movesOfEvents([tool("w1", 0, { toolName: "Edit", stationFlags: FLAG.write }), tool("w1", 100, { toolName: "Edit", stationFlags: FLAG.write, success: false })])))).toEqual(["document-in@files:error"]);
	});

	it("SANDBOX: the experiment bubbles while it runs and turns red when it fails", () => {
		const moves = movesOfEvents([tool("b1", 0, { toolName: "Bash", station: "SANDBOX", target: "ls" }), tool("b1", 900, { toolName: "Bash", station: "SANDBOX", success: false })]);
		expect(kinds(moves[0] ?? [])).toEqual(["beam@sandbox:normal", "bubbles@sandbox:normal"]);
		expect(kinds(moves[1] ?? [])).toEqual(["bubbles@sandbox:error"]);
	});

	it("TESTING: the screen runs, then a green tick or a red cross", () => {
		const pass = movesOfEvents([tool("t1", 0, { toolName: "Bash", station: "TESTING" }), tool("t1", 900, { toolName: "Bash", station: "TESTING", success: true })]);
		expect(kinds(pass[0] ?? [])).toEqual(["beam@testing:normal", "screen@testing:normal"]);
		expect(kinds(pass[1] ?? [])).toEqual(["verdict@testing:success"]);
		expect(kinds(last(movesOfEvents([tool("t2", 0, { toolName: "Bash", station: "TESTING", success: false })])))).toEqual(["verdict@testing:error"]);
	});

	it("GIT: a commit grows a branch, a push sends a box down the belt, a deploy launches the rocket, red when they fail", () => {
		const end = (flags: number, success = true): string[] => kinds(last(movesOfEvents([tool("g", 0, { toolName: "Bash", station: "GIT", stationFlags: flags, success })])));
		expect(end(FLAG.commit)).toEqual(["branch@git:normal"]);
		expect(end(0)).toEqual(["branch@git:normal"]);
		expect(end(FLAG.push)).toEqual(["conveyor@git:normal"]);
		expect(end(FLAG.deploy, false)).toEqual(["rocket@git:error"]);
		const op: LiveMapEvent = { kind: "git", gitKind: "push", id: "git:1", at: 0, seq: 0, provisional: false };
		expect(kinds(last(movesOfEvents([op])))).toEqual(["conveyor@git:normal"]);
	});

	it("Task/Agent and SubagentStart: a drone takes off; SubagentStop: it lands and puts its box down", () => {
		expect(kinds(last(movesOfEvents([tool("k1", 0, { toolName: "Task", station: "ORCHESTRATOR" })])))).toEqual(["drone-launch@orchestrator:normal"]);
		const sub = movesOfEvents([subagent("ag1", 0), subagent("ag1", 3_000, 3_000)]);
		expect(kinds(sub[0] ?? [])).toEqual(["drone-launch@orchestrator:normal"]);
		expect(kinds(sub[1] ?? [])).toEqual(["drone-land@orchestrator:normal"]);
	});

	it("a subagent's tool: its drone flies to the station and carries the result back", () => {
		const moves = movesOfEvents([subagent("ag1", 0), tool("x1", 100, { agentId: "ag1" }), tool("x1", 900, { agentId: "ag1", success: true })]);
		expect(kinds(moves[1] ?? [])).toEqual(["drone-out@files:normal"]);
		expect(kinds(moves[2] ?? [])).toEqual(["drone-return@files:normal", "document-orbit@files:normal"]);
		expect(last(moves[1]?.[0]?.path ?? [])).toEqual(scene.places.files.droneTarget);
	});

	it("TodoWrite, plan mode: the task board updates", () => {
		expect(kinds(last(movesOfEvents([tool("td", 0, { toolName: "TodoWrite", station: "ORCHESTRATOR", success: true })])))).toEqual(["board@orchestrator:normal"]);
		expect(kinds(last(movesOfEvents([lifecycle("todo_counts", "tc", 0, { station: "ORCHESTRATOR", label: "1/2/3" })])))).toEqual(["board@orchestrator:normal"]);
	});

	it("permission_request: the gate closes and the shield lights; a denial or a hook block turns the shield red", () => {
		expect(kinds(last(movesOfEvents([lifecycle("permission_request", "pr", 0, { station: "SANDBOX", label: "Bash" })])))).toEqual(["gate@security:warn", "shield@security:warn"]);
		for (const name of ["permission_decision", "permission_denied", "hook_block"]) expect(kinds(last(movesOfEvents([lifecycle(name, name, 0, { station: "SANDBOX" })])))).toEqual(["shield@security:error"]);
	});

	it("compaction shrinks the core; stop_failure turns it red once; Stop lights the desk lamp", () => {
		expect(kinds(last(movesOfEvents([lifecycle("compact_start", "c1", 0)])))).toEqual(["core-shrink@core:warn"]);
		expect(kinds(last(movesOfEvents([lifecycle("compact_end", "c2", 0)])))).toEqual(["core-shrink@core:normal"]);
		expect(kinds(last(movesOfEvents([prompt(1, 0), lifecycle("stop_failure", "f1", 100)])))).toEqual(["core-red@core:error"]);
		expect(kinds(last(movesOfEvents([prompt(1, 0), lifecycle("stop", "s1", 100)])))).toEqual(["desk-lamp@user-desk:success"]);
	});

	it("a bottleneck opening rings its station orange or red; closing rings it grey", () => {
		expect(kinds(last(movesOfEvents([bottleneck("slow", 0, "MCP", "warn", true)])))).toEqual(["alert-ring@mcp:warn"]);
		expect(kinds(last(movesOfEvents([bottleneck("slow", 0, "MCP", "alert", true)])))).toEqual(["alert-ring@mcp:error"]);
		expect(kinds(last(movesOfEvents([bottleneck("slow", 0, "MCP", "warn", true), bottleneck("slow", 100, "MCP", "warn", false)])))).toEqual(["alert-ring@mcp:muted"]);
	});

	it("an estimated station says so on its moves", () => {
		const [moves = []] = movesOfEvents([tool("e1", 0, { stationFlags: FLAG.estimated })]);
		expect(moves.every((m) => m.estimated)).toBe(true);
	});

	it("an unknown tool, an unknown station or an unknown lifecycle pulses the core", () => {
		expect(kinds(last(movesOfEvents([tool("u1", 0, { toolName: "Mystery", station: "NEW_STATION", success: true })])))).toEqual(["core-pulse@core:normal"]);
		expect(kinds(last(movesOfEvents([lifecycle("something_new", "n1", 0, { station: "CORE" })])))).toEqual(["core-pulse@core:normal"]);
	});
});

const live = (over: Partial<LiveMapLiveState>): LiveMapLiveState => ({
	core: "thinking",
	tokensPerSecond: 40,
	contextPercent: 62,
	contextTokens: 124_000,
	contextWindow: 200_000,
	contextWindowAssumed: false,
	mainModel: "claude-opus",
	running: [],
	openBottlenecks: 0,
	...over,
});

const withLive = (state: LiveMapState, l: LiveMapLiveState | null): LiveMapState => ({ ...state, live: l });

describe("the still look", () => {
	it("an open bottleneck glows its station with a fixed alpha, and goes when it closes", () => {
		const open = lookOf(played([bottleneck("slow", 0, "MCP", "alert", true)]).state, scene);
		expect(open.glows.find((g) => g.key === "bottleneck:MCP")).toMatchObject({ place: "mcp", tone: "error", alpha: 0.55 });
		const closed = lookOf(played([bottleneck("slow", 0, "MCP", "alert", true), bottleneck("slow", 100, "MCP", "alert", false)]).state, scene);
		expect(closed.glows.some((g) => g.key === "bottleneck:MCP")).toBe(false);
	});

	it("the desk lamp is lit while the core waits for the user, and off at the next prompt", () => {
		expect(lookOf(played([prompt(1, 0), lifecycle("stop", "s", 100)]).state, scene).glows.map((g) => g.key)).toContain("desk-lamp");
		expect(lookOf(played([prompt(1, 0), lifecycle("stop", "s", 100), prompt(2, 200)]).state, scene).glows.map((g) => g.key)).not.toContain("desk-lamp");
	});

	it("the gate stays closed while a permission waits", () => {
		const keys = lookOf(played([prompt(1, 0), lifecycle("permission_request", "pr", 100, { station: "SANDBOX" })]).state, scene).glows.map((g) => g.key);
		expect(keys).toContain("gate-closed");
	});

	it("two or more running calls at a station wait in its queue spots, past 4 as +n", () => {
		const events = Array.from({ length: 7 }, (_, i) => tool(`q${i}`, i * 10));
		const { state } = played(events);
		expect(lookOf(state, scene).queued).toEqual(scene.places.files.queue.slice(0, 4));
		expect(queueOverflow(state, scene)).toEqual({ files: 2 });
	});

	it("a running subagent's drone waits at the station of its latest call", () => {
		expect(lookOf(played([subagent("ag", 0), tool("x", 100, { agentId: "ag", station: "SANDBOX" })]).state, scene).drones).toEqual([scene.places.sandbox.droneTarget]);
	});

	it("the core fills with the context and turns while it thinks at the last request's speed, still once it stops", () => {
		const { state } = played([prompt(1, 0)]);
		const look = lookOf(withLive(state, live({ contextPercent: 90 })), scene);
		expect(look.glows.find((g) => g.key === "core-fill")).toMatchObject({ tone: "warn" });
		expect(look.spin).toEqual({ speed: spinSpeed(40), eventId: "prompt:p1" });
		expect(lookOf(withLive(state, live({ core: "waiting_user" })), scene).spin).toBeNull();
		expect(spinSpeed(null)).toBeLessThan(spinSpeed(50));
		expect(spinSpeed(10_000)).toBe(1.5);
	});

	it("an idle session has nothing that moves", () => {
		const look = lookOf(played([]).state, scene);
		expect(look).toEqual({ glows: [], queued: [], drones: [], spin: null });
	});
});

describe("the director", () => {
	it("logs every move with its source event, place, kind and time", () => {
		const events = [prompt(1, 0), tool("r1", 10), api("a1", 20)];
		const { state, animations } = played(events);
		const director = new AnimationDirector(scene, { record: true });
		director.play(animations, state, 1_000);
		expect(director.log().map((e) => [e.eventId, e.place, e.kind, e.at])).toEqual([
			["prompt:p1", "user-desk", "envelope", 1_000],
			["tool:r1", "files", "beam", 1_000],
			["api:a1", "external", "beam", 1_000],
			["api:a1", "monitoring", "monitor-dot", 1_000],
		]);
		expect(director.busy).toBe(true);
		director.frame(1_000 + 5_000);
		expect(director.busy).toBe(false);
	});

	it("keeps no log unless asked", () => {
		const { state, animations } = played([prompt(1, 0)]);
		const director = new AnimationDirector(scene);
		director.play(animations, state, 0);
		expect(director.log()).toEqual([]);
	});

	it("plays each move between 0.6 and 1.5 s", () => {
		const { state, animations } = played([prompt(1, 0), tool("r1", 10), lifecycle("api_error", "e", 20, { number: 429 })]);
		const director = new AnimationDirector(scene);
		director.play(animations, state, 0);
		const frames = director.frame(0);
		expect(frames.every((f) => f.active.move.durationMs >= 600 && f.active.move.durationMs <= 1_500)).toBe(true);
	});

	it("more than 8 moves at a station within a second play as one batch with a count, every event still logged", () => {
		const events = Array.from({ length: 12 }, (_, i) => tool(`b${i}`, i));
		const { state, animations } = played(events);
		const batches: [string, number | null][] = [];
		const director = new AnimationDirector(scene, { record: true, onBatch: (place, count) => batches.push([place, count]) });
		director.play(animations, state, 0);
		const frames = director.frame(0);
		expect(frames.filter((f) => f.active.move.kind !== "batch")).toHaveLength(BATCH_LIMIT);
		const batch = frames.find((f) => f.active.move.kind === "batch");
		expect(batch?.active.count).toBe(12 - BATCH_LIMIT);
		expect(batch?.active.lastEventId).toBe("tool:b11");
		expect(director.log()).toHaveLength(12);
		expect(director.log().slice(BATCH_LIMIT).every((e) => e.kind === "batch")).toBe(true);
		expect(last(batches)).toEqual(["files", 4]);
		director.frame(5_000);
		expect(last(batches)).toEqual(["files", null]);
	});

	it("finds the event of the piece under a click", () => {
		const { state, animations } = played([prompt(1, 0)]);
		const director = new AnimationDirector(scene);
		director.play(animations, state, 0);
		const [frame] = director.frame(600);
		if (frame === undefined) throw new Error("no frame");
		expect(director.hit(frame.at, 600)).toBe("prompt:p1");
		expect(director.hit([frame.at[0] + HIT_RADIUS * 3, frame.at[1]], 600)).toBeNull();
		expect(director.hit(frame.at, 10_000)).toBeNull();
	});

	it("an event folded out of the log still plays, as a core pulse", () => {
		const { state } = played([]);
		const moves = movesOf({ eventId: "tool:gone", station: "FILES", cue: "tool-end" }, undefined, state, scene);
		expect(moves.map((m) => [m.kind, m.eventId])).toEqual([["core-pulse", "tool:gone"]]);
	});

	it("walks a path by length", () => {
		expect(pathPoint([[0, 0], [10, 0], [10, 10]], 0.5)).toEqual([10, 0]);
		expect(pathPoint([[0, 0], [10, 0], [10, 10]], 1)).toEqual([10, 10]);
		expect(pathPoint([[5, 5]], 0.7)).toEqual([5, 5]);
	});

	it("an event replaced by its stored version does not play twice", () => {
		const { state } = played([tool("p1", 0)]);
		const stored = { ...tool("p1", 0), provisional: false };
		const next = applyEvents(state, state.epoch, [{ ...stored, seq: state.seq + 1 }]).state;
		expect(next.animations).toEqual([]);
	});
});

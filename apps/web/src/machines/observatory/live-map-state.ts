// What the Live Map shows of one Claude Code session, worked out from its
// events alone (pure functions, no clock): the core's state, each station's
// running calls, permission queue, latest call, counts and bottleneck level,
// the subagents and the station each one is at, one MCP wire per server, the
// to-do board, and the animations still to play (each names the event that
// caused it). The renderer only reads this; replaying a session builds the
// same state from the same events. The core's state, the running calls and
// the main agent's speed follow the machine's own rules for its live state
// (apps/agent/src/observatory/hub/live-state.ts, docs/observatory-wire.md
// section 6.3), so a replay matches what a live view was sent; while
// watching live, the machine's `live` state (with the context's fill and
// whether its window was assumed) is kept as sent.
//
// Events are kept ordered by (at, id), not by arrival: a provisional event
// read from the spool's tail comes first and the stored version with the same
// id later, sometimes out of order with its neighbours. A later version of an
// id replaces the earlier one, and the scene is folded again from the ordered
// events whenever an event lands anywhere but at the end, so the scene is the
// same whatever the arrival order. Only an event that arrives within
// REORDER_WINDOW_MS of the newest one queues an animation: an older one is
// late news, shown in the counts but not played.
//
// The device side of the watch (docs/observatory-wire.md section 2): an event
// of another epoch, or one past a gap in `seq`, asks for a fresh snapshot; an
// event at or below the applied `seq` is dropped; an event of a kind this app
// does not know only moves `seq` on.
import { isMainRequest, type CoreState, type LiveMapEvent, type LiveMapLiveState, type LiveMapSessionInfo, type LiveMapSnapshot } from "./live-map-types.ts";
import { STATION_CODES, stationOf, type StationCode } from "./station-catalog.ts";

/** Events this far behind the newest one still play their animation; older ones only count. */
export const REORDER_WINDOW_MS = 2_000;
/** The events kept in order; older ones are folded into the base scene and can no longer be replaced. */
export const LOG_CAP = 2_000;
/** Animations not taken by a renderer by then are dropped, oldest first. */
export const ANIMATION_CAP = 200;

export type { CoreState };
export type BottleneckLevel = "none" | "warn" | "alert";

export interface StationState {
	/** Ids of the calls running there, in event order. */
	running: string[];
	/** Permission requests waiting there. */
	queued: number;
	/** Id of the latest call that ended there; null before any. */
	last: string | null;
	/** Calls that ended there. */
	calls: number;
	failures: number;
	bottleneck: BottleneckLevel;
}

export interface SubagentState {
	agentId: string;
	agentType: string;
	running: boolean;
	/** Where its latest call was; the orchestrator before any. */
	station: StationCode;
}

export interface McpWireState {
	server: string;
	running: number;
	calls: number;
	failures: number;
}

export interface TodoBoard {
	pending: number;
	inProgress: number;
	done: number;
}

export interface LiveMapScene {
	core: CoreState;
	/** A turn runs (a prompt or a call since the last stop). */
	inTurn: boolean;
	/** The core's state before a compaction started. */
	beforeCompact: CoreState;
	/** Calls denied or blocked by a hook: they never ran. */
	notRun: Set<string>;
	/** Shell calls started in the background and not known to have ended (the machine's rule, docs/observatory-wire.md). */
	backgroundShells: Set<string>;
	/** The main agent's latest model; "" before any. */
	model: string;
	/** Output tokens per second of the main agent's latest API request; null when it gave no numbers. */
	tokensPerSecond: number | null;
	stations: Record<StationCode, StationState>;
	subagents: Record<string, SubagentState>;
	mcp: Record<string, McpWireState>;
	todo: TodoBoard | null;
	/** Open bottleneck findings by event id. */
	bottlenecks: Map<string, { station: StationCode; severity: "warn" | "alert" }>;
}

export type AnimationCue = "prompt" | "tool-start" | "tool-end" | "subagent-start" | "subagent-end" | "api" | "instruction" | "git" | "lifecycle" | "bottleneck";

export interface Animation {
	readonly eventId: string;
	readonly station: StationCode;
	readonly cue: AnimationCue;
}

export interface LiveMapState {
	readonly sessionId: string;
	readonly epoch: bigint;
	/** The last event applied; the next one must be seq + 1. */
	readonly seq: number;
	readonly info: LiveMapSessionInfo | null;
	/** The session as a whole as the machine last sent it; null before it sent one (or for an older machine). */
	readonly live: LiveMapLiveState | null;
	/** Where older events start; "" when none is older. */
	readonly earlier: string;
	/** The kept events, ordered by (at, id), one per id. */
	readonly log: readonly LiveMapEvent[];
	/** The last event folded into `base`; events at or before it are not kept. */
	readonly floor: { readonly at: number; readonly id: string } | null;
	readonly base: LiveMapScene;
	readonly scene: LiveMapScene;
	/** The newest `at` seen. */
	readonly newestAt: number;
	readonly animations: readonly Animation[];
}

/** Events that take part in the scene (the session's own row and unknown kinds do not). */
type SceneEvent = Exclude<LiveMapEvent, { kind: "session" } | { kind: "unknown" }>;

function isSceneEvent(e: LiveMapEvent): e is SceneEvent {
	return e.kind !== "session" && e.kind !== "unknown";
}

function emptyStation(): StationState {
	return { running: [], queued: 0, last: null, calls: 0, failures: 0, bottleneck: "none" };
}

/** A value for every station. */
function perStation<T>(make: (code: StationCode) => T): Record<StationCode, T> {
	return {
		CORE: make("CORE"),
		ORCHESTRATOR: make("ORCHESTRATOR"),
		FILES: make("FILES"),
		MEMORY: make("MEMORY"),
		SKILLS: make("SKILLS"),
		MCP: make("MCP"),
		EXTERNAL: make("EXTERNAL"),
		SANDBOX: make("SANDBOX"),
		TESTING: make("TESTING"),
		GIT: make("GIT"),
	};
}

export function emptyScene(): LiveMapScene {
	return { core: "idle", inTurn: false, beforeCompact: "idle", notRun: new Set(), backgroundShells: new Set(), model: "", tokensPerSecond: null, stations: perStation(emptyStation), subagents: {}, mcp: {}, todo: null, bottlenecks: new Map() };
}

function cloneScene(s: LiveMapScene): LiveMapScene {
	const stations = perStation((code) => {
		const st = s.stations[code];
		return { ...st, running: [...st.running] };
	});
	const subagents: Record<string, SubagentState> = {};
	for (const [id, sub] of Object.entries(s.subagents)) subagents[id] = { ...sub };
	const mcp: Record<string, McpWireState> = {};
	for (const [server, wire] of Object.entries(s.mcp)) mcp[server] = { ...wire };
	return { ...s, stations, subagents, mcp, todo: s.todo === null ? null : { ...s.todo }, bottlenecks: new Map(s.bottlenecks), notRun: new Set(s.notRun), backgroundShells: new Set(s.backgroundShells) };
}

/** (at, id) order: by time, then by id in code-unit order (the same on every device). */
function compare(a: { at: number; id: string }, b: { at: number; id: string }): number {
	if (a.at !== b.at) return a.at - b.at;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function clearQueues(d: LiveMapScene): void {
	for (const code of STATION_CODES) d.stations[code].queued = 0;
}

/** "pending/in progress/done" as the machine labels a to-do count; null when unreadable. */
export function parseTodoCounts(label: string): TodoBoard | null {
	const parts = /^(\d+)\/(\d+)\/(\d+)$/.exec(label);
	if (parts === null) return null;
	return { pending: Number(parts[1]), inProgress: Number(parts[2]), done: Number(parts[3]) };
}

function recomputeBottlenecks(d: LiveMapScene): void {
	for (const code of STATION_CODES) d.stations[code].bottleneck = "none";
	for (const finding of d.bottlenecks.values()) {
		const st = d.stations[finding.station];
		if (finding.severity === "alert" || st.bottleneck === "none") st.bottleneck = finding.severity;
	}
}

/** Tool calls that never ran: denied, or blocked by a hook. */
const NOT_RUN = new Set(["permission_denied", "hook_block"]);
/** The machine's label of a tool call the person interrupted (the turn ends with it). */
const INTERRUPTED = "interrupted";
/** `station_flags` bit of a shell call started with `run_in_background`. */
const BACKGROUND_FLAG = 64;

function active(d: LiveMapScene): void {
	d.core = "thinking";
	d.inTurn = true;
}

/** The turn is over: nothing runs, nothing waits for permission. */
function endTurn(d: LiveMapScene, core: CoreState): void {
	d.core = core;
	d.inTurn = false;
	for (const code of STATION_CODES) d.stations[code].running = [];
	clearQueues(d);
}

/** The shortest stretch a speed is read from: a request streaming for a few milliseconds says nothing about how fast the model writes (the same number as the machine's). */
const MIN_STREAM_MS = 200;

/** Output tokens per second of one request: over its time after the first token when that is long enough to read, else over its whole duration, else none. */
function speedOf(e: { outputTokens?: number; durationMs?: number; ttftMs?: number }): number | null {
	const total = e.durationMs ?? 0;
	const output = e.outputTokens ?? 0;
	const writing = total - (e.ttftMs ?? 0);
	const ms = writing >= MIN_STREAM_MS ? writing : total;
	return output > 0 && ms >= MIN_STREAM_MS ? (output * 1000) / ms : null;
}

/** One event into a draft scene (mutated). */
function step(d: LiveMapScene, e: SceneEvent): void {
	switch (e.kind) {
		case "prompt":
			active(d);
			clearQueues(d);
			// A new turn (the person's, or Claude Code's notice that a shell ended).
			d.backgroundShells.clear();
			return;
		case "tool": {
			active(d);
			const code = stationOf(e.station);
			const st = d.stations[code];
			// A call ran there: whatever asked for permission there was answered.
			st.queued = 0;
			if (e.success === undefined) {
				if (!d.notRun.has(e.toolUseId)) st.running.push(e.id);
			} else {
				st.calls += 1;
				if (!e.success) st.failures += 1;
				st.last = e.id;
			}
			if (e.agentId !== "") {
				const sub = (d.subagents[e.agentId] ??= { agentId: e.agentId, agentType: "", running: true, station: code });
				sub.station = code;
			}
			if (e.mcpServer !== "") {
				const wire = (d.mcp[e.mcpServer] ??= { server: e.mcpServer, running: 0, calls: 0, failures: 0 });
				if (e.success === undefined) wire.running += 1;
				else {
					wire.calls += 1;
					if (!e.success) wire.failures += 1;
				}
			}
			if (e.toolName === "KillShell") d.backgroundShells.clear();
			else if ((e.stationFlags & BACKGROUND_FLAG) !== 0 && e.success !== false && !d.notRun.has(e.toolUseId)) d.backgroundShells.add(e.toolUseId);
			// The person stopped the turn (Esc, Ctrl+C): Claude Code tells no Stop, only this call's end.
			if (e.error === INTERRUPTED) endTurn(d, "waiting_user");
			return;
		}
		case "subagent": {
			// A start is work; a stop alone is not (Claude Code's side features leave a stop at once after a turn ends).
			if (e.endedAt === 0) active(d);
			const sub = (d.subagents[e.agentId] ??= { agentId: e.agentId, agentType: e.agentType, running: true, station: "ORCHESTRATOR" });
			sub.agentType = e.agentType;
			sub.running = e.endedAt === 0;
			return;
		}
		case "api": {
			if (!isMainRequest(e)) return;
			active(d);
			if (e.model !== "") d.model = e.model;
			const speed = speedOf(e);
			if (speed !== null) d.tokensPerSecond = speed;
			return;
		}
		case "instruction":
		case "git":
			return;
		case "lifecycle": {
			const st = d.stations[stationOf(e.station)];
			if (NOT_RUN.has(e.name) && e.toolUseId !== "") {
				d.notRun.add(e.toolUseId);
				const id = `tool:${e.toolUseId}`;
				for (const code of STATION_CODES) d.stations[code].running = d.stations[code].running.filter((x) => x !== id);
			}
			switch (e.name) {
				case "permission_request":
					st.queued += 1;
					d.core = "waiting_permission";
					d.inTurn = true;
					return;
				case "permission_decision":
				case "permission_denied":
				case "hook_block":
					st.queued = Math.max(0, st.queued - 1);
					active(d);
					return;
				case "compact_start":
					if (d.core !== "compacting") d.beforeCompact = d.core;
					d.core = "compacting";
					return;
				case "compact_end":
					d.core = d.inTurn ? "thinking" : d.beforeCompact === "idle" ? "idle" : "waiting_user";
					return;
				case "stop":
					endTurn(d, "waiting_user");
					return;
				case "stop_failure":
					endTurn(d, "failed");
					return;
				case "notification":
					if (e.label === "permission_prompt") d.core = "waiting_permission";
					else if (e.label === "idle_prompt") endTurn(d, "waiting_user");
					return;
				case "todo_counts":
					d.todo = parseTodoCounts(e.label) ?? d.todo;
					return;
				case "model_change":
					if (e.label !== "") d.model = e.label;
					return;
				default:
					return;
			}
		}
		case "bottleneck":
			if (e.open) d.bottlenecks.set(e.id, { station: stationOf(e.station), severity: e.severity });
			else d.bottlenecks.delete(e.id);
			recomputeBottlenecks(d);
			return;
	}
}

/** The core's state, idle once the session ended after its last event, thinking while a subagent or a background shell may still run after the main turn stopped (the machine's rules). */
export function coreOf(state: Pick<LiveMapState, "scene" | "info" | "newestAt">): CoreState {
	const ended = state.info?.endedAt ?? 0;
	if (ended > 0 && ended >= state.newestAt) return "idle";
	const { core, subagents, backgroundShells } = state.scene;
	return core === "waiting_user" && (backgroundShells.size > 0 || Object.values(subagents).some((s) => s.running)) ? "thinking" : core;
}

/** The scene of `events` (ordered) on top of `base`. */
export function foldScene(base: LiveMapScene, events: readonly LiveMapEvent[]): LiveMapScene {
	const d = cloneScene(base);
	for (const e of events) if (isSceneEvent(e)) step(d, e);
	return d;
}

/** The animation an event plays as it arrives; `before` is the version of its id held until now. */
function cueOf(e: SceneEvent, before: SceneEvent | undefined): Animation | null {
	const at = (cue: AnimationCue, station: StationCode): Animation => ({ eventId: e.id, station, cue });
	switch (e.kind) {
		case "tool": {
			const station = stationOf(e.station);
			const wasRunning = before?.kind === "tool" && before.success === undefined;
			if (e.success === undefined) return before === undefined ? at("tool-start", station) : null;
			return before === undefined || wasRunning ? at("tool-end", station) : null;
		}
		case "subagent": {
			const wasRunning = before?.kind === "subagent" && before.endedAt === 0;
			if (e.endedAt === 0) return before === undefined ? at("subagent-start", "ORCHESTRATOR") : null;
			return before === undefined || wasRunning ? at("subagent-end", "ORCHESTRATOR") : null;
		}
		case "bottleneck":
			return at("bottleneck", stationOf(e.station));
		default:
			if (before !== undefined) return null;
			switch (e.kind) {
				case "prompt":
					return at("prompt", "CORE");
				case "api":
					return at("api", "CORE");
				case "instruction":
					return at("instruction", "MEMORY");
				case "git":
					return at("git", "GIT");
				case "lifecycle":
					return at("lifecycle", stationOf(e.station));
			}
	}
}

/** Keeps the log at LOG_CAP by folding its oldest events into the base. */
function capped(state: LiveMapState, log: LiveMapEvent[]): Pick<LiveMapState, "log" | "base" | "floor"> {
	if (log.length <= LOG_CAP) return { log, base: state.base, floor: state.floor };
	const dropped = log.slice(0, log.length - LOG_CAP);
	const last = dropped[dropped.length - 1];
	return { log: log.slice(dropped.length), base: foldScene(state.base, dropped), floor: last === undefined ? state.floor : { at: last.at, id: last.id } };
}

/**
 * `events` into the state in arrival order: each replaces the kept event
 * with its id or takes its place in (at, id) order. The scene is folded again
 * only when an event did not land at the end. `animate`: queue animations
 * (not for a page of older events).
 */
function merge(state: LiveMapState, events: readonly LiveMapEvent[], animate: boolean): LiveMapState {
	let info = state.info;
	let live = state.live;
	let seq = state.seq;
	let newestAt = state.newestAt;
	const log = [...state.log];
	const appended: SceneEvent[] = [];
	let refold = false;
	const animations = animate ? [...state.animations] : null;
	for (const e of events) {
		if (e.seq > seq) seq = e.seq;
		if (e.kind === "session") {
			info = e.info;
			live = e.live;
			continue;
		}
		if (!isSceneEvent(e)) continue;
		if (state.floor !== null && compare(e, state.floor) <= 0) continue;
		// The log is the session's history, the same however it arrived: seq belongs to the watch, not the event.
		const event: SceneEvent = e.seq === 0 ? e : { ...e, seq: 0 };
		const index = log.findIndex((x) => x.id === e.id);
		const held = index < 0 ? undefined : log[index];
		const before = held !== undefined && isSceneEvent(held) ? held : undefined;
		if (index >= 0) {
			log.splice(index, 1);
			refold = true;
		}
		// Binary search for the first kept event after `e`.
		let lo = 0;
		let hi = log.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const x = log[mid];
			if (x !== undefined && compare(x, e) <= 0) lo = mid + 1;
			else hi = mid;
		}
		log.splice(lo, 0, event);
		if (lo !== log.length - 1) refold = true;
		else appended.push(event);
		if (e.at > newestAt) newestAt = e.at;
		if (animations !== null && e.at >= newestAt - REORDER_WINDOW_MS) {
			const cue = cueOf(event, before);
			if (cue !== null) animations.push(cue);
		}
	}
	const kept = capped(state, log);
	let scene: LiveMapScene;
	if (refold || kept.base !== state.base) scene = foldScene(kept.base, kept.log);
	else if (appended.length > 0) scene = foldScene(state.scene, appended);
	else scene = state.scene;
	return {
		...state,
		...kept,
		info,
		live,
		seq,
		newestAt,
		scene,
		animations: animations === null ? state.animations : animations.slice(-ANIMATION_CAP),
	};
}

/** The state a snapshot starts: its events in order, no animation queued (a snapshot is the scene as it stands). */
export function fromSnapshot(snapshot: LiveMapSnapshot): LiveMapState {
	const empty: LiveMapState = {
		sessionId: snapshot.sessionId,
		epoch: snapshot.epoch,
		seq: 0,
		info: snapshot.info,
		live: snapshot.live,
		earlier: snapshot.earlier,
		log: [],
		floor: null,
		base: emptyScene(),
		scene: emptyScene(),
		newestAt: 0,
		animations: [],
	};
	return { ...merge(empty, snapshot.events, false), seq: snapshot.seq };
}

/** One event as it arrives (its seq already checked by applyEvents). */
export function reduce(state: LiveMapState, event: LiveMapEvent): LiveMapState {
	return merge(state, [event], true);
}

/**
 * A frame of events for the watched session: the state after them, or
 * "need-snapshot" when the frame is of another epoch or skips a seq (the
 * events before the gap are applied, the rest wait for the snapshot).
 */
export function applyEvents(state: LiveMapState, epoch: bigint, events: readonly LiveMapEvent[]): { state: LiveMapState; needSnapshot: boolean } {
	if (epoch !== state.epoch) return { state, needSnapshot: true };
	const next: LiveMapEvent[] = [];
	let seq = state.seq;
	let gap = false;
	for (const e of events) {
		if (e.seq <= seq) continue;
		if (e.seq > seq + 1) {
			gap = true;
			break;
		}
		next.push(e);
		seq = e.seq;
	}
	return { state: next.length === 0 ? state : merge(state, next, true), needSnapshot: gap };
}

/** A page of older events (ObservatoryEarlier): placed in order, no animation, `seq` untouched. */
export function withEarlier(state: LiveMapState, events: readonly LiveMapEvent[], earlier: string): LiveMapState {
	return { ...merge(state, events, false), seq: state.seq, earlier };
}

/** The queued animations, and the state without them (the renderer takes them as it plays). */
export function takeAnimations(state: LiveMapState): [readonly Animation[], LiveMapState] {
	if (state.animations.length === 0) return [state.animations, state];
	return [state.animations, { ...state, animations: [] }];
}

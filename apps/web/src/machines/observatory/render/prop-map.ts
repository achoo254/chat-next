// What each event makes the Live Map's things do (design section 8, the prop
// table of the Live Map plan): pure functions from an animation the state
// queued (live-map-state.ts, which names its source event) and that event to
// the moves to play, and from the state to the scene's still look (glows of
// open bottlenecks, the desk lamp, the closed gate, the core's fill, queues,
// parked drones, lit MCP wires). Nothing here reads a clock or draws: the
// director times the moves, scene-layers.ts draws them. Every move carries
// the id of its source event, so a click on it opens that event; an event
// this table does not know, or a station this app does not know, pulses the
// core.
import type { Animation, LiveMapState } from "../live-map-state.ts";
import type { LiveMapEvent } from "../live-map-types.ts";
import { stationOf, type StationCode } from "../station-catalog.ts";
import { centreOf, STATION_PLACE, type PlaceId, type Point, type ScenePlace, type SceneTable } from "./scene-table.ts";

export type MotionKind =
	| "envelope"
	| "beam"
	| "drone-out"
	| "drone-return"
	| "drone-launch"
	| "drone-land"
	| "scroll"
	| "document-orbit"
	| "document-in"
	| "jar"
	| "wire"
	| "wire-down"
	| "cloud-flicker"
	| "bubbles"
	| "screen"
	| "verdict"
	| "branch"
	| "conveyor"
	| "rocket"
	| "gate"
	| "shield"
	| "board"
	| "monitor-dot"
	| "core-pulse"
	| "core-shrink"
	| "core-red"
	| "desk-lamp"
	| "alert-ring"
	| "batch";

export type Tone = "normal" | "success" | "warn" | "error" | "muted";

export interface Move {
	readonly eventId: string;
	readonly place: PlaceId;
	readonly kind: MotionKind;
	readonly tone: Tone;
	/** Where it goes, in plate pixels; one point for a move that stays in place. */
	readonly path: readonly Point[];
	readonly durationMs: number;
	/** Times it flashes (a flicker); 1 for everything else. */
	readonly flashes: number;
	/** The event's station was worked out from a filtered target and may be wrong. */
	readonly estimated: boolean;
}

/** Each move lasts 0.6 to 1.5 s. */
export const DURATION_MS: Readonly<Record<MotionKind, number>> = {
	envelope: 1200,
	beam: 700,
	"drone-out": 1300,
	"drone-return": 1300,
	"drone-launch": 1000,
	"drone-land": 1000,
	scroll: 1200,
	"document-orbit": 1400,
	"document-in": 1100,
	jar: 900,
	wire: 800,
	"wire-down": 900,
	"cloud-flicker": 1500,
	bubbles: 1200,
	screen: 1000,
	verdict: 1100,
	branch: 1200,
	conveyor: 1500,
	rocket: 1500,
	gate: 800,
	shield: 800,
	board: 700,
	"monitor-dot": 700,
	"core-pulse": 600,
	"core-shrink": 1200,
	"core-red": 1000,
	"desk-lamp": 600,
	"alert-ring": 900,
	batch: 1200,
};

/** `station_flags` bits (docs/observatory-wire.md section 3). */
export const FLAG = { commit: 1, push: 2, deploy: 4, write: 8, memory: 16, estimated: 32 } as const;

/** HTTP 429: the API's rate limit. */
const RATE_LIMITED = 429;
/** A rate limit within this long of an earlier one turns the cloud red. */
const REPEAT_WINDOW_MS = 60_000;
const AGENT_TOOLS = new Set(["Task", "Agent"]);

/** A named overlay spot of a place (the i-th point, wrapping), or `fallback`. */
export function spot(place: ScenePlace, overlay: string, i: number, fallback: Point): Point {
	const o = place.overlays[overlay];
	if (o === undefined) return fallback;
	if (o.points.length > 0) return o.points[((i % o.points.length) + o.points.length) % o.points.length] ?? fallback;
	if (o.polygon.length > 0) return centreOf(o.polygon);
	return fallback;
}

export function coreCentre(scene: SceneTable): Point {
	const core = scene.places.core;
	return spot(core, "sphere", 0, centreOf(core.hit));
}

/** Where the orchestrator keeps its drones. */
export function droneHome(scene: SceneTable): Point {
	const o = scene.places.orchestrator;
	return spot(o, "hologram", 0, o.droneTarget);
}

/** From the core to a place's stop (its flight path when the table has one). */
function fromCore(scene: SceneTable, place: ScenePlace, to: Point = place.droneTarget): Point[] {
	const path = place.flightPath.length >= 2 ? [...place.flightPath] : [coreCentre(scene), place.droneTarget];
	path[path.length - 1] = to;
	return path;
}

/** A stable small number from a string (which jar lights for an instruction file). */
function hashIndex(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/**
 * The socket of an MCP server: the servers in the order the session first
 * used them own one socket each; when there are more servers than sockets,
 * the last socket is the "other" wire they share.
 */
export function wireSlot(servers: readonly string[], server: string, sockets: number): number {
	if (sockets <= 0) return 0;
	const i = servers.indexOf(server);
	if (servers.length <= sockets) return i < 0 ? sockets - 1 : i;
	return i < 0 || i >= sockets - 1 ? sockets - 1 : i;
}

function socketCount(scene: SceneTable): number {
	return Math.max(1, scene.places.mcp.overlays.sockets?.points.length ?? 1);
}

/** Where a drone of a running call waits: the stop for the first, then the queue's spots. */
function queueSpot(place: ScenePlace, running: readonly string[], eventId: string): Point {
	const i = running.indexOf(eventId);
	if (i <= 0) return place.droneTarget;
	return place.queue[Math.min(i - 1, place.queue.length - 1)] ?? place.droneTarget;
}

interface Builder {
	readonly moves: Move[];
	add(kind: MotionKind, place: PlaceId, path: readonly Point[], tone?: Tone, flashes?: number): void;
}

function builder(eventId: string, estimated: boolean): Builder {
	const moves: Move[] = [];
	return {
		moves,
		add(kind, place, path, tone = "normal", flashes = 1) {
			moves.push({ eventId, place, kind, tone, path, durationMs: DURATION_MS[kind], flashes, estimated });
		},
	};
}

type ToolEvent = Extract<LiveMapEvent, { kind: "tool" }>;

/** What a finished call shows at its station. */
function toolResult(b: Builder, scene: SceneTable, state: LiveMapState, e: ToolEvent, code: StationCode): void {
	const place = scene.places[STATION_PLACE[code]];
	const tone: Tone = e.success === false ? "error" : "normal";
	const p = place.droneTarget;
	switch (code) {
		case "FILES": {
			const orbit = spot(place, "documentOrbit", 0, p);
			if ((e.stationFlags & FLAG.write) !== 0) b.add("document-in", "files", [p, orbit], tone);
			else b.add("document-orbit", "files", [orbit], tone);
			return;
		}
		case "MEMORY":
			b.add("jar", "memory", [spot(place, "jars", hashIndex(e.toolUseId), p)], tone);
			return;
		case "SKILLS":
			b.add("scroll", "skills", [spot(place, "scrollStart", 0, p), coreCentre(scene)], tone);
			return;
		case "MCP": {
			const slot = wireSlot(Object.keys(state.scene.mcp), e.mcpServer, socketCount(scene));
			b.add("wire", "mcp", [spot(place, "sockets", slot, p)], tone);
			return;
		}
		case "EXTERNAL":
			b.add("beam", "external", fromCore(scene, place, spot(place, "beamTarget", 0, p)), tone);
			return;
		case "SANDBOX":
			b.add("bubbles", "sandbox", [spot(place, "experiment", 0, p)], tone);
			return;
		case "TESTING":
			b.add("verdict", "testing", [spot(place, "verdict", 0, p)], e.success === false ? "error" : "success");
			return;
		case "GIT":
			gitMove(b, place, (e.stationFlags & FLAG.deploy) !== 0 ? "deploy" : (e.stationFlags & FLAG.push) !== 0 ? "push" : "commit", tone);
			return;
		case "ORCHESTRATOR":
			if (AGENT_TOOLS.has(e.toolName)) b.add("drone-land", "orchestrator", [p, droneHome(scene)], tone);
			else b.add("board", "orchestrator", [spot(place, "taskBoard", 0, p)], tone);
			return;
		case "CORE":
			b.add("core-pulse", "core", [coreCentre(scene)], tone);
			return;
	}
}

function gitMove(b: Builder, place: ScenePlace, kind: string, tone: Tone): void {
	const p = place.droneTarget;
	if (kind === "deploy") {
		const pad = spot(place, "rocketLaunch", 0, p);
		b.add("rocket", "git", [pad, [pad[0], Math.max(0, pad[1] - 700)]], tone);
	} else if (kind === "push") {
		const belt = place.overlays.conveyor?.points;
		b.add("conveyor", "git", belt !== undefined && belt.length >= 2 ? belt : [p, p], tone);
	} else b.add("branch", "git", [spot(place, "branch", 0, p)], tone);
}

function apiErrorTone(state: LiveMapState, e: Extract<LiveMapEvent, { kind: "lifecycle" }>, at: number): Tone {
	const limited = e.number === RATE_LIMITED || e.flag === true;
	if (!limited) return "error";
	const repeated = state.log.some((x) => x.id !== e.id && x.kind === "lifecycle" && x.name === "api_error" && (x.number === RATE_LIMITED || x.flag === true) && x.at < at && x.at >= at - REPEAT_WINDOW_MS);
	return repeated ? "error" : "warn";
}

/** The moves one queued animation plays. `event` is the version of its source event the state holds now (undefined once folded out). */
export function movesOf(anim: Animation, event: LiveMapEvent | undefined, state: LiveMapState, scene: SceneTable): Move[] {
	const estimated = event?.kind === "tool" && (event.stationFlags & FLAG.estimated) !== 0;
	const b = builder(anim.eventId, estimated);
	const core = coreCentre(scene);
	const places = scene.places;
	const pulse = (): void => b.add("core-pulse", "core", [core]);
	if (event === undefined) {
		pulse();
		return b.moves;
	}
	switch (anim.cue) {
		case "prompt": {
			const desk = places["user-desk"];
			// The desk's flight path runs from the core to the desk: the envelope flies it backwards.
			const back = desk.flightPath.length >= 2 ? [...desk.flightPath].reverse() : [core];
			b.add("envelope", "user-desk", [spot(desk, "envelopeStart", 0, desk.droneTarget), ...back]);
			return b.moves;
		}
		case "tool-start":
		case "tool-end": {
			if (event.kind !== "tool") break;
			const code = stationOf(event.station);
			const place = places[STATION_PLACE[code]];
			const running = state.scene.stations[code].running;
			if (anim.cue === "tool-start") {
				if (event.agentId !== "") {
					if (code === "CORE") pulse();
					else b.add("drone-out", place.id, [droneHome(scene), queueSpot(place, running, event.id)]);
				} else if (code === "CORE") pulse();
				else if (code === "ORCHESTRATOR" && AGENT_TOOLS.has(event.toolName)) b.add("drone-launch", "orchestrator", [droneHome(scene), place.droneTarget]);
				else b.add("beam", place.id, fromCore(scene, place, queueSpot(place, running, event.id)));
				if (code === "SANDBOX") b.add("bubbles", "sandbox", [spot(place, "experiment", 0, place.droneTarget)]);
				if (code === "TESTING") b.add("screen", "testing", [spot(place, "verdict", 0, place.droneTarget)]);
				return b.moves;
			}
			if (event.agentId !== "" && code !== "ORCHESTRATOR" && code !== "CORE")
				b.add("drone-return", place.id, [place.droneTarget, droneHome(scene)], event.success === false ? "error" : "normal");
			toolResult(b, scene, state, event, code);
			return b.moves;
		}
		case "subagent-start":
			b.add("drone-launch", "orchestrator", [droneHome(scene), places.orchestrator.droneTarget]);
			return b.moves;
		case "subagent-end":
			b.add("drone-land", "orchestrator", [places.orchestrator.droneTarget, droneHome(scene)]);
			return b.moves;
		case "api": {
			const external = places.external;
			b.add("beam", "external", fromCore(scene, external, spot(external, "beamTarget", 0, external.droneTarget)));
			const screen = places.monitoring;
			b.add("monitor-dot", "monitoring", [spot(screen, "screen", 0, screen.droneTarget)]);
			return b.moves;
		}
		case "instruction": {
			const memory = places.memory;
			b.add("jar", "memory", [spot(memory, "jars", hashIndex(event.id), memory.droneTarget)]);
			return b.moves;
		}
		case "git":
			if (event.kind !== "git") break;
			gitMove(b, places.git, event.gitKind === "push" ? "push" : event.gitKind === "deploy" ? "deploy" : "commit", "normal");
			return b.moves;
		case "lifecycle": {
			if (event.kind !== "lifecycle") break;
			const security = places.security;
			const gate = spot(security, "gate", 0, security.droneTarget);
			const shield = spot(security, "shield", 0, security.droneTarget);
			const desk = places["user-desk"];
			switch (event.name) {
				case "permission_request":
					b.add("gate", "security", [gate], "warn");
					b.add("shield", "security", [shield], "warn");
					return b.moves;
				case "permission_decision":
				case "permission_denied":
				case "hook_block":
					b.add("shield", "security", [shield], "error");
					return b.moves;
				case "compact_start":
				case "compact_end":
					b.add("core-shrink", "core", [core], event.name === "compact_start" ? "warn" : "normal");
					return b.moves;
				case "stop_failure":
					b.add("core-red", "core", [core], "error");
					return b.moves;
				case "stop":
					b.add("desk-lamp", "user-desk", [spot(desk, "seat", 0, desk.droneTarget)], "success");
					return b.moves;
				case "notification":
					if (event.label === "permission_prompt") b.add("gate", "security", [gate], "warn");
					else if (event.label === "idle_prompt") b.add("desk-lamp", "user-desk", [spot(desk, "seat", 0, desk.droneTarget)], "success");
					else pulse();
					return b.moves;
				case "api_error": {
					const external = places.external;
					b.add("cloud-flicker", "external", [spot(external, "beamTarget", 0, external.droneTarget)], apiErrorTone(state, event, event.at), 3);
					return b.moves;
				}
				case "mcp_connection": {
					const mcp = places.mcp;
					const last = socketCount(scene) - 1;
					if (event.flag === true) b.add("wire-down", "mcp", [spot(mcp, "sockets", last, mcp.droneTarget)], "muted");
					else b.add("wire", "mcp", [spot(mcp, "sockets", last, mcp.droneTarget)]);
					return b.moves;
				}
				case "todo_counts":
					b.add("board", "orchestrator", [spot(places.orchestrator, "taskBoard", 0, places.orchestrator.droneTarget)]);
					return b.moves;
				default:
					pulse();
					return b.moves;
			}
		}
		case "bottleneck": {
			if (event.kind !== "bottleneck") break;
			const place = places[STATION_PLACE[stationOf(event.station)]];
			b.add("alert-ring", place.id, [place.droneTarget], !event.open ? "muted" : event.severity === "alert" ? "error" : "warn");
			return b.moves;
		}
	}
	pulse();
	return b.moves;
}

/** A still glow: a soft circle tinted by tone. */
export interface Glow {
	readonly key: string;
	readonly place: PlaceId;
	readonly at: Point;
	readonly tone: Tone;
	/** 0 to 1. */
	readonly alpha: number;
	/** Diameter in plate pixels. */
	readonly size: number;
}

/** The scene's still look: drawn again only when it changes. */
export interface SceneLook {
	readonly glows: readonly Glow[];
	/** Running calls waiting in a station's queue spots (beyond the first at its stop). */
	readonly queued: readonly Point[];
	/** Running subagents parked at the station of their latest call. */
	readonly drones: readonly Point[];
	/** The core turns while it thinks, at a speed from the last API request's tokens per second; null when still. */
	readonly spin: { readonly speed: number; readonly eventId: string } | null;
}

/**
 * The core stops turning when no event came this long, whatever its state:
 * a turn can end with no record at all (the person interrupted the model while
 * it thought), and an idle map draws no frame.
 */
export const CORE_SPIN_IDLE_MS = 2 * 60_000;

/** Turns per second of the core's ring at a given output speed: 0.15 at rest, up to 1.5. */
export function spinSpeed(tokensPerSecond: number | null): number {
	if (tokensPerSecond === null || tokensPerSecond <= 0) return 0.15;
	return Math.min(1.5, 0.15 + tokensPerSecond / 100);
}

export function lookOf(state: LiveMapState, scene: SceneTable): SceneLook {
	const glows: Glow[] = [];
	const s = state.scene;
	const places = scene.places;
	for (const [code, st] of Object.entries(s.stations) as [StationCode, (typeof s.stations)[StationCode]][]) {
		if (st.bottleneck === "none") continue;
		const place = places[STATION_PLACE[code]];
		glows.push({ key: `bottleneck:${code}`, place: place.id, at: centreOf(place.hit), tone: st.bottleneck === "alert" ? "error" : "warn", alpha: 0.55, size: 520 });
	}
	const core = state.live?.core ?? s.core;
	if (core === "waiting_user") {
		const desk = places["user-desk"];
		glows.push({ key: "desk-lamp", place: "user-desk", at: spot(desk, "seat", 0, desk.droneTarget), tone: "success", alpha: 0.5, size: 260 });
	}
	const waiting = core === "waiting_permission" || Object.values(s.stations).some((st) => st.queued > 0);
	if (waiting) {
		const security = places.security;
		glows.push({ key: "gate-closed", place: "security", at: spot(security, "shield", 0, security.droneTarget), tone: "warn", alpha: 0.6, size: 300 });
	}
	const percent = state.live?.contextPercent ?? null;
	if (percent !== null && percent > 0) {
		const fill = Math.min(1, percent / 100);
		glows.push({ key: "core-fill", place: "core", at: coreCentre(scene), tone: fill >= 0.8 ? "warn" : "normal", alpha: 0.2 + 0.4 * fill, size: 260 + 260 * fill });
	}
	if (core === "failed") glows.push({ key: "core-failed", place: "core", at: coreCentre(scene), tone: "error", alpha: 0.5, size: 520 });
	const servers = Object.keys(s.mcp);
	const sockets = socketCount(scene);
	for (const [server, wire] of Object.entries(s.mcp)) {
		if (wire.running <= 0) continue;
		const slot = wireSlot(servers, server, sockets);
		glows.push({ key: `wire:${slot}`, place: "mcp", at: spot(places.mcp, "sockets", slot, places.mcp.droneTarget), tone: "normal", alpha: 0.7, size: 90 });
	}
	const queued: Point[] = [];
	for (const [code, st] of Object.entries(s.stations) as [StationCode, (typeof s.stations)[StationCode]][]) {
		const place = places[STATION_PLACE[code]];
		for (let i = 1; i < st.running.length && i <= place.queue.length; i++) {
			const q = place.queue[i - 1];
			if (q !== undefined) queued.push(q);
		}
	}
	const drones: Point[] = [];
	for (const sub of Object.values(s.subagents)) {
		if (!sub.running) continue;
		drones.push(places[STATION_PLACE[sub.station]].droneTarget);
	}
	const newest = state.log[state.log.length - 1];
	const spin = core === "thinking" && newest !== undefined ? { speed: spinSpeed(state.live?.tokensPerSecond ?? s.tokensPerSecond), eventId: newest.id } : null;
	// One glow per key: a later one of the same key would only hide the first.
	const seen = new Set<string>();
	return { glows: glows.filter((g) => (seen.has(g.key) ? false : (seen.add(g.key), true))), queued, drones, spin };
}

/** Two looks draw the same picture. */
export function sameLook(a: SceneLook, b: SceneLook): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Calls beyond the queue's spots at each place ("+n"). */
export function queueOverflow(state: LiveMapState, scene: SceneTable): Partial<Record<PlaceId, number>> {
	const out: Partial<Record<PlaceId, number>> = {};
	for (const [code, st] of Object.entries(state.scene.stations) as [StationCode, (typeof state.scene.stations)[StationCode]][]) {
		const place = scene.places[STATION_PLACE[code]];
		const extra = st.running.length - 1 - place.queue.length;
		if (extra > 0) out[place.id] = extra;
	}
	return out;
}

/** The point at `t` (0 to 1) along a path of straight legs, by length. */
export function pathPoint(path: readonly Point[], t: number): Point {
	const first = path[0];
	if (first === undefined) return [0, 0];
	if (path.length === 1 || t <= 0) return first;
	const legs: number[] = [];
	let total = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] ?? first;
		const b = path[i] ?? a;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		legs.push(len);
		total += len;
	}
	if (total === 0) return first;
	let left = Math.min(1, t) * total;
	for (let i = 0; i < legs.length; i++) {
		const len = legs[i] ?? 0;
		const a = path[i] ?? first;
		const b = path[i + 1] ?? a;
		if (left <= len || i === legs.length - 1) {
			const f = len === 0 ? 1 : Math.min(1, left / len);
			return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
		}
		left -= len;
	}
	return path[path.length - 1] ?? first;
}

// What the session's events make the Live Map's city do (pure: nothing here
// reads a clock or draws). Two outputs:
//
// - movesOf: the short moves an arriving event plays (each names its source
//   event, so a click on it opens that event): a packet of energy along a
//   district's road (out when a call starts, back when it ends, red when it
//   failed), or a pulse at a place (the core thinking, a drone leaving, a
//   deploy, a bottleneck's alarm). The animation director times them.
// - lookOf: the scene's look from the state: what the AI is doing (think,
//   exec, wait, idle), each road's numbers (width by calls, red share by
//   failures, the running calls on it with the moment each passes the
//   session's p95 of its kind, a bottleneck), each district's presence
//   (main districts bright, background ones dim until used; districts not
//   involved dim while the AI works), the drones (running subagents) and the
//   district each flies to, the context's fill, the release pipeline.
//
// Geometry the renderer and the DOM share also lives here: a point along a
// road, dashes along it, a drone's flight path, the holographic board above a
// district, the pipeline's slots on the Git district.
import { FLAG, historyBefore, modeOf, percentile, runningCalls, toolCalls, type ActivityMode, type ToolCall } from "../call-history.ts";
import type { Animation, LiveMapState } from "../live-map-state.ts";
import type { LiveMapEvent } from "../live-map-types.ts";
import { pipelineOf, type Pipeline } from "../pipeline-model.ts";
import { stationOf, STATION_CODES, type StationCode } from "../station-catalog.ts";
import type { Activity } from "./camera-director.ts";
import { PLACE_IDS, STATION_PLACE, type PlaceId, type Point, type Rect, type SceneTable } from "./scene-table.ts";

export { FLAG };

export type MotionKind = "packet-out" | "packet-back" | "pulse" | "alarm" | "batch";
export type Tone = "normal" | "success" | "warn" | "error" | "muted";

export interface Move {
	readonly eventId: string;
	readonly place: PlaceId;
	readonly kind: MotionKind;
	readonly tone: Tone;
	/** Where it goes, in scene pixels; one point for a move that stays in place. */
	readonly path: readonly Point[];
	readonly durationMs: number;
	/** The event's station was worked out from a filtered target and may be wrong. */
	readonly estimated: boolean;
}

export const DURATION_MS: Readonly<Record<MotionKind, number>> = { "packet-out": 700, "packet-back": 700, pulse: 700, alarm: 1_000, batch: 1_200 };

/**
 * The model stops thinking on the scene when no event came this long, whatever
 * its state: a turn can end with no record at all (the person interrupted the
 * model while it thought).
 */
export const CORE_SPIN_IDLE_MS = 2 * 60_000;

/** A place's centre: the core's base for the core and the drones' area, the rect's middle otherwise. */
export function placeCentre(scene: SceneTable, place: PlaceId): Point {
	if (place === "core" || place === "orchestrator") return scene.core.centre;
	const r = scene.places[place].rect;
	return [r.x + r.w / 2, r.y + r.h / 2];
}

/** A place's road: its route, or a single point at its centre when it has none. */
export function roadOf(scene: SceneTable, place: PlaceId): readonly Point[] {
	const route = scene.places[place].route;
	return route.length >= 2 ? route : [placeCentre(scene, place)];
}

function builder(eventId: string, estimated: boolean) {
	const moves: Move[] = [];
	const add = (kind: MotionKind, place: PlaceId, path: readonly Point[], tone: Tone = "normal"): void => {
		moves.push({ eventId, place, kind, tone, path, durationMs: DURATION_MS[kind], estimated });
	};
	return { moves, add };
}

/** The moves one queued animation plays. `event` is the version of its source event the state holds now (undefined once folded out). */
export function movesOf(anim: Animation, event: LiveMapEvent | undefined, scene: SceneTable): Move[] {
	const estimated = event?.kind === "tool" && (event.stationFlags & FLAG.estimated) !== 0;
	const { moves, add } = builder(anim.eventId, estimated);
	const core = scene.core.centre;
	const out = (place: PlaceId, tone: Tone = "normal"): void => {
		const road = roadOf(scene, place);
		if (road.length >= 2) add("packet-out", place, road, tone);
		else add("pulse", place, road, tone);
	};
	const back = (place: PlaceId, tone: Tone = "normal"): void => {
		const road = roadOf(scene, place);
		if (road.length >= 2) add("packet-back", place, [...road].reverse(), tone);
		else add("pulse", place, road, tone);
	};
	const pulse = (place: PlaceId, tone: Tone = "normal"): void => add("pulse", place, [placeCentre(scene, place)], tone);
	if (event === undefined) {
		add("pulse", "core", [core]);
		return moves;
	}
	switch (anim.cue) {
		case "prompt":
			back("user-desk");
			return moves;
		case "tool-start":
		case "tool-end": {
			if (event.kind !== "tool") break;
			const place = STATION_PLACE[stationOf(event.station)];
			if (anim.cue === "tool-start") out(place);
			else back(place, event.success === false ? "error" : "normal");
			return moves;
		}
		case "subagent-start":
		case "subagent-end":
			pulse("orchestrator");
			return moves;
		case "api":
			pulse("core");
			return moves;
		case "instruction":
			back("memory");
			return moves;
		case "git":
			pulse("git");
			return moves;
		case "lifecycle": {
			if (event.kind !== "lifecycle") break;
			switch (event.name) {
				case "permission_request":
					out("security", "warn");
					return moves;
				case "permission_decision":
					back("security", "success");
					return moves;
				case "permission_denied":
				case "hook_block":
					back("security", "error");
					return moves;
				case "compact_start":
				case "compact_end":
					pulse("monitoring", "warn");
					return moves;
				case "stop":
					pulse("user-desk", "success");
					return moves;
				case "stop_failure":
					pulse("core", "error");
					return moves;
				case "api_error":
					pulse("external", event.number === 429 ? "warn" : "error");
					return moves;
				case "ci_started":
					pulse("git");
					return moves;
				case "ci_finished":
					pulse("git", event.flag === false ? "error" : "success");
					return moves;
				default:
					pulse("core");
					return moves;
			}
		}
		case "bottleneck": {
			if (event.kind !== "bottleneck") break;
			add("alarm", STATION_PLACE[stationOf(event.station)], [placeCentre(scene, STATION_PLACE[stationOf(event.station)])], !event.open ? "muted" : event.severity === "alert" ? "error" : "warn");
			return moves;
		}
	}
	add("pulse", "core", [core]);
	return moves;
}

/** What the camera's auto mode follows, from the state. */
export function activityOf(state: LiveMapState): Activity {
	const mode = modeOf(state);
	const running = runningCalls(state);
	let newest: ToolCall | null = null;
	for (const c of running) if (newest === null || c.event.at >= newest.event.at) newest = c;
	return { mode, newestPlace: newest === null ? null : STATION_PLACE[newest.station], testing: running.some((c) => c.station === "TESTING") };
}

/** A call running on a road: who runs it and when it passes its kind's p95 of the session (null: no history yet). */
export interface RoadJob {
	readonly eventId: string;
	/** "" for the main agent (energy from the core), else the subagent (energy from its drone). */
	readonly agentId: string;
	/** Machine ms. */
	readonly startedAt: number;
	readonly overAt: number | null;
}

export interface RoadLook {
	readonly place: PlaceId;
	readonly path: readonly Point[];
	/** Calls that ended there (prompts at the input port, permission requests at the lock). */
	readonly calls: number;
	readonly failures: number;
	/** The session's p95 of the calls that ended there; null before any. */
	readonly p95Ms: number | null;
	readonly running: readonly RoadJob[];
	/** Energy flows though no call runs (a permission the person has to answer). */
	readonly waiting: boolean;
	readonly bottleneck: "none" | "warn" | "alert";
}

export interface PlaceLook {
	/** 0 to 1. */
	readonly presence: number;
	/** A call runs there (or the person is asked, at the lock). */
	readonly active: boolean;
	/** In the AI's current zone (a test run brings the terminal, a permission the core). */
	readonly involved: boolean;
	/** Used in this session. */
	readonly used: boolean;
	readonly bottleneck: "none" | "warn" | "alert";
}

export interface DroneLook {
	readonly agentId: string;
	readonly agentType: string;
	/** Where it is going: the district of its running call, else home (the drones' area by the core). */
	readonly target: PlaceId;
	/** Its order among the running subagents (where it idles on the orbit). */
	readonly slot: number;
}

export interface SceneLook {
	readonly mode: ActivityMode;
	readonly roads: readonly RoadLook[];
	readonly places: Readonly<Record<PlaceId, PlaceLook>>;
	readonly drones: readonly DroneLook[];
	/** 0 to 100; null when unknown. */
	readonly contextPercent: number | null;
	readonly tokensPerSecond: number | null;
	readonly pipeline: Pipeline;
	/** The newest event while the model thinks (its spin stops CORE_SPIN_IDLE_MS after it); null otherwise. */
	readonly thinkingFor: string | null;
}

const TIER_ALPHA = { 1: 1, 2: 0.9, 3: 0.7 } as const;
/** Places framed together with a zone (a test run with the terminal, a permission with the core). */
const INVOLVED: Partial<Record<PlaceId, readonly PlaceId[]>> = { testing: ["testing", "sandbox"], security: ["security", "core"] };

const stationAt = (place: PlaceId): StationCode | undefined => STATION_CODES.find((code) => STATION_PLACE[code] === place);

function roadsOf(state: LiveMapState, scene: SceneTable, calls: readonly ToolCall[], running: readonly ToolCall[], waiting: boolean): RoadLook[] {
	const prompts = state.log.filter((e) => e.kind === "prompt").length;
	const asks = state.log.filter((e) => e.kind === "lifecycle" && e.name === "permission_request").length;
	const out: RoadLook[] = [];
	for (const id of PLACE_IDS) {
		const place = scene.places[id];
		if (place.route.length < 2) continue;
		const station = stationAt(id);
		const ended = station === undefined ? [] : calls.filter((c) => c.station === station && c.endAt !== undefined);
		const durations = ended.map((c) => c.event.durationMs ?? (c.endAt ?? c.event.at) - c.event.at);
		const jobs: RoadJob[] = running
			.filter((c) => c.station === station)
			.map((c) => {
				const history = historyBefore(calls, c.key, { id: c.event.id, endAt: undefined });
				return { eventId: c.event.id, agentId: c.event.agentId, startedAt: c.event.at, overAt: history === null ? null : c.event.at + history.p95Ms };
			});
		out.push({
			place: id,
			path: place.route,
			calls: id === "user-desk" ? prompts : id === "security" ? asks : ended.length,
			failures: ended.filter((c) => c.ok === false).length,
			p95Ms: percentile(durations, 0.95),
			running: jobs,
			waiting: id === "security" && waiting,
			bottleneck: station === undefined ? "none" : state.scene.stations[station].bottleneck,
		});
	}
	return out;
}

export function lookOf(state: LiveMapState, scene: SceneTable): SceneLook {
	const mode = modeOf(state);
	const calls = toolCalls(state);
	const running = runningCalls(state);
	const roads = roadsOf(state, scene, calls, running, mode === "wait");
	const activity = activityOf(state);
	const zone = activity.mode === "wait" ? "security" : activity.mode === "think" ? "core" : activity.testing ? "testing" : activity.newestPlace;
	const involved = new Set<PlaceId>(zone === null ? [] : (INVOLVED[zone] ?? [zone]));
	for (const c of running) involved.add(STATION_PLACE[c.station]);
	const places = {} as Record<PlaceId, PlaceLook>;
	for (const id of PLACE_IDS) {
		const p = scene.places[id];
		const station = stationAt(id);
		const st = station === undefined ? undefined : state.scene.stations[station];
		const used = (st?.calls ?? 0) > 0 || (st?.running.length ?? 0) > 0 || roads.some((r) => r.place === id && r.calls > 0);
		const active = (st?.running.length ?? 0) > 0 || (id === "security" && mode === "wait");
		let presence: number = TIER_ALPHA[p.tier];
		if (p.tier === 3 && !used && !active) presence *= 0.75;
		if (mode !== "idle" && !involved.has(id) && !active) presence *= 0.45;
		places[id] = { presence, active, involved: involved.has(id), used, bottleneck: st?.bottleneck ?? "none" };
	}
	const subagents = Object.values(state.scene.subagents).filter((s) => s.running);
	const drones = subagents.map((s, slot): DroneLook => {
		const call = running.filter((c) => c.event.agentId === s.agentId).at(-1);
		return { agentId: s.agentId, agentType: s.agentType, target: call === undefined ? "orchestrator" : STATION_PLACE[call.station], slot };
	});
	const newest = state.log[state.log.length - 1];
	return {
		mode,
		roads,
		places,
		drones,
		contextPercent: state.live?.contextPercent ?? null,
		tokensPerSecond: state.live?.tokensPerSecond ?? state.scene.tokensPerSecond,
		pipeline: pipelineOf(state.log),
		thinkingFor: mode === "think" && newest !== undefined ? newest.id : null,
	};
}

/** Two looks draw the same picture. */
export function sameLook(a: SceneLook, b: SceneLook): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The road's width (scene px) for a number of calls: thin when unused, thicker with use. */
export function roadWidth(calls: number): number {
	return 2.4 + Math.min(14, Math.log2(1 + calls) * 3.4);
}

function lengths(path: readonly Point[]): { legs: number[]; total: number } {
	const legs: number[] = [];
	let total = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1] ?? [0, 0];
		const b = path[i] ?? a;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		legs.push(len);
		total += len;
	}
	return { legs, total };
}

export function pathLength(path: readonly Point[]): number {
	return lengths(path).total;
}

/** The point at `t` (0 to 1) along a path of straight legs, by length. */
export function pathPoint(path: readonly Point[], t: number): Point {
	const first = path[0];
	if (first === undefined) return [0, 0];
	if (path.length === 1 || t <= 0) return first;
	const { legs, total } = lengths(path);
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

/** The part of a path from its start to `t` (0 to 1) of its length. */
export function subPath(path: readonly Point[], t: number): Point[] {
	const first = path[0];
	if (first === undefined) return [];
	const { legs, total } = lengths(path);
	const out: Point[] = [first];
	let left = Math.max(0, Math.min(1, t)) * total;
	for (let i = 0; i < legs.length; i++) {
		const len = legs[i] ?? 0;
		const a = path[i] ?? first;
		const b = path[i + 1] ?? a;
		if (left >= len) {
			out.push(b);
			left -= len;
		} else {
			const f = len === 0 ? 0 : left / len;
			out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
			break;
		}
	}
	return out;
}

/** Dashes along a path: `dash` on, `gap` off, starting `offset` along it (an offset growing with time makes them flow). */
export function dashes(path: readonly Point[], dash: number, gap: number, offset: number): Array<[Point, Point]> {
	const { total } = lengths(path);
	const period = dash + gap;
	if (total === 0 || period <= 0) return [];
	const out: Array<[Point, Point]> = [];
	let start = (((offset % period) + period) % period) - period;
	for (; start < total; start += period) {
		const a = Math.max(0, start);
		const b = Math.min(total, start + dash);
		if (b > a) out.push([pathPoint(path, a / total), pathPoint(path, b / total)]);
	}
	return out;
}

/** Where a drone idles: its slot on the ellipse around the core's base, turning slowly with `turn` (radians). */
export function orbitPoint(scene: SceneTable, slot: number, turn: number): Point {
	const [cx, cy] = scene.core.centre;
	const [rx, ry] = scene.core.orbit;
	const a = turn + slot * 2.1;
	return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
}

/** Where a drone hovers over a district while its call runs: above the road's end. */
export function hoverPoint(scene: SceneTable, place: PlaceId): Point {
	const road = roadOf(scene, place);
	const end = road[road.length - 1] ?? scene.core.centre;
	return [end[0], end[1] - 70];
}

/** A drone's flight from `from` to `to`: along the roads, through the core's base when it changes district. */
export function dronePath(scene: SceneTable, from: Point, fromPlace: PlaceId, to: PlaceId, home: Point): Point[] {
	const goingHome = to === "orchestrator" || to === "core";
	const leave = fromPlace === "orchestrator" || fromPlace === "core" ? [] : [...roadOf(scene, fromPlace)].reverse();
	const arrive = goingHome ? [home] : [...roadOf(scene, to), hoverPoint(scene, to)];
	return [from, ...leave, ...arrive];
}

/** The holographic board above a district (scene px): where its live content shows. */
export function holoPanelRect(scene: SceneTable, place: PlaceId): Rect {
	const r = place === "orchestrator" ? scene.places.core.rect : scene.places[place].rect;
	const w = Math.min(560, Math.max(380, r.w * 0.9));
	const h = 190;
	const x = Math.min(scene.space.width - w, Math.max(0, r.x + r.w / 2 - w / 2));
	const y = Math.max(0, Math.min(scene.space.height - h, r.y - h * 0.55));
	return { x, y, w, h };
}

/** The four release steps' slots on the Git district and prod's light, in scene px. */
export function pipelineSlots(scene: SceneTable): { readonly steps: readonly Rect[]; readonly prod: Point } {
	const r = scene.places.git.rect;
	const top = r.y + r.h - 64;
	const gap = 14;
	const prodRoom = 44;
	const w = (r.w - 24 - prodRoom - gap * 4) / 4;
	const steps = [0, 1, 2, 3].map((i) => ({ x: r.x + 12 + i * (w + gap), y: top, w, h: 44 }));
	return { steps, prod: [r.x + r.w - 12 - prodRoom / 2, top + 22] };
}

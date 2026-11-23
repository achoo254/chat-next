// Replaying a watched Claude Code session (pure functions, no clock): the
// session's stored events, held in (at, id) order one version per id, and the
// Live Map's state at any moment T rebuilt from them with the live view's own
// reducer (live-map-state.ts `foldScene`), so the scene at T is the scene a
// live view showed at T.
//
// A stored event is its final version: a tool call that ended, a subagent that
// stopped, a finding that closed. A live view at T held the version of that
// moment, so each event is folded as it stood at T:
// - a tool call that ended after T (its start plus its duration) was running;
// - a subagent that stopped after T was running;
// - a finding (it stands at `opened_at`) was open unless it closed at or
//   before T; one raised or lowered after T (`updated_at` past T while it is
//   still open) had the other level. A closed finding keeps its last level:
//   its closing overwrote the time of its last change.
// The machine's live state at T (core, speed, context, running calls, open
// findings) follows the machine's rule over the same events
// (hub/live-state.ts, docs/observatory-wire.md section 6.3), with the
// context window of model-window.ts and its "assumed" flag.
//
// History: the snapshot's events, older pages asked until the session's start
// (`needsEarlier`, `pageBack`), and live events arriving while replaying
// (`withLive`: held, the replayed moment does not move). A stored version
// replaces a provisional one with the same id whatever the arrival order; a
// provisional version never replaces a stored one. At most
// REPLAY_BUFFER_CAP events are held: paging back stops there (`partial`, the
// replay starts at the oldest event held), and live events past it fold the
// oldest thousand into the base scene. Every CHECKPOINT_EVERY events the
// scene so far is kept, so a moment is rebuilt from the nearest checkpoint,
// not from the start.
//
// Playing follows the events' own clock times 1x, 4x or 16x; a silence
// longer than SILENCE_MS between two events plays in SILENCE_PLAYED_MS.
import { coreOf, emptyScene, foldScene, LOG_CAP, type LiveMapScene, type LiveMapState } from "./live-map-state.ts";
import type { LiveMapEvent, LiveMapLiveState, LiveMapSessionInfo, LiveMapSnapshot } from "./live-map-types.ts";
import { contextWindowOf } from "./model-window.ts";
import { STATION_CODES, stationOf, type StationCode } from "./station-catalog.ts";

/** The most events a replay holds. */
export const REPLAY_BUFFER_CAP = 20_000;
/** A checkpoint of the scene every this many events. */
export const CHECKPOINT_EVERY = 1_000;
/** A silence longer than this between two events… */
export const SILENCE_MS = 10_000;
/** …plays in this long. */
export const SILENCE_PLAYED_MS = 1_000;
export const REPLAY_SPEEDS = [1, 4, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** The machine keeps a session's events this long after it ended (then only its totals). */
export const DETAIL_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Events that are kept and replayed (the session's own row and unknown kinds are not). */
type HeldEvent = Exclude<LiveMapEvent, { kind: "session" } | { kind: "unknown" }>;
type ApiEvent = Extract<LiveMapEvent, { kind: "api" }>;

function isHeld(e: LiveMapEvent): e is HeldEvent {
	return e.kind !== "session" && e.kind !== "unknown";
}

/** The main thread's latest API request and the largest context it carried so far. */
interface ContextSoFar {
	readonly largest: number;
	readonly lastModel: string;
	/** The context of the latest request; undefined when no request yet, or it did not say. */
	readonly lastTokens: number | undefined;
	readonly anyRequest: boolean;
}

const NO_CONTEXT: ContextSoFar = { largest: 0, lastModel: "", lastTokens: undefined, anyRequest: false };

interface Checkpoint {
	/** The scene of events[0..index) on top of the history's base. */
	readonly index: number;
	readonly scene: LiveMapScene;
	readonly context: ContextSoFar;
	/** Every event before `index` had its final version by then. */
	readonly settled: number;
}

export interface ReplayHistory {
	readonly sessionId: string;
	readonly epoch: bigint;
	readonly info: LiveMapSessionInfo | null;
	/** One version per id, ordered by (at, id), `seq` 0. */
	readonly events: readonly HeldEvent[];
	readonly byId: ReadonlyMap<string, HeldEvent>;
	/** Where older events start; "" when none is older. */
	readonly earlier: string;
	/** Older events were left out (REPLAY_BUFFER_CAP): the replay starts at the oldest event held. */
	readonly partial: boolean;
	/** Events at or before this were folded into the base (checkpoints[0]) and are not held. */
	readonly floor: { readonly at: number; readonly id: string } | null;
	/** checkpoints[0] is the base (index 0); then one every CHECKPOINT_EVERY events. */
	readonly checkpoints: readonly Checkpoint[];
}

/** (at, id) order, as live-map-state.ts keeps its log. */
function compare(a: { at: number; id: string }, b: { at: number; id: string }): number {
	if (a.at !== b.at) return a.at - b.at;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The context an API request carried (input, cache read, both cache writes),
 * when its event says; live-map-types.ts reads it into `contextTokens`.
 */
export function contextTokensOf(e: ApiEvent): number | undefined {
	return "contextTokens" in e && typeof e.contextTokens === "number" ? e.contextTokens : undefined;
}

function withContext(so: ContextSoFar, events: readonly HeldEvent[]): ContextSoFar {
	let out = so;
	for (const e of events) {
		if (e.kind !== "api" || e.agentId !== "") continue;
		const tokens = contextTokensOf(e);
		out = { largest: Math.max(out.largest, tokens ?? 0), lastModel: e.model, lastTokens: tokens, anyRequest: true };
	}
	return out;
}

/** When an event reached the version it is held in. */
function settledAt(e: HeldEvent): number {
	switch (e.kind) {
		case "tool":
			return e.success === undefined ? e.at : e.at + (e.durationMs ?? 0);
		case "subagent":
			return Math.max(e.at, e.endedAt);
		case "bottleneck":
			return Math.max(e.at, e.updatedAt, e.closedAt);
		default:
			return e.at;
	}
}

/** The version of `e` (at or before `at`) a live view held at `at`. */
function versionAt(e: HeldEvent, at: number): HeldEvent {
	if (settledAt(e) <= at) return e;
	switch (e.kind) {
		case "tool": {
			if (e.success === undefined) return e;
			const { success: _success, durationMs: _duration, ...running } = e;
			return running;
		}
		case "subagent":
			return { ...e, endedAt: 0 };
		case "bottleneck": {
			const open = e.closedAt === 0 || e.closedAt > at;
			// Changed after `at` while open: it had the other level until then.
			const changedLater = e.updatedAt > at && e.updatedAt > e.openedAt && e.updatedAt !== e.closedAt;
			const severity = changedLater ? (e.severity === "alert" ? "warn" : "alert") : e.severity;
			return { ...e, open, severity, closedAt: open ? 0 : e.closedAt };
		}
		default:
			return e;
	}
}

function settledOf(events: readonly HeldEvent[], from: number): number {
	let settled = from;
	for (const e of events) settled = Math.max(settled, settledAt(e));
	return settled;
}

/** Checkpoints from the last of `kept` to the end of `events`. */
function extended(kept: readonly Checkpoint[], events: readonly HeldEvent[]): Checkpoint[] {
	const out = [...kept];
	let last = out[out.length - 1];
	if (last === undefined) throw new Error("a replay history has a base checkpoint");
	for (let k = last.index + CHECKPOINT_EVERY; k <= events.length; k += CHECKPOINT_EVERY) {
		const slice = events.slice(k - CHECKPOINT_EVERY, k);
		last = { index: k, scene: foldScene(last.scene, slice), context: withContext(last.context, slice), settled: settledOf(slice, last.settled) };
		out.push(last);
	}
	return out;
}

const baseCheckpoint = (scene: LiveMapScene, context: ContextSoFar, settled: number): Checkpoint => ({ index: 0, scene, context, settled });

/**
 * `incoming` into the history. `older`: a page of older events (when the cap
 * is passed the oldest are left out), else live events (the oldest are folded
 * into the base).
 */
function merged(h: ReplayHistory, incoming: readonly LiveMapEvent[], older: boolean): ReplayHistory {
	let info = h.info;
	const byId = new Map(h.byId);
	const fresh: HeldEvent[] = [];
	let replaced = false;
	for (const e of incoming) {
		if (e.kind === "session") {
			info = e.info ?? info;
			continue;
		}
		if (!isHeld(e)) continue;
		if (h.floor !== null && compare(e, h.floor) <= 0) continue;
		const held = byId.get(e.id);
		// The stored version wins over a provisional one, whatever came first.
		if (held !== undefined && !held.provisional && e.provisional) continue;
		const event: HeldEvent = e.seq === 0 ? e : { ...e, seq: 0 };
		if (held !== undefined) replaced = true;
		byId.set(e.id, event);
		fresh.push(event);
	}
	if (fresh.length === 0) return info === h.info ? h : { ...h, info };

	let events: HeldEvent[];
	const last = h.events[h.events.length - 1];
	const sortedFresh = [...fresh].sort(compare);
	const first = sortedFresh[0];
	if (!replaced && first !== undefined && (last === undefined || compare(first, last) > 0) && new Set(fresh.map((e) => e.id)).size === fresh.length) {
		events = [...h.events, ...sortedFresh];
	} else {
		events = [...byId.values()].sort(compare);
	}

	let checkpoints: readonly Checkpoint[];
	let floor = h.floor;
	let partial = h.partial;
	if (events.length > REPLAY_BUFFER_CAP) {
		if (older) {
			const dropped = events.slice(0, events.length - REPLAY_BUFFER_CAP);
			events = events.slice(dropped.length);
			for (const e of dropped) byId.delete(e.id);
			const newest = dropped[dropped.length - 1];
			if (newest !== undefined) floor = { at: newest.at, id: newest.id };
			partial = true;
			checkpoints = [baseCheckpoint(emptyScene(), NO_CONTEXT, Number.NEGATIVE_INFINITY)];
		} else {
			// Fold a whole checkpoint's worth at once, so this happens once per CHECKPOINT_EVERY live events.
			const dropped = events.slice(0, events.length - REPLAY_BUFFER_CAP + CHECKPOINT_EVERY);
			events = events.slice(dropped.length);
			for (const e of dropped) byId.delete(e.id);
			const base = h.checkpoints[0];
			if (base === undefined) throw new Error("a replay history has a base checkpoint");
			checkpoints = [baseCheckpoint(foldScene(base.scene, dropped), withContext(base.context, dropped), settledOf(dropped, base.settled))];
			const newest = dropped[dropped.length - 1];
			if (newest !== undefined) floor = { at: newest.at, id: newest.id };
		}
	} else {
		// Checkpoints before the first changed event still hold.
		let same = 0;
		while (same < events.length && same < h.events.length && events[same] === h.events[same]) same += 1;
		checkpoints = h.checkpoints.filter((c) => c.index <= same);
	}
	return { ...h, info, events, byId, floor, partial, checkpoints: extended(checkpoints, events) };
}

/** A replay's history starting from a watch's snapshot. */
export function historyOf(snapshot: LiveMapSnapshot): ReplayHistory {
	const empty: ReplayHistory = {
		sessionId: snapshot.sessionId,
		epoch: snapshot.epoch,
		info: snapshot.info,
		events: [],
		byId: new Map(),
		earlier: snapshot.earlier,
		partial: false,
		floor: null,
		checkpoints: [baseCheckpoint(emptyScene(), NO_CONTEXT, Number.NEGATIVE_INFINITY)],
	};
	return merged(empty, snapshot.events, false);
}

/** Live events of the watched session, held while replaying. */
export function withLive(h: ReplayHistory, events: readonly LiveMapEvent[]): ReplayHistory {
	return merged(h, events, false);
}

/** A page of older events (ObservatoryEarlier) and where the next older page starts. */
export function withPage(h: ReplayHistory, events: readonly LiveMapEvent[], earlier: string): ReplayHistory {
	const next = merged(h, events, true);
	return { ...next, earlier };
}

/** Older events must be asked before the history starts at the session's start. */
export function needsEarlier(h: ReplayHistory): boolean {
	return h.earlier !== "" && !h.partial;
}

/** A page of older events as the machine answers it (observatory-client.ts `earlierEvents`). */
export type EarlierPage = (earlier: string) => Promise<{ readonly events: readonly LiveMapEvent[]; readonly earlier: string }>;

/**
 * Asks older pages until the history starts at the session's start (or holds
 * REPLAY_BUFFER_CAP events). A page that does not move the cursor ends it.
 * `stillWanted` is checked between pages: false stops asking.
 */
export async function pageBack(h: ReplayHistory, page: EarlierPage, stillWanted: () => boolean = () => true): Promise<ReplayHistory> {
	let history = h;
	while (needsEarlier(history) && stillWanted()) {
		const answer = await page(history.earlier);
		const moved = answer.earlier !== history.earlier;
		history = withPage(history, answer.events, moved ? answer.earlier : "");
	}
	return history;
}

/** The number of held events at or before `at`. */
function countUpTo(events: readonly HeldEvent[], at: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const e = events[mid];
		if (e !== undefined && e.at <= at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The session's row as of `at`: not ended yet when it ended later. */
function infoAt(info: LiveMapSessionInfo | null, at: number): LiveMapSessionInfo | null {
	return info !== null && info.endedAt > at ? { ...info, endedAt: 0 } : info;
}

/** The session as a whole at a replayed moment, by the machine's rule. */
function liveAt(state: Pick<LiveMapState, "scene" | "info" | "newestAt">, context: ContextSoFar): LiveMapLiveState {
	const mainModel = context.lastModel !== "" ? context.lastModel : (state.info?.mainModel ?? "");
	const window = contextWindowOf(mainModel, context.largest);
	const tokens = context.anyRequest ? context.lastTokens : undefined;
	const running: { station: string; count: number }[] = [];
	for (const code of [...STATION_CODES].sort()) {
		const count = state.scene.stations[code].running.length;
		if (count > 0) running.push({ station: code, count });
	}
	return {
		core: coreOf(state),
		tokensPerSecond: state.scene.tokensPerSecond,
		contextPercent: window !== undefined && tokens !== undefined ? (tokens / window.tokens) * 100 : null,
		contextTokens: tokens ?? 0,
		contextWindow: window?.tokens ?? 0,
		contextWindowAssumed: window?.assumed ?? false,
		mainModel,
		running,
		openBottlenecks: state.scene.bottlenecks.size,
	};
}

/** The Live Map's state at `at`: what a live view showed then. No animation is queued. */
export function stateAt(h: ReplayHistory, at: number): LiveMapState {
	const upTo = countUpTo(h.events, at);
	let from = h.checkpoints[0];
	if (from === undefined) throw new Error("a replay history has a base checkpoint");
	for (const c of h.checkpoints) if (c.index > 0 && c.index <= upTo && c.settled <= at) from = c;
	const versions = h.events.slice(from.index, upTo).map((e) => versionAt(e, at));
	// Kept like the live state: at most LOG_CAP events in the log, the rest in the base.
	const logStart = Math.max(0, versions.length - LOG_CAP);
	const base = logStart === 0 ? from.scene : foldScene(from.scene, versions.slice(0, logStart));
	const log = versions.slice(logStart);
	const scene = foldScene(base, log);
	const beforeLog = h.events[from.index + logStart - 1];
	const floor = beforeLog === undefined ? h.floor : { at: beforeLog.at, id: beforeLog.id };
	const newest = h.events[upTo - 1];
	const newestAt = newest?.at ?? h.floor?.at ?? 0;
	const info = infoAt(h.info, at);
	return {
		sessionId: h.sessionId,
		epoch: h.epoch,
		seq: 0,
		info,
		live: liveAt({ scene, info, newestAt }, withContext(from.context, versions)),
		earlier: h.earlier,
		log,
		floor,
		base,
		scene,
		newestAt,
		animations: [],
	};
}

/** The replay's span and its events' times, oldest first. */
export interface ReplayTimeline {
	readonly start: number;
	readonly end: number;
	readonly times: readonly number[];
}

export function timelineOf(h: ReplayHistory): ReplayTimeline {
	const times = h.events.map((e) => e.at);
	const first = times[0];
	const last = times[times.length - 1];
	const startedAt = h.info?.startedAt ?? 0;
	// A partial history (or one with a folded base) starts where its events start.
	const fromStart = !h.partial && h.floor === null && startedAt > 0;
	const start = fromStart ? Math.min(startedAt, first ?? startedAt) : (first ?? h.floor?.at ?? startedAt);
	const end = Math.max(last ?? start, h.info?.endedAt ?? 0, start);
	return { start, end, times };
}

function clamp(t: ReplayTimeline, at: number): number {
	return Math.min(t.end, Math.max(t.start, at));
}

/** The index of the first time after `at`. */
function firstAfter(times: readonly number[], at: number): number {
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const x = times[mid];
		if (x !== undefined && x <= at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Where playing from `at` is after `wallMs` of real time at `speed`: the
 * events' own clock times `speed`, a silence longer than SILENCE_MS between
 * two events taking SILENCE_PLAYED_MS. Stops at the end.
 */
export function advance(t: ReplayTimeline, at: number, wallMs: number, speed: ReplaySpeed): number {
	let pos = clamp(t, at);
	let budget = Math.max(0, wallMs) * speed;
	while (budget > 0 && pos < t.end) {
		const i = firstAfter(t.times, pos);
		const next = t.times[i] ?? t.end;
		const previous = t.times[i - 1] ?? t.start;
		const gap = next - previous;
		// Inside a long silence each played millisecond covers gap / SILENCE_PLAYED_MS of the session's clock.
		const rate = gap > SILENCE_MS ? gap / SILENCE_PLAYED_MS : 1;
		const playedToNext = (next - pos) / rate;
		if (budget < playedToNext) return pos + budget * rate;
		budget -= playedToNext;
		pos = next;
	}
	return pos;
}

/** The time of the event before (-1) or after (1) `at`; `at` itself when there is none. */
export function eventStep(t: ReplayTimeline, at: number, direction: -1 | 1): number {
	if (direction === 1) return t.times[firstAfter(t.times, at)] ?? at;
	let lo = 0;
	let hi = t.times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const x = t.times[mid];
		if (x !== undefined && x < at) lo = mid + 1;
		else hi = mid;
	}
	return t.times[lo - 1] ?? at;
}

/** Where the view is: following the session live, or at a replayed moment (playing or not). */
export type ReplayCursor =
	| { readonly mode: "live"; readonly speed: ReplaySpeed }
	| { readonly mode: "replay"; readonly at: number; readonly playing: boolean; readonly speed: ReplaySpeed };

export const LIVE_CURSOR: ReplayCursor = { mode: "live", speed: 1 };

/** The cursor at `at` (scrubbed, a mark clicked, an event's "replay to here"), still playing if it was. */
export function cursorAt(cursor: ReplayCursor, t: ReplayTimeline, at: number): ReplayCursor {
	return { mode: "replay", at: clamp(t, at), playing: cursor.mode === "replay" && cursor.playing, speed: cursor.speed };
}

/** Play from where the cursor is (from the start when it is live or at the end); pause. */
export function togglePlay(cursor: ReplayCursor, t: ReplayTimeline): ReplayCursor {
	if (cursor.mode === "replay" && cursor.playing) return { ...cursor, playing: false };
	const at = cursor.mode === "replay" && cursor.at < t.end ? cursor.at : t.start;
	return { mode: "replay", at, playing: true, speed: cursor.speed };
}

/** The next speed of REPLAY_SPEEDS, round. */
export function nextSpeed(cursor: ReplayCursor): ReplayCursor {
	const i = REPLAY_SPEEDS.indexOf(cursor.speed);
	const speed = REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length] ?? 1;
	return { ...cursor, speed };
}

/** `wallMs` of playing; stops at the end. */
export function played(cursor: ReplayCursor, t: ReplayTimeline, wallMs: number): ReplayCursor {
	if (cursor.mode !== "replay" || !cursor.playing) return cursor;
	const at = advance(t, cursor.at, wallMs, cursor.speed);
	return { ...cursor, at, playing: at < t.end };
}

/** Back to following the session live. */
export function goLive(cursor: ReplayCursor): ReplayCursor {
	return { mode: "live", speed: cursor.speed };
}

/**
 * Where a link with `?at=&event=` opens: the moment named, else the event's
 * own time when the history holds it; null when it names neither.
 */
export function focusedAt(h: ReplayHistory, focus: { readonly at?: number; readonly event?: string }): number | null {
	if (focus.at !== undefined) return focus.at;
	if (focus.event === undefined) return null;
	return h.byId.get(focus.event)?.at ?? null;
}

/** The session's events are no longer kept (only its totals): no replay. */
export function detailsExpired(info: LiveMapSessionInfo | null, now: number): boolean {
	if (info === null) return false;
	const last = info.endedAt > 0 ? info.endedAt : info.startedAt;
	return last > 0 && now - last > DETAIL_RETENTION_MS;
}

/** A stretch of the timeline as the bar draws it: how many events, the station most of them were at, any failure, any finding. */
export interface ReplayMark {
	readonly start: number;
	readonly end: number;
	readonly count: number;
	readonly station: StationCode;
	readonly failed: boolean;
	readonly bottleneck: boolean;
}

/** The station an event shows at on the bar. */
function markStation(e: HeldEvent): StationCode {
	switch (e.kind) {
		case "tool":
		case "lifecycle":
		case "bottleneck":
			return stationOf(e.station);
		case "subagent":
			return "ORCHESTRATOR";
		case "instruction":
			return "MEMORY";
		case "git":
			return "GIT";
		default:
			return "CORE";
	}
}

/** The bar's marks: the timeline cut in `buckets` equal stretches, empty ones left out. */
export function marksOf(h: ReplayHistory, t: ReplayTimeline, buckets: number): ReplayMark[] {
	const n = Math.max(1, Math.floor(buckets));
	const span = Math.max(1, t.end - t.start);
	const tally = Array.from({ length: n }, () => ({ count: 0, failed: false, bottleneck: false, stations: new Map<StationCode, number>() }));
	for (const e of h.events) {
		const slot = tally[Math.min(n - 1, Math.max(0, Math.floor(((e.at - t.start) / span) * n)))];
		if (slot === undefined) continue;
		slot.count += 1;
		if (e.kind === "tool" && e.success === false) slot.failed = true;
		if (e.kind === "bottleneck") slot.bottleneck = true;
		const station = markStation(e);
		slot.stations.set(station, (slot.stations.get(station) ?? 0) + 1);
	}
	const marks: ReplayMark[] = [];
	tally.forEach((slot, i) => {
		if (slot.count === 0) return;
		let station: StationCode = "CORE";
		let most = 0;
		for (const [code, count] of slot.stations) {
			if (count > most) {
				station = code;
				most = count;
			}
		}
		marks.push({ start: t.start + (span * i) / n, end: t.start + (span * (i + 1)) / n, count: slot.count, station, failed: slot.failed, bottleneck: slot.bottleneck });
	});
	return marks;
}

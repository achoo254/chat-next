// The tool calls of a watched session read from the Live Map's ordered log,
// with what the scene, the activity card and the release pipeline all ask of
// them: which are running, when each ended, what kind of release step a call
// is (its `station_flags`), and the session's own history of a kind of call
// (its p95 runtime over the calls that ended before a given one). Pure: the
// caller passes the moment ("now", in the machine's Unix milliseconds, or the
// replayed moment).
import { coreOf, type LiveMapState } from "./live-map-state.ts";
import type { CoreState, LiveMapEvent } from "./live-map-types.ts";
import { stationOf, type StationCode } from "./station-catalog.ts";

/** `station_flags` bits (docs/observatory-wire.md section 3; `ci` from apps/agent/src/observatory/live-map/station-map.ts). */
export const FLAG = { commit: 1, push: 2, deploy: 4, write: 8, memory: 16, estimated: 32, background: 64, ci: 128 } as const;

/** The release steps a shell call can be, in pipeline order. */
export const RELEASE_STEPS = ["commit", "push", "ci", "deploy"] as const;
export type ReleaseStep = (typeof RELEASE_STEPS)[number];

export type ToolEvent = Extract<LiveMapEvent, { kind: "tool" }>;

export interface ToolCall {
	readonly event: ToolEvent;
	readonly station: StationCode;
	/** The release steps its flags name (most calls: none). */
	readonly steps: readonly ReleaseStep[];
	/** What its history is kept by: the station, or `GIT:<step>` for a release step. */
	readonly key: string;
	/** Unset while it runs. */
	readonly endAt: number | undefined;
	readonly ok: boolean | undefined;
}

export function stepsOf(flags: number): ReleaseStep[] {
	return RELEASE_STEPS.filter((s) => (flags & FLAG[s]) !== 0);
}

function callOf(e: ToolEvent): ToolCall {
	const station = stationOf(e.station);
	const steps = stepsOf(e.stationFlags);
	const last = steps[steps.length - 1];
	const ended = e.success !== undefined;
	return {
		event: e,
		station,
		steps,
		key: last === undefined ? station : `GIT:${last}`,
		endAt: ended ? e.at + (e.durationMs ?? 0) : undefined,
		ok: e.success,
	};
}

/** Every tool call in log order (start time). */
export function toolCalls(state: Pick<LiveMapState, "log">): ToolCall[] {
	const out: ToolCall[] = [];
	for (const e of state.log) if (e.kind === "tool") out.push(callOf(e));
	return out;
}

/** The calls running now: those the scene holds as running, oldest first. */
export function runningCalls(state: Pick<LiveMapState, "log" | "scene">): ToolCall[] {
	const ids = new Set<string>();
	for (const st of Object.values(state.scene.stations)) for (const id of st.running) ids.add(id);
	if (ids.size === 0) return [];
	return toolCalls(state).filter((c) => ids.has(c.event.id) && c.endAt === undefined);
}

/** Nearest-rank percentile of `values` (0 < p <= 1); null for none. */
export function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

export interface History {
	readonly p95Ms: number;
	/** Calls it was taken over. */
	readonly count: number;
}

/**
 * The session's history of `key` before `call`: the calls of that key that
 * ended before it ended (before now, while it runs), itself never counted.
 * null before any.
 */
export function historyBefore(calls: readonly ToolCall[], key: string, call: { readonly id: string; readonly endAt: number | undefined }): History | null {
	const durations: number[] = [];
	for (const c of calls) {
		if (c.key !== key || c.endAt === undefined || c.event.id === call.id) continue;
		if (call.endAt !== undefined && c.endAt > call.endAt) continue;
		durations.push(c.event.durationMs ?? c.endAt - c.event.at);
	}
	const p95Ms = percentile(durations, 0.95);
	return p95Ms === null ? null : { p95Ms, count: durations.length };
}

/** What the AI is doing: waiting for the person's permission, running tools, thinking, or nothing. */
export type ActivityMode = "wait" | "exec" | "think" | "idle";

export function coreStateOf(state: LiveMapState): CoreState {
	return state.live?.core ?? coreOf(state);
}

export function modeOf(state: LiveMapState): ActivityMode {
	const core = coreStateOf(state);
	if (core === "waiting_permission") return "wait";
	if (Object.values(state.scene.stations).some((st) => st.running.length > 0)) return "exec";
	if (core === "thinking" || core === "compacting") return "think";
	return "idle";
}

// What the Live Map's activity card shows (activity-card.tsx), worked out from
// the state and a moment (pure, so it is tested without a DOM):
//
// - its subject: a permission request first; else the newest running call;
//   else the call that just ended, held DONE_HOLD_MS after its end; else the
//   model thinking; else idle with the last call;
// - the call's runtime this time and, apart from it, the p95 of the
//   session's earlier calls of the same kind (the same station, or the same
//   release step) that ended before this one: the current call never counts
//   in its own history;
// - the journey of the current turn: the districts it went through in order,
//   consecutive visits folded (×n), a failure marked, the last JOURNEY_MAX;
// - when it must be worked out again (`ticking`): while something runs or a
//   finished call is still held, nothing otherwise, so an idle card needs no
//   timer.
//
// The call's description and output are content: the card asks them by id
// (the same path as the event detail) and reads them with parseToolContent.
import { historyBefore, modeOf, runningCalls, toolCalls, type History, type ReleaseStep, type ToolCall } from "./call-history.ts";
import type { LiveMapState } from "./live-map-state.ts";
import type { LiveMapEvent } from "./live-map-types.ts";
import { STATION_PLACE, type PlaceId } from "./render/scene-table.ts";
import { stationOf, type StationCode } from "./station-catalog.ts";

/** A call that ended stays the card's subject this long after its end (unless another runs). */
export const DONE_HOLD_MS = 1_600;
/** Journey steps kept. */
export const JOURNEY_MAX = 12;

export type CardStatus = "run" | "ok" | "err" | "wait" | "think" | "idle";

export interface CardCall {
	readonly eventId: string;
	readonly station: StationCode;
	readonly place: PlaceId;
	/** The release step it is, if one (a GIT call). */
	readonly step: ReleaseStep | null;
	/** The subagent's type; null for the main agent, "" for a subagent whose type is not known. */
	readonly agent: string | null;
	readonly tool: string;
	/** The MCP server of an MCP tool (its name then names the server); "" otherwise. */
	readonly mcpServer: string;
	/** The filtered target (a file, a command's program, a domain); "" when none. */
	readonly target: string;
	readonly running: boolean;
	readonly ok: boolean | undefined;
	/** This run's time so far (running) or in all. */
	readonly runtimeMs: number;
	/** The session's earlier calls of its kind; null on the first. */
	readonly history: History | null;
	/** It took (or takes) longer than that history's p95. */
	readonly overP95: boolean;
}

export type CardSubject =
	| { readonly kind: "wait"; readonly eventId: string; readonly what: string; readonly station: StationCode; readonly waitingMs: number }
	| { readonly kind: "run" | "done"; readonly call: CardCall }
	| { readonly kind: "think"; readonly apiTurns: number; readonly sinceMs: number }
	| { readonly kind: "idle"; readonly last: CardCall | null };

export interface JourneyStep {
	readonly place: PlaceId;
	readonly count: number;
	readonly failed: boolean;
}

export interface ActivityCard {
	readonly subject: CardSubject;
	readonly status: CardStatus;
	readonly journey: readonly JourneyStep[];
	/** Calls of the subject's kind in the session (the "Lần gọi" figure); null without a call. */
	readonly calls: number | null;
	/** The card changes with time: work it out again in a moment. */
	readonly ticking: boolean;
}

/** The type of the subagent that made a call: null for the main agent, "" when its type is not known (the view names it). */
export const agentTypeOf = (state: LiveMapState, agentId: string): string | null => (agentId === "" ? null : (state.scene.subagents[agentId]?.agentType ?? ""));

function cardCall(state: LiveMapState, calls: readonly ToolCall[], c: ToolCall, now: number): CardCall {
	const running = c.endAt === undefined;
	const runtimeMs = Math.max(0, running ? now - c.event.at : (c.event.durationMs ?? (c.endAt ?? c.event.at) - c.event.at));
	const history = historyBefore(calls, c.key, { id: c.event.id, endAt: c.endAt });
	return {
		eventId: c.event.id,
		station: c.station,
		place: STATION_PLACE[c.station],
		step: c.steps[c.steps.length - 1] ?? null,
		agent: agentTypeOf(state, c.event.agentId),
		tool: c.event.toolName,
		mcpServer: c.event.mcpServer,
		target: c.event.target,
		running,
		ok: c.ok,
		runtimeMs,
		history,
		overP95: history !== null && runtimeMs > history.p95Ms,
	};
}

/** The newest permission request still open, if the core waits for one. */
function openPermission(state: LiveMapState): Extract<LiveMapEvent, { kind: "lifecycle" }> | null {
	for (let i = state.log.length - 1; i >= 0; i--) {
		const e = state.log[i];
		if (e?.kind !== "lifecycle") continue;
		if (e.name === "permission_request") return e;
		if (e.name === "permission_decision" || e.name === "permission_denied" || e.name === "hook_block" || e.name === "stop") return null;
	}
	return null;
}

/** When the model last had something to do: the newest event, a finished call counted at its end. */
function lastActivityAt(state: LiveMapState): number {
	let at = 0;
	for (const e of state.log) {
		const end = e.kind === "tool" && e.success !== undefined ? e.at + (e.durationMs ?? 0) : e.at;
		if (end > at) at = end;
	}
	return at;
}

function subjectOf(state: LiveMapState, calls: readonly ToolCall[], now: number): CardSubject {
	const mode = modeOf(state);
	if (mode === "wait") {
		const request = openPermission(state);
		if (request !== null) return { kind: "wait", eventId: request.id, what: request.label, station: stationOf(request.station), waitingMs: Math.max(0, now - request.at) };
	}
	const running = runningCalls(state);
	const newest = running.reduce<ToolCall | null>((best, c) => (best === null || c.event.at >= best.event.at ? c : best), null);
	if (newest !== null) return { kind: "run", call: cardCall(state, calls, newest, now) };
	const ended = calls.filter((c) => c.endAt !== undefined);
	const last = ended.reduce<ToolCall | null>((best, c) => (best === null || (c.endAt ?? 0) >= (best.endAt ?? 0) ? c : best), null);
	if (last !== null && now - (last.endAt ?? 0) < DONE_HOLD_MS) return { kind: "done", call: cardCall(state, calls, last, now) };
	if (mode === "think") {
		const apiTurns = state.log.filter((e) => e.kind === "api" && e.agentId === "").length;
		return { kind: "think", apiTurns, sinceMs: Math.max(0, now - lastActivityAt(state)) };
	}
	return { kind: "idle", last: last === null ? null : cardCall(state, calls, last, now) };
}

function statusOf(s: CardSubject): CardStatus {
	switch (s.kind) {
		case "wait":
			return "wait";
		case "run":
			return "run";
		case "done":
			return s.call.ok === false ? "err" : "ok";
		case "think":
			return "think";
		case "idle":
			return "idle";
	}
}

/** The districts the current turn (since its prompt) went through. */
export function journeyOf(log: readonly LiveMapEvent[]): JourneyStep[] {
	let start = 0;
	for (let i = log.length - 1; i >= 0; i--) {
		if (log[i]?.kind === "prompt") {
			start = i;
			break;
		}
	}
	const steps: { place: PlaceId; count: number; failed: boolean }[] = [];
	const visit = (place: PlaceId, failed = false): void => {
		const last = steps[steps.length - 1];
		if (last !== undefined && last.place === place) {
			last.count += 1;
			last.failed ||= failed;
		} else steps.push({ place, count: 1, failed });
	};
	for (const e of log.slice(start)) {
		switch (e.kind) {
			case "prompt":
				visit("core");
				break;
			case "api":
				if (e.agentId === "") visit("core");
				break;
			case "tool": {
				const place = STATION_PLACE[stationOf(e.station)];
				// A call is stored once (its end replaces its start): one visit, failed when it failed.
				visit(place, e.success === false);
				break;
			}
			case "lifecycle":
				if (e.name === "permission_request") visit("security");
				break;
			default:
				break;
		}
	}
	return steps.slice(-JOURNEY_MAX);
}

/** The card at `now` (machine ms; the replayed moment while replaying). */
export function activityCardOf(state: LiveMapState, now: number): ActivityCard {
	const calls = toolCalls(state);
	const subject = subjectOf(state, calls, now);
	const call = subject.kind === "run" || subject.kind === "done" ? subject.call : subject.kind === "idle" ? subject.last : null;
	const key = call === null ? null : (calls.find((c) => c.event.id === call.eventId)?.key ?? null);
	return {
		subject,
		status: statusOf(subject),
		journey: journeyOf(state.log),
		calls: key === null ? null : calls.filter((c) => c.key === key).length,
		ticking: subject.kind === "run" || subject.kind === "done" || subject.kind === "wait" || subject.kind === "think",
	};
}

/** A tool call's stored content (`{"input","output","error","reason"}`, docs/observatory-wire.md 6.5) as the card reads it. */
export interface ToolContent {
	/** The tool input's `description` (what Claude said the call is for); "" when none. */
	readonly description: string;
	/** The output's (or the error's) last non-empty line; "" when none. */
	readonly outputLine: string;
	/** The whole output (or error); "" when none. */
	readonly output: string;
}

const lastLine = (text: string): string =>
	text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.at(-1) ?? "";

/** Reads stored tool content; anything unreadable gives empty parts, never an error. */
export function parseToolContent(text: string): ToolContent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { description: "", outputLine: lastLine(text), output: text };
	}
	if (typeof parsed !== "object" || parsed === null) return { description: "", outputLine: "", output: "" };
	const part = (name: string): string => {
		const v: unknown = Reflect.get(parsed, name);
		return typeof v === "string" ? v : "";
	};
	let description = "";
	const input = part("input");
	if (input !== "") {
		try {
			const fields: unknown = JSON.parse(input);
			const d: unknown = typeof fields === "object" && fields !== null ? Reflect.get(fields, "description") : undefined;
			if (typeof d === "string") description = d.trim();
		} catch {
			// The input was cut short by the privacy filter: read the description out of the text.
			description = (/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1] ?? "").replaceAll('\\"', '"');
		}
	}
	const output = part("output") || part("error") || part("reason");
	return { description, outputLine: lastLine(output), output: output.trim() };
}

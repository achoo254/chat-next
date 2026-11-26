// The Live Map's event list beside the scene, as the approved design shows
// it (prototype v6): newest first, at most FEED_MAX rows, each with the time
// (HH:MM:SS), a swatch of its module's colour, one line of what happened and,
// on the right, the call's runtime with ✓, "lỗi · runtime" in red, or
// "chạy…" in amber while it runs; a thinking row reads in violet; a row that
// came in after the list opened flashes once. The header counts every event
// listed. A click on a tool call or a permission request opens its detail; a
// click on any other row selects its module. "Ẩn chi tiết" leaves out
// targets, labels and MCP tool names.
//
// feedRowsOf is pure (tested without a DOM); only the session's own kinds
// are listed (a lifecycle event this app does not name is left out).
import { useState, type CSSProperties } from "react";
import { agentTypeOf } from "./activity-card-model.ts";
import { callLabel, clock, duration, ruleName } from "./drill-format.ts";
import type { LiveMapEvent } from "./live-map-types.ts";
import type { LiveMapState } from "./live-map-state.ts";
import { useObservatoryCopy, type ObservatoryCopy } from "./observatory-copy.ts";
import { PLACE_COLOR } from "./render/interior-painter.ts";
import { STATION_PLACE, type PlaceId } from "./render/scene-table.ts";
import { stationOf } from "./station-catalog.ts";

/** Rows the list keeps (the design's 80). */
export const FEED_MAX = 80;

export type FeedStatus = "run" | "ok" | "err" | "";

export interface FeedRow {
	readonly eventId: string;
	/** Machine ms. */
	readonly at: number;
	/** The module the row is about: its swatch, and what a click selects. */
	readonly place: PlaceId;
	readonly text: string;
	readonly status: FeedStatus;
	/** Shown on the right when known. */
	readonly durationMs: number | null;
	/** A thinking row (an API request of the model). */
	readonly think: boolean;
	/** A click opens the event's detail (a tool call, a permission request) rather than selecting its module. */
	readonly opens: boolean;
}

function toolText(c: ObservatoryCopy, state: LiveMapState, e: Extract<LiveMapEvent, { kind: "tool" }>, hide: boolean): string {
	const agent = agentTypeOf(state, e.agentId);
	const who = agent === null ? "" : `${agent === "" ? c.card.subagentUnknown : agent} › `;
	return `${who}${callLabel(e.toolName, e.mcpServer, e.target, hide, c.detail.kinds.tool)}`;
}

function lifecycleRow(c: ObservatoryCopy, e: Extract<LiveMapEvent, { kind: "lifecycle" }>, hide: boolean): Pick<FeedRow, "place" | "text" | "status" | "durationMs" | "opens"> | null {
	const label = hide ? "" : e.label;
	const plain = { status: "" as const, durationMs: null, opens: false };
	switch (e.name) {
		case "permission_request":
			return { ...plain, place: "security", text: c.feed.permAsk(label), opens: true };
		case "permission_decision":
			return { ...plain, place: "security", text: c.feed.permOk(label) };
		case "permission_denied":
		case "hook_block":
			return { ...plain, place: "security", text: c.feed.permDenied(label), status: "err" };
		case "compact_start":
			return { ...plain, place: "monitoring", text: c.feed.compactStart };
		case "compact_end":
			return { ...plain, place: "monitoring", text: c.feed.compactEnd };
		case "stop":
			return { ...plain, place: "core", text: c.feed.stop };
		case "stop_failure":
			return { ...plain, place: "core", text: c.feed.stopFailure, status: "err" };
		case "api_error":
			return { ...plain, place: "core", text: c.feed.apiError(e.number === undefined ? "" : String(e.number)), status: "err" };
		case "ci_started":
			return { ...plain, place: "git", text: c.feed.ciStart(label) };
		case "ci_finished":
			return { ...plain, place: "git", text: c.feed.ciEnd(label, e.flag), status: e.flag === undefined ? "" : e.flag ? "ok" : "err", durationMs: e.number ?? null };
		default:
			return null;
	}
}

/** The list's rows for a state, newest first, and how many events it lists in all. */
export function feedRowsOf(c: ObservatoryCopy, state: LiveMapState, hide: boolean): { rows: FeedRow[]; total: number } {
	const all: FeedRow[] = [];
	let apiTurn = 0;
	for (const e of state.log) {
		const base = { eventId: e.id, at: e.at, think: false };
		switch (e.kind) {
			case "prompt":
				all.push({ ...base, place: "user-desk", text: c.feed.prompt, status: "", durationMs: null, opens: false });
				break;
			case "api": {
				// The model's own requests; a subagent's thinking shows on its calls.
				if (e.agentId !== "") break;
				apiTurn += 1;
				const tokens = e.contextTokens === undefined ? "" : new Intl.NumberFormat(c.locale).format(e.contextTokens);
				all.push({ ...base, place: "core", text: c.feed.api(apiTurn, tokens), status: "", durationMs: null, think: true, opens: false });
				break;
			}
			case "tool": {
				const ended = e.success !== undefined;
				all.push({
					...base,
					place: STATION_PLACE[stationOf(e.station)],
					text: toolText(c, state, e, hide),
					status: !ended ? "run" : e.success ? "ok" : "err",
					durationMs: ended ? (e.durationMs ?? 0) : null,
					opens: true,
				});
				break;
			}
			case "subagent": {
				const type = e.agentType === "" ? c.card.subagentUnknown : e.agentType;
				const ended = e.endedAt > 0;
				all.push({ ...base, place: "orchestrator", text: ended ? c.feed.subEnd(type) : c.feed.subStart(type), status: ended ? "ok" : "", durationMs: ended ? Math.max(0, e.endedAt - e.at) : null, opens: false });
				break;
			}
			case "instruction":
				all.push({ ...base, place: "memory", text: c.feed.instruction(hide || e.memoryType === "" ? c.detail.kinds.instruction : e.memoryType), status: "", durationMs: null, opens: false });
				break;
			case "git":
				all.push({ ...base, place: "git", text: c.feed.git(e.gitKind), status: "", durationMs: null, opens: false });
				break;
			case "lifecycle": {
				const row = lifecycleRow(c, e, hide);
				if (row !== null) all.push({ ...base, ...row });
				break;
			}
			case "bottleneck": {
				const rule = ruleName(c, e);
				all.push({ ...base, place: STATION_PLACE[stationOf(e.station)], text: e.open ? c.feed.bottleneck(rule) : c.feed.bottleneckClosed(rule), status: "", durationMs: null, opens: false });
				break;
			}
			default:
				break;
		}
	}
	return { rows: all.slice(-FEED_MAX).reverse(), total: all.length };
}

/** The swatch's colour: the station's; the input port, the lock and the reservoir take the model's (as in the design). */
function swatchOf(place: PlaceId): string {
	return place === "user-desk" || place === "security" || place === "monitoring" ? PLACE_COLOR.core : PLACE_COLOR[place];
}

export interface EventFeedProps {
	/** feedRowsOf of the state, worked out once by the stage (its camera note counts the same events). */
	readonly feed: { readonly rows: readonly FeedRow[]; readonly total: number };
	readonly onEvent: (eventId: string) => void;
	readonly onPlace: (place: PlaceId) => void;
}

export function EventFeed({ feed, onEvent, onPlace }: EventFeedProps) {
	const c = useObservatoryCopy();
	const { rows, total } = feed;
	// The rows already there when the list opened do not flash; every one after does, once (on mount).
	const [first] = useState(() => new Set(rows.map((r) => r.eventId)));
	return (
		<div className="lm-box" data-id="observe-feed">
			<h2>
				<span>{c.feed.title}</span>
				<span data-id="observe-feed-count">{total}</span>
			</h2>
			<ul className="lm-feed">
				{rows.map((r) => {
					const status = r.status;
					const right = r.durationMs !== null ? (status === "err" ? c.feed.failed(duration(c, r.durationMs)) : duration(c, r.durationMs)) : status === "run" ? c.feed.running : "";
					return (
						<li key={r.eventId} className={`${first.has(r.eventId) ? "" : "is-fresh"}${r.think ? " is-think" : ""}`} style={{ "--station": swatchOf(r.place) } as CSSProperties} data-id={`observe-feed-${r.eventId}`}>
							<button type="button" onClick={() => (r.opens ? onEvent(r.eventId) : onPlace(r.place === "orchestrator" ? "core" : r.place))}>
								<span className="t">{clock(c, r.at)}</span>
								<span className="sw" aria-hidden="true" />
								<span className="x">{r.text}</span>
								<span className={`d ${status}`}>{right}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

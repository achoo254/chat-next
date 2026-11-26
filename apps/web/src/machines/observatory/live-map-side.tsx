// The column beside the Live Map's scene, as the approved design lays it out
// (prototype v6), above the event list (event-feed.tsx):
//
// - "Phiên": the session's model and four gauges (context fill, output
//   speed, tool calls, running subagents), with "Ẩn chi tiết";
// - "Chi tiết": what the viewer picked, worked out from the session's own
//   events (no request to the machine but a call's content):
//   - an event: a tool call's status, runtime this time, the module's p95
//     history apart from it, the module's calls, its target, who made it,
//     Claude's description and its output (content, asked by id only when
//     the project stores content and "Ẩn chi tiết" is off); another event:
//     its kind, time and label;
//   - a module: the model's activity, API turns, speed and subagents; the
//     reservoir's fill; the lock's waiting request; or a module's running
//     call, open bottleneck, Git · CI/CD steps, p50 / p95 history, failures
//     and its recent calls with each runtime.
import type { ReactNode } from "react";
import { agentTypeOf } from "./activity-card-model.ts";
import { coreStateOf, historyBefore, modeOf, percentile, runningCalls, toolCalls, RELEASE_STEPS, type ToolCall } from "./call-history.ts";
import { districtBoardOf } from "./district-board-model.ts";
import { callLabel, clock, duration, eventLabel, ruleName, toolName } from "./drill-format.ts";
import type { LiveMapState } from "./live-map-state.ts";
import type { LiveMapEvent } from "./live-map-types.ts";
import { useObservatoryCopy, type ObservatoryCopy } from "./observatory-copy.ts";
import { pipelineOf } from "./pipeline-model.ts";
import { STATION_PLACE, type PlaceId } from "./render/scene-table.ts";
import { stationOf, STATION_CODES } from "./station-catalog.ts";
import { useToolContent, type ContentSource, type ToolContentAnswer } from "./use-tool-content.ts";

/** What the detail shows: an event, a module, or nothing yet. */
export type SidePick = { readonly kind: "event"; readonly eventId: string } | { readonly kind: "place"; readonly place: PlaceId } | null;

/** Recent calls a module's detail lists. */
const RECENT = 6;

function Row({ k, v, tone = "", id }: { k: string; v: string | number; tone?: "ok" | "err" | ""; id?: string }) {
	return (
		<div className="lm-row" data-id={id}>
			<span>{k}</span>
			<b className={tone}>{v}</b>
		</div>
	);
}

export interface SessionBoxProps {
	readonly state: LiveMapState;
	readonly hide: boolean;
	readonly hideLabel: string;
	readonly hideHint: string;
	/** Why a context percent reads as approximate (its window was assumed). */
	readonly approxHint: string;
	readonly onHide: () => void;
}

export function SessionBox({ state, hide, hideLabel, hideHint, approxHint, onHide }: SessionBoxProps) {
	const c = useObservatoryCopy();
	const model = state.live?.mainModel || state.scene.model;
	const percent = state.live?.contextPercent ?? null;
	const assumed = state.live?.contextWindowAssumed === true;
	const tps = modeOf(state) === "think" ? (state.live?.tokensPerSecond ?? state.scene.tokensPerSecond ?? 0) : 0;
	const subagents = Object.values(state.scene.subagents).filter((s) => s.running).length;
	return (
		<div className="lm-box" data-id="observe-session">
			<h2>
				<span>{c.side.session}</span>
				<span>{model}</span>
			</h2>
			<div className="lm-gauges" data-id="observe-meta">
				<span data-id="observe-context" title={assumed ? approxHint : undefined}>
					{c.side.context} <b>{percent === null ? "–" : `${assumed ? "~" : ""}${Math.round(percent)}%`}</b>
				</span>
				<span>
					{c.side.speed} <b>{Math.round(tps)}</b> {c.side.tokPerSec}
				</span>
				<span>
					{c.side.tools} <b>{toolCalls(state).length}</b>
				</span>
				<span>
					{c.side.subagents} <b>{subagents}</b>
				</span>
			</div>
			<label className="lm-toggle" title={hideHint}>
				<input type="checkbox" checked={hide} onChange={onHide} data-id="observe-hide-details" />
				{hideLabel}
			</label>
		</div>
	);
}

function callRow(c: ObservatoryCopy, state: LiveMapState, call: ToolCall, hide: boolean): string {
	const agent = agentTypeOf(state, call.event.agentId);
	const who = agent === null ? "" : `${agent === "" ? c.card.subagentUnknown : agent} › `;
	return `${who}${callLabel(call.event.toolName, call.event.mcpServer, call.event.target, hide, c.detail.kinds.tool)}`;
}

function ToolDetail({ state, e, now, hide, source }: { state: LiveMapState; e: Extract<LiveMapEvent, { kind: "tool" }>; now: number; hide: boolean; source: ContentSource | null }) {
	const c = useObservatoryCopy();
	const calls = toolCalls(state);
	const call = calls.find((x) => x.event.id === e.id);
	const running = e.success === undefined;
	const answer = useToolContent(source, e.id, !running, hide);
	if (call === undefined) return null;
	const history = historyBefore(calls, call.key, { id: e.id, endAt: call.endAt });
	const runtime = Math.max(0, running ? now - e.at : (e.durationMs ?? 0));
	const status = running ? c.side.running : e.success ? c.side.ok : c.side.failed;
	const agent = agentTypeOf(state, e.agentId);
	const output = running || answer.kind === "pending" ? c.side.outputRunning : answer.kind === "ok" ? answer.content.output || c.card.outputEmpty : outputReason(c, answer.kind);
	return (
		<>
			<Row k={c.side.status} v={status} tone={running ? "" : e.success ? "ok" : "err"} id="observe-detail-status" />
			<Row k={c.side.runtimeNow} v={duration(c, runtime)} />
			<Row k={c.side.p95Place} v={history === null ? c.side.none : duration(c, history.p95Ms)} />
			<Row k={c.side.callsPlace} v={calls.filter((x) => x.key === call.key).length} />
			{!hide && e.target !== "" && <Row k={c.side.target} v={e.target} />}
			<Row k={c.side.agent} v={agent === null ? c.side.mainAgent : c.card.subagent(agent === "" ? c.card.subagentUnknown : agent)} />
			{answer.kind === "ok" && answer.content.description !== "" && <Row k={c.side.description} v={answer.content.description} />}
			<div>{c.side.output}</div>
			<pre data-id="observe-detail-output">{output}</pre>
			<div>{c.side.contentNote}</div>
		</>
	);
}

function outputReason(c: ObservatoryCopy, kind: ToolContentAnswer["kind"]): string {
	switch (kind) {
		case "hidden":
			return c.card.outputHidden;
		case "off":
			return c.card.outputOff;
		case "not_yet":
			return c.card.outputNotYet;
		case "loading":
			return c.card.outputLoading;
		case "failed":
			return c.card.outputFailed;
		case "unavailable":
			return c.card.outputUnavailable;
		default:
			return c.card.outputNone;
	}
}

/** The title of an event's detail and its count line. */
function eventTitle(c: ObservatoryCopy, e: LiveMapEvent, names: Readonly<Record<PlaceId, string>>, hide: boolean): { title: string; count: string } {
	if (e.kind === "tool") {
		const status = e.success === undefined ? c.side.running : e.success ? c.side.ok : c.side.failed;
		return { title: `${toolName(c, e.toolName, e.mcpServer, hide)} · ${names[STATION_PLACE[stationOf(e.station)]]}`, count: status };
	}
	const kind = e.kind === "session" || e.kind === "unknown" ? "" : c.detail.kinds[e.kind];
	return { title: kind, count: "" };
}

function PlaceDetail({ state, place, now, hide }: { state: LiveMapState; place: PlaceId; now: number; hide: boolean }) {
	const c = useObservatoryCopy();
	switch (place) {
		case "monitoring": {
			const live = state.live;
			return (
				<>
					<Row k={c.side.used} v={live === null ? "–" : c.scene.contextLine(live.contextPercent === null ? null : Math.round(live.contextPercent), live.contextTokens, live.contextWindow)} />
					<Row k={c.side.ratio} v={live?.contextPercent == null ? "–" : `${Math.round(live.contextPercent)}%`} />
				</>
			);
		}
		case "core":
		case "orchestrator": {
			const board = districtBoardOf(state, "core", now);
			const subs = Object.values(state.scene.subagents)
				.filter((s) => s.running)
				.map((s) => (s.agentType === "" ? c.card.subagentUnknown : s.agentType));
			return (
				<>
					<Row k={c.side.doing} v={c.side.modes[modeOf(state)]} />
					<Row k={c.side.apiTurns} v={board.kind === "model" ? board.apiTurns : 0} />
					<Row k={c.side.speedRow} v={`${Math.round(board.kind === "model" ? (board.tokensPerSecond ?? 0) : 0)} tok/s`} />
					<Row k={c.side.subagentRow} v={subs.join(", ") || c.side.none} />
				</>
			);
		}
		case "security": {
			const board = districtBoardOf(state, "security", now);
			const waiting = coreStateOf(state) === "waiting_permission";
			return <Row k={c.side.waitingFor} v={waiting && board.kind === "permission" ? (hide || board.what === "" ? c.card.status.wait : board.what) : c.side.none} />;
		}
		case "user-desk":
			return <Row k={c.side.prompts} v={state.log.filter((e) => e.kind === "prompt").length} />;
		default:
			break;
	}
	const station = STATION_CODES.find((code) => STATION_PLACE[code] === place);
	const calls = toolCalls(state).filter((x) => x.station === station);
	const ended = calls.filter((x) => x.endAt !== undefined).sort((a, b) => (b.endAt ?? 0) - (a.endAt ?? 0));
	const durations = ended.map((x) => x.event.durationMs ?? 0);
	const failures = ended.filter((x) => x.ok === false).length;
	const run = runningCalls(state).filter((x) => x.station === station);
	const open = state.log.filter((e): e is Extract<LiveMapEvent, { kind: "bottleneck" }> => e.kind === "bottleneck" && e.open && stationOf(e.station) === station);
	const all = toolCalls(state);
	const pipe = place === "git" ? pipelineOf(state.log, now) : null;
	return (
		<>
			{run[0] !== undefined && <div className="lm-live">▶ {`${callRow(c, state, run[0], hide)} · ${c.scene.runtime(duration(c, Math.max(0, now - run[0].event.at)))}`}</div>}
			{open.map((b) => (
				<div key={b.id} className="lm-live">
					⚠ {ruleName(c, b)}
				</div>
			))}
			{pipe !== null &&
				RELEASE_STEPS.map((step) => {
					const of = all.filter((x) => x.key === `GIT:${step}` && x.endAt !== undefined).map((x) => x.event.durationMs ?? 0);
					const p95 = percentile(of, 0.95);
					return <Row key={step} k={c.side.stepRow(c.scene.steps[step], of.length, p95 === null ? "–" : duration(c, p95))} v={c.side.stepState[pipe.steps[step].status]} />;
				})}
			{ended.length === 0 ? (
				<div>{c.side.noCallsYet}</div>
			) : (
				<>
					<Row k={c.side.p50p95} v={`${duration(c, percentile(durations, 0.5) ?? 0)} / ${duration(c, percentile(durations, 0.95) ?? 0)}`} />
					<Row k={c.side.errors} v={`${failures} / ${ended.length}`} />
					<div>{c.side.recent}</div>
					{ended.slice(0, RECENT).map((x) => (
						<Row key={x.event.id} k={callRow(c, state, x, hide)} v={duration(c, x.event.durationMs ?? 0)} tone={x.ok === false ? "err" : ""} />
					))}
				</>
			)}
		</>
	);
}

export interface DetailBoxProps {
	readonly state: LiveMapState;
	readonly pick: SidePick;
	/** Machine ms. */
	readonly now: number;
	readonly hide: boolean;
	readonly source: ContentSource | null;
	readonly names: Readonly<Record<PlaceId, string>>;
}

export function DetailBox({ state, pick, now, hide, source, names }: DetailBoxProps) {
	const c = useObservatoryCopy();
	let title = c.side.detail;
	let count = "";
	let body: ReactNode = <>{c.side.detailHint}</>;
	if (pick?.kind === "event") {
		const e = state.log.find((x) => x.id === pick.eventId);
		if (e !== undefined) {
			({ title, count } = eventTitle(c, e, names, hide));
			body =
				e.kind === "tool" ? (
					<ToolDetail key={e.id} state={state} e={e} now={now} hide={hide} source={source} />
				) : (
					<>
						<Row k={c.side.kind} v={title} />
						<Row k={c.side.time} v={clock(c, e.at)} />
						<Row k={c.side.label} v={eventLabel(c, e, hide)} />
					</>
				);
		}
	} else if (pick?.kind === "place") {
		title = names[pick.place];
		const station = STATION_CODES.find((code) => STATION_PLACE[code] === pick.place);
		const n = station === undefined ? 0 : toolCalls(state).filter((x) => x.station === station && x.endAt !== undefined).length;
		count = n > 0 ? c.scene.calls(n) : "";
		body = <PlaceDetail state={state} place={pick.place} now={now} hide={hide} />;
	}
	return (
		<div className="lm-box" data-id="observe-detail-box">
			<h2>
				<span data-id="observe-detail-title">{title}</span>
				<span>{count}</span>
			</h2>
			<div className="lm-detail" data-id="observe-detail-body">
				{body}
			</div>
		</div>
	);
}

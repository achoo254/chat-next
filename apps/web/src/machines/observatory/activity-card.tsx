// The Live Map's activity card: the main read over the scene, laid out as the
// approved design (prototype v6). Its first line names what Claude does now
// (waiting for permission, a call running or just finished with its module,
// release step and subagent, thinking, idle) with the status pill and the
// runtime of this run; under it the call in large type, Claude's description
// of it, an indeterminate bar while it runs (Claude Code reports no
// percentage; amber once past the p95 history), the last line of its output
// once it ended, then the p95 of the session's earlier calls of the same
// kind apart from the runtime (never mixed: each figure has its own label),
// "Xem chi tiết" and the turn's journey through the modules. Description and
// output are content: asked by id only when the project stores content and
// "Ẩn chi tiết" is off; otherwise a short reason. "Ẩn chi tiết" hides
// targets, content and MCP tool names (drill-format.ts toolName). Screen
// readers hear a short status only when the subject or its status changes,
// not every runtime tick.
import type { CSSProperties } from "react";
import type { ActivityCard as Card, CardCall, JourneyStep } from "./activity-card-model.ts";
import { callLabel, duration } from "./drill-format.ts";
import { useObservatoryCopy, type ObservatoryCopy } from "./observatory-copy.ts";
import { PLACE_COLOR } from "./render/interior-painter.ts";
import type { PlaceId } from "./render/scene-table.ts";
import { useToolContent, type ContentSource, type ToolContentAnswer } from "./use-tool-content.ts";

export interface ActivityCardProps {
	readonly card: Card;
	readonly names: Readonly<Record<PlaceId, string>>;
	/** "Ẩn chi tiết": targets and content hidden. */
	readonly hide: boolean;
	/** Where content can be asked; null: nowhere (the card says so). */
	readonly source: ContentSource | null;
	/** The main agent's output rate and the context's fill, for the thinking line; null when unknown. */
	readonly tokensPerSecond: number | null;
	readonly contextPercent: number | null;
	readonly onDetail: (eventId: string) => void;
}

function callWhat(c: ObservatoryCopy, call: CardCall, hide: boolean): string {
	return callLabel(call.tool, call.mcpServer, call.target, hide, c.detail.kinds.tool);
}

/** Who made the call: "" for the main agent. */
function agentText(c: ObservatoryCopy, agent: string | null): string {
	if (agent === null) return "";
	return agent === "" ? c.card.subagentUnknown : c.card.subagent(agent);
}

function kindLine(c: ObservatoryCopy, card: Card, names: Readonly<Record<PlaceId, string>>): string {
	const s = card.subject;
	switch (s.kind) {
		case "wait":
			return c.card.waitKind;
		case "think":
			return c.card.thinkKind(Math.max(1, s.apiTurns));
		case "idle":
			return c.card.idleKind;
		case "run":
		case "done": {
			const head = s.kind === "run" ? c.card.running : s.call.ok === false ? c.card.failed : c.card.done;
			return [head, names[s.call.place], s.call.step === null ? "" : c.card.steps[s.call.step], agentText(c, s.call.agent)].filter((x) => x !== "").join(" · ");
		}
	}
}

function outputText(c: ObservatoryCopy, answer: ToolContentAnswer): string {
	switch (answer.kind) {
		case "ok":
			return answer.content.outputLine === "" ? c.card.outputEmpty : answer.content.outputLine;
		case "pending":
			return c.card.outputPending;
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
		case "none":
			return c.card.outputNone;
	}
}

function Journey({ steps, names, c }: { steps: readonly JourneyStep[]; names: Readonly<Record<PlaceId, string>>; c: ObservatoryCopy }) {
	// The steps wrap onto further lines (never cut with "…"); the box keeps its height and shows the newest steps at its bottom.
	return (
		<div className="lm-journey" data-id="observe-card-journey">
			<div className="lm-journey-in">
				{steps.length > 0 && <span className="lm-journey-label">{c.card.journey}:</span>}
				{steps.map((step, i) => (
					// Steps are positional (the same module can come back later): the index is part of their identity.
					<span key={`${i}-${step.place}`} className="lm-journey-step">
						{i > 0 && <span className="lm-journey-arrow">→</span>}
						<span className={step.failed ? "is-failed" : "is-step"} data-place={step.place}>
							{names[step.place]}
							{step.count > 1 ? ` ×${step.count}` : ""}
							{step.failed ? " ✗" : ""}
						</span>
					</span>
				))}
			</div>
		</div>
	);
}

/** The card's edge and kind colour: the module's for a call, amber while waiting, violet while thinking. */
function colourOf(card: Card, call: CardCall | null): string {
	switch (card.status) {
		case "wait":
			return "var(--lm-warn)";
		case "think":
			return "var(--lm-think)";
		case "idle":
			return "var(--lm-muted)";
		default:
			return call === null ? "var(--lm-muted)" : PLACE_COLOR[call.place];
	}
}

export function ActivityCard({ card, names, hide, source, tokensPerSecond, contextPercent, onDetail }: ActivityCardProps) {
	const c = useObservatoryCopy();
	const s = card.subject;
	const call = s.kind === "run" || s.kind === "done" ? s.call : null;
	const answer = useToolContent(source, call?.eventId ?? null, call !== null && !call.running, hide);
	const detailId = s.kind === "wait" ? s.eventId : (call?.eventId ?? (s.kind === "idle" ? (s.last?.eventId ?? null) : null));
	let what: string;
	let desc = "";
	let runtime = "";
	switch (s.kind) {
		case "wait":
			what = hide || s.what === "" ? c.card.waitWhat("") : s.what;
			desc = c.card.waitDesc;
			runtime = `${c.card.waited} ${duration(c, s.waitingMs)}`;
			break;
		case "think":
			what = c.card.thinking;
			desc = [tokensPerSecond === null ? "" : `${Math.round(tokensPerSecond)} tok/s`, contextPercent === null ? "" : `${c.side.context} ${Math.round(contextPercent)}%`].filter((x) => x !== "").join(" · ");
			runtime = `${c.card.runtime} ${duration(c, s.sinceMs)}`;
			break;
		case "idle":
			what = c.card.idleWhat;
			if (s.last !== null) desc = c.card.lastJob(callWhat(c, s.last, hide), s.last.ok !== false, duration(c, s.last.runtimeMs));
			break;
		default:
			what = callWhat(c, s.call, hide);
			desc = answer.kind === "ok" ? answer.content.description : "";
			runtime = `${c.card.runtime} ${duration(c, s.call.runtimeMs)}`;
	}
	const showBar = s.kind === "run" || s.kind === "think";
	const kind = kindLine(c, card, names);
	// What screen readers hear: the subject and its status, never the ticking runtime.
	const spoken = [kind, what].join(" · ");
	const history = call === null ? null : call.history === null ? c.card.noHistory : `${c.card.p95} ${duration(c, call.history.p95Ms)} ${c.card.historyCount(call.history.count)}`;
	return (
		<section className="lm-card" aria-label={c.card.label} data-id="observe-card" data-status={card.status} data-station={call?.station} style={{ "--fc": colourOf(card, call) } as CSSProperties}>
			<span className="sr-only" role="status" data-id="observe-card-live">
				{spoken}
			</span>
			<div className="lm-card-k">
				<span className="lm-card-kind" data-id="observe-card-kind">
					{kind}
				</span>
				<span className="lm-card-right">
					<span className="lm-pill" data-s={card.status} data-id="observe-card-status">
						{c.card.status[card.status]}
					</span>
					<span data-id="observe-card-runtime">{runtime}</span>
				</span>
			</div>
			<div className="lm-card-what" data-id="observe-card-what">
				{what}
			</div>
			{/* Every row is always there (empty when it has nothing to say), so the card keeps its height as the work changes. */}
			<div className="lm-card-desc" data-id={desc === "" ? undefined : "observe-card-desc"}>
				{desc}
			</div>
			{showBar ? (
				<div className={`lm-bar${call?.overP95 === true ? " is-over" : ""}`} role="progressbar" aria-label={c.card.status[card.status]} data-id="observe-card-bar">
					<i />
				</div>
			) : (
				<div className="lm-bar is-off" aria-hidden="true" />
			)}
			<div className="lm-card-out" data-id={call === null ? undefined : "observe-card-output"}>
				{call !== null && (
					<>
						{c.card.output}: <b>{outputText(c, answer)}</b>
					</>
				)}
			</div>
			<div className="lm-card-foot">
				<span className="lm-card-hist" data-id="observe-card-history">
					{history}
					{call?.overP95 === true && <span className="lm-warnx"> · {c.card.overP95}</span>}
				</span>
				<button type="button" className="lm-btn" data-id="observe-card-more" disabled={detailId === null} onClick={() => detailId !== null && onDetail(detailId)}>
					{c.card.more}
				</button>
			</div>
			<Journey steps={card.journey} names={names} c={c} />
		</section>
	);
}

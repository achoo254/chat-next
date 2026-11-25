// The Live Map's activity card: the main read over the scene. It names what
// Claude does now (waiting for permission, a call running or just finished,
// thinking, idle with its last job), the call's runtime this time, the p95 of
// the session's earlier calls of the same kind apart from it (never mixed:
// each figure has its own label), the calls of that kind, Claude's
// description of the call and the last line of its output once it ended
// (content, asked by id only when the project stores content and "Ẩn chi
// tiết" is off; otherwise a short reason), an indeterminate bar while it runs
// (Claude Code reports no percentage), the turn's journey through the
// districts, and "Xem chi tiết" for the event's detail. "Ẩn chi tiết" hides
// targets, content and MCP tool names (drill-format.ts toolName). Screen
// readers hear a short status only when the subject or its status changes,
// not every runtime tick.
import { MachineIcon } from "../machine-icons.tsx";
import type { ActivityCard as Card, CardCall, JourneyStep } from "./activity-card-model.ts";
import { duration, toolName } from "./drill-format.ts";
import { useObservatoryCopy, type ObservatoryCopy } from "./observatory-copy.ts";
import { placeIcon } from "./place-names.ts";
import type { PlaceId } from "./render/scene-table.ts";
import { useToolContent, type ContentSource, type ToolContentAnswer } from "./use-tool-content.ts";

export interface ActivityCardProps {
	readonly card: Card;
	readonly names: Readonly<Record<PlaceId, string>>;
	/** "Ẩn chi tiết": targets and content hidden. */
	readonly hide: boolean;
	/** Where content can be asked; null: nowhere (the card says so). */
	readonly source: ContentSource | null;
	readonly onDetail: (eventId: string) => void;
}

function callWhat(c: ObservatoryCopy, call: CardCall, hide: boolean): string {
	const tool = toolName(c, call.tool, call.mcpServer, hide);
	return hide || call.target === "" ? tool : `${tool} ${call.target}`;
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
	return (
		<div className="lm-card-journey" data-id="observe-card-journey">
			<span className="lm-card-label">{c.card.journey}</span>
			{steps.length === 0 ? (
				<span className="lm-card-muted">{c.card.journeyNone}</span>
			) : (
				<ol>
					{steps.map((step, i) => (
						// Steps are positional (the same district can come back later): the index is part of their identity.
						<li key={`${i}-${step.place}`} className={step.failed ? "is-failed" : undefined} data-place={step.place}>
							<MachineIcon name={placeIcon(step.place)} small />
							<span>
								{names[step.place]}
								{step.count > 1 ? ` ×${step.count}` : ""}
								{step.failed ? " ✗" : ""}
							</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

export function ActivityCard({ card, names, hide, source, onDetail }: ActivityCardProps) {
	const c = useObservatoryCopy();
	const s = card.subject;
	const call = s.kind === "run" || s.kind === "done" ? s.call : null;
	const answer = useToolContent(source, call?.eventId ?? null, call !== null && !call.running, hide);
	const detailId = s.kind === "wait" ? s.eventId : call?.eventId ?? (s.kind === "idle" ? (s.last?.eventId ?? null) : null);
	let what: string;
	let desc = "";
	let runtime: string | null = null;
	switch (s.kind) {
		case "wait":
			what = c.card.waitWhat(hide ? "" : s.what);
			desc = c.card.waitDesc;
			runtime = `${c.card.waited} ${duration(c, s.waitingMs)}`;
			break;
		case "think":
			what = c.card.thinking;
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
	return (
		<section className="lm-card" aria-label={c.card.label} data-id="observe-card" data-status={card.status} data-station={call?.station}>
			<span className="sr-only" role="status" data-id="observe-card-live">
				{spoken}
			</span>
			<div className="lm-card-main">
				<div className="lm-card-kind">
					<span className="lm-card-dot" aria-hidden="true" />
					<span data-id="observe-card-kind">{kind}</span>
					<span className="lm-card-pill" data-s={card.status} data-id="observe-card-status">
						{c.card.status[card.status]}
					</span>
				</div>
				<div className="lm-card-what" data-id="observe-card-what">
					{what}
				</div>
				{desc !== "" && (
					<div className="lm-card-desc" data-id="observe-card-desc">
						{desc}
					</div>
				)}
				{showBar && (
					<div className={`lm-card-bar${call?.overP95 === true ? " is-over" : ""}`} role="progressbar" aria-label={c.card.status[card.status]} data-id="observe-card-bar">
						<i />
					</div>
				)}
				{call !== null && (
					<div className="lm-card-output" data-id="observe-card-output">
						{c.card.output}: <b>{outputText(c, answer)}</b>
					</div>
				)}
			</div>
			<dl className="lm-card-figures">
				<dt>{c.card.runtime}</dt>
				<dd data-id="observe-card-runtime">{runtime ?? "–"}</dd>
				<dt>{c.card.p95}</dt>
				<dd data-id="observe-card-history">
					{call === null ? "–" : call.history === null ? c.card.noHistory : `${duration(c, call.history.p95Ms)} ${c.card.historyCount(call.history.count)}`}
					{call?.overP95 === true && <em className="lm-card-over"> · {c.card.overP95}</em>}
				</dd>
				<dt>{c.card.calls}</dt>
				<dd data-id="observe-card-calls">{card.calls ?? "–"}</dd>
			</dl>
			<div className="lm-card-side">
				<Journey steps={card.journey} names={names} c={c} />
				{detailId !== null && (
					<button type="button" className="btn btn-sm" data-id="observe-card-more" onClick={() => onDetail(detailId)}>
						{c.card.more}
					</button>
				)}
			</div>
		</section>
	);
}

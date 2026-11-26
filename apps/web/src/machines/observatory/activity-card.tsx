// The Live Map's activity card: the main read beside the scene, laid out as
// the approved design (prototype v6) in three columns. Left: what Claude does
// now (waiting for permission, a call running or just finished with its module,
// release step and subagent, thinking, idle) with its status pill, the call in
// large type, Claude's description of it, an indeterminate bar while it runs
// (Claude Code reports no percentage; amber once past the p95 history) and the
// last line of its output once it ended. Middle: the figures, each with its own
// label and never mixed: the runtime of this run, the p95 of the session's
// earlier calls of the same kind (and when this run is longer than it) and how
// many calls of that kind. Right: "Xem chi tiết" at the top corner (always the
// first thing there, hidden when there is no event) and the turn's journey
// through the modules as chips on two rows, the newest last and lit, the oldest
// dropping out behind "…" when they do not fit. Description and output are
// content: asked by id only when the project stores content and "Ẩn chi tiết"
// is off; otherwise a short reason. "Ẩn chi tiết" hides targets, content and
// MCP tool names (drill-format.ts toolName). Screen readers hear a short status
// only when the subject or its status changes, not every runtime tick.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ActivityCard as Card, CardCall, JourneyStep } from "./activity-card-model.ts";
import { callLabel, duration } from "./drill-format.ts";
import { Ico, type IconName } from "./observe-icons.tsx";
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

/** One glyph per module for the journey's chips. */
const STEP_GLYPH: Readonly<Record<PlaceId, string>> = {
	core: "◎",
	orchestrator: "◈",
	files: "▤",
	memory: "▣",
	skills: "ϟ",
	mcp: "⬡",
	external: "◍",
	sandbox: "›_",
	testing: "✓",
	git: "⑂",
	"user-desk": "›",
	security: "⚿",
	monitoring: "▦",
};
/** Steps laid out at most; older ones are never measured. */
const TRAIL_CAP = 40;

/**
 * The journey as chips on at most two rows (the box has the height of two). It
 * lays out the newest steps and drops the oldest one at a time until what is
 * laid out fits; a new step or a new width starts again from all of them.
 */
function Trail({ steps, names, c }: { steps: readonly JourneyStep[]; names: Readonly<Record<PlaceId, string>>; c: ObservatoryCopy }) {
	const box = useRef<HTMLDivElement>(null);
	const all = steps.slice(-TRAIL_CAP);
	const last = all[all.length - 1];
	const signature = `${steps.length}|${last?.count ?? 0}|${last?.failed === true}`;
	const [skip, setSkip] = useState(0);
	const [seen, setSeen] = useState(signature);
	if (seen !== signature) {
		setSeen(signature);
		setSkip(0);
	}
	// Runs again after each step dropped, and when the steps or the words (their widths) change.
	useLayoutEffect(() => {
		const el = box.current;
		if (el !== null && el.scrollHeight > el.clientHeight + 1 && skip < all.length - 1) setSkip(skip + 1);
	}, [skip, all.length, signature, names]);
	useEffect(() => {
		const el = box.current;
		if (el === null || typeof ResizeObserver === "undefined") return;
		let width = el.clientWidth;
		const watch = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			setSkip(0);
		});
		watch.observe(el);
		return () => watch.disconnect();
	}, []);
	const shown = all.slice(skip);
	const cut = skip > 0 || steps.length > all.length;
	return (
		<div className="lm-trail" ref={box} data-id="observe-card-journey">
			{steps.length === 0 && <span className="lm-trail-empty">{c.card.journeyEmpty}</span>}
			{cut && <span className="lm-trail-more">…</span>}
			{shown.map((step, i) => (
				// Steps are positional (the same module can come back later): the index is part of their identity.
				<Fragment key={`${skip + i}-${step.place}`}>
					{(i > 0 || cut) && (
						<span className="lm-trail-arrow" aria-hidden="true">
							→
						</span>
					)}
					<span className={`lm-trail-step${step.failed ? " is-failed" : ""}${i === shown.length - 1 ? " is-cur" : ""}`} data-place={step.place} style={{ "--sc": PLACE_COLOR[step.place] } as CSSProperties}>
						<span className="lm-trail-ic" aria-hidden="true">
							{STEP_GLYPH[step.place]}
						</span>
						<span>
							{names[step.place]}
							{step.count > 1 ? ` ×${step.count}` : ""}
							{step.failed ? " ✗" : ""}
						</span>
					</span>
				</Fragment>
			))}
		</div>
	);
}

function Stat({ icon, label, value, id, over = false }: { icon: IconName; label: string; value: string; id: string; over?: boolean }) {
	return (
		<div className="lm-stat">
			<span className="lm-stat-ic">
				<Ico name={icon} />
			</span>
			<span className="lm-stat-lab">{label}</span>
			<span className={`lm-stat-val${over ? " is-over" : ""}`} data-id={id}>
				{value}
			</span>
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

export function ActivityCard({ card, names, hide, source, onDetail }: ActivityCardProps) {
	const c = useObservatoryCopy();
	const s = card.subject;
	const call = s.kind === "run" || s.kind === "done" ? s.call : null;
	const answer = useToolContent(source, call?.eventId ?? null, call !== null && !call.running, hide);
	const detailId = s.kind === "wait" ? s.eventId : (call?.eventId ?? (s.kind === "idle" ? (s.last?.eventId ?? null) : null));
	let what: string;
	let desc = "";
	let runtimeLabel: string = c.card.runtime;
	let runtime = "–";
	switch (s.kind) {
		case "wait":
			what = hide || s.what === "" ? c.card.waitWhat("") : s.what;
			desc = c.card.waitDesc;
			runtimeLabel = c.card.waited;
			runtime = duration(c, s.waitingMs);
			break;
		case "think":
			what = c.card.thinking;
			runtime = duration(c, s.sinceMs);
			break;
		case "idle":
			what = c.card.idleWhat;
			if (s.last !== null) desc = c.card.lastJob(callWhat(c, s.last, hide), s.last.ok !== false, duration(c, s.last.runtimeMs));
			break;
		default:
			what = callWhat(c, s.call, hide);
			desc = answer.kind === "ok" ? answer.content.description : "";
			runtime = duration(c, s.call.runtimeMs);
	}
	const showBar = s.kind === "run" || s.kind === "think";
	const kind = kindLine(c, card, names);
	// What screen readers hear: the subject and its status, never the ticking runtime.
	const spoken = [kind, what].join(" · ");
	// The p95 of the earlier calls of this kind; "calls" counts them with this one.
	const history = call === null ? "–" : call.history === null ? c.side.none : `${duration(c, call.history.p95Ms)} ${c.card.historyCount(call.history.count)}`;
	const calls = call === null ? "–" : String((call.history?.count ?? 0) + 1);
	return (
		<section className="lm-card" aria-label={c.card.label} data-id="observe-card" data-status={card.status} data-station={call?.station} style={{ "--fc": colourOf(card, call) } as CSSProperties}>
			<span className="sr-only" role="status" data-id="observe-card-live">
				{spoken}
			</span>
			<div className="lm-card-main">
				<div className="lm-card-k">
					<i className="lm-card-dot" aria-hidden="true" />
					<span className="lm-card-kind" data-id="observe-card-kind">
						{kind}
					</span>
					<span className="lm-pill" data-s={card.status} data-id="observe-card-status">
						{c.card.status[card.status]}
					</span>
				</div>
				<div className="lm-card-what" data-id="observe-card-what" title={what}>
					{what}
				</div>
				{/* Every row is always there (empty when it has nothing to say), so the card keeps its height as the work changes. */}
				<div className="lm-card-desc" data-id={desc === "" ? undefined : "observe-card-desc"} title={desc === "" ? undefined : desc}>
					{desc}
				</div>
				{showBar ? (
					<div className={`lm-bar${call?.overP95 === true ? " is-over" : ""}`} role="progressbar" aria-label={c.card.status[card.status]} data-id="observe-card-bar">
						<i />
					</div>
				) : (
					<div className="lm-bar is-off" aria-hidden="true" />
				)}
				<div className="lm-card-out" data-id={call === null ? undefined : "observe-card-output"} title={call === null ? undefined : `${c.card.output}: ${outputText(c, answer)}`}>
					{call !== null && (
						<>
							{c.card.output}: <b>{outputText(c, answer)}</b>
						</>
					)}
				</div>
			</div>
			<div className="lm-card-stats">
				<Stat icon="clock" label={runtimeLabel} value={runtime} id="observe-card-runtime" />
				<Stat icon="bars" label={c.card.p95} value={history} id="observe-card-history" over={call?.overP95 === true} />
				<Stat icon="repeat" label={c.card.calls} value={calls} id="observe-card-calls" />
				<div className="lm-warnx" data-id={call?.overP95 === true ? "observe-card-over" : undefined}>
					{call?.overP95 === true ? c.card.overP95 : ""}
				</div>
			</div>
			<div className="lm-card-trail">
				<div className="lm-card-head">
					<span className="lm-card-journey-label">{c.card.journey}</span>
					<button type="button" className="lm-btn" data-id="observe-card-more" disabled={detailId === null} onClick={() => detailId !== null && onDetail(detailId)}>
						{c.card.more}
					</button>
				</div>
				<Trail steps={card.journey} names={names} c={c} />
			</div>
		</section>
	);
}

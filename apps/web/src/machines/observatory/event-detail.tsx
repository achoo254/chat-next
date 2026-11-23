// One event in full: its kind, station ("estimated" when the station was
// worked out from a filtered label), time, duration, result, filtered labels,
// model and tokens, and its content, asked of the machine by id when the
// detail opens (docs/observatory-wire.md section 6.5: an event frame never
// carries content). The content may be switched off for the project, not
// stored yet (a provisional event), or none: each says so. "Ẩn chi tiết"
// hides the labels and the content, and the content is then not even asked.
// "Tua tới đây" replays the session to the event's moment.
import { useEffect } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { clock, duration, eventLabel, findingValue, ruleName, tokens } from "./drill-format.ts";
import type { LiveMapContent, LiveMapEvent } from "./live-map-types.ts";
import { failureText, type ObservatoryLink } from "./observatory-client.ts";
import { useObservatoryCopy, type ObservatoryCopy } from "./observatory-copy.ts";
import { contextTokensOf } from "./replay-controller.ts";
import { stationOf, type StationCode } from "./station-catalog.ts";
import { useEventContent, type Asked } from "./use-observatory-session.ts";
import "./live-map-drawer.css";

/** `station_flags` bit: the station was worked out from the filtered label and may be wrong. */
export const STATION_ESTIMATED = 32;

/** Only prompts and tool calls have content to ask for. */
export function hasContent(event: LiveMapEvent): boolean {
	return event.kind === "prompt" || event.kind === "tool";
}

interface DetailShared {
	readonly event: LiveMapEvent;
	readonly hideDetails: boolean;
	/** Replay the session to this moment. */
	readonly onReplayTo: (at: number) => void;
	readonly onClose: () => void;
}

export interface EventDetailProps extends DetailShared {
	readonly link: ObservatoryLink;
	readonly sessionId: string;
	readonly online: boolean;
}

/** The detail, asking the machine for the event's content (never while details are hidden). */
export function EventDetail({ link, sessionId, online, ...shown }: EventDetailProps) {
	const asked = !shown.hideDetails && hasContent(shown.event) ? shown.event.id : null;
	const content = useEventContent(link, sessionId, asked, online);
	return <EventDetailView content={asked === null ? null : content} {...shown} />;
}

function stationLine(e: LiveMapEvent): { code: StationCode; estimated: boolean } | null {
	switch (e.kind) {
		case "tool":
			return { code: stationOf(e.station), estimated: (e.stationFlags & STATION_ESTIMATED) !== 0 };
		case "lifecycle":
		case "bottleneck":
			return { code: stationOf(e.station), estimated: false };
		case "subagent":
			return { code: "ORCHESTRATOR", estimated: false };
		case "instruction":
			return { code: "MEMORY", estimated: false };
		case "git":
			return { code: "GIT", estimated: false };
		case "prompt":
		case "api":
			return { code: "CORE", estimated: false };
		default:
			return null;
	}
}

function resultOf(c: ObservatoryCopy, e: LiveMapEvent): string | null {
	switch (e.kind) {
		case "tool":
			return e.success === undefined ? c.detail.running : e.success ? c.detail.ok : c.detail.failed;
		case "subagent":
			return e.endedAt === 0 ? c.detail.running : c.detail.ended;
		case "bottleneck":
			return `${e.open ? c.drawer.open : c.drawer.closed} · ${c.severity[e.severity]} · ${c.drawer.finding(ruleName(c, e), findingValue(c, e, e.value), findingValue(c, e, e.threshold))}`;
		default:
			return null;
	}
}

function durationOf(e: LiveMapEvent): number | null {
	if (e.kind === "tool" || e.kind === "api") return e.durationMs ?? null;
	if (e.kind === "subagent" && e.endedAt > 0) return Math.max(0, e.endedAt - e.at);
	return null;
}

function ContentBlock({ c, content }: { c: ObservatoryCopy; content: Asked<LiveMapContent> }) {
	const observe = useMachinesCopy().observe;
	if (content.kind === "loading")
		return (
			<p className="lmd-note" role="status">
				{c.detail.contentLoading}
			</p>
		);
	if (content.kind === "failed")
		return (
			<p className="mx-error" role="alert">
				{failureText(observe, content.failure)}
			</p>
		);
	switch (content.value.state) {
		case "stored":
			return <pre className="lmd-content" data-id="lmd-content">{content.value.text}</pre>;
		case "off":
			return <p className="lmd-note" data-id="lmd-content-off">{c.detail.contentOff}</p>;
		case "not_yet":
			return <p className="lmd-note" data-id="lmd-content-not-yet">{c.detail.contentNotYet}</p>;
		default:
			return <p className="lmd-note" data-id="lmd-content-none">{c.detail.contentNone}</p>;
	}
}

/** The detail for content already asked; `content` null: nothing asked (hidden, or a kind without content). */
export function EventDetailView({ event, content, hideDetails, onReplayTo, onClose }: DetailShared & { content: Asked<LiveMapContent> | null }) {
	const c = useObservatoryCopy();
	const observe = useMachinesCopy().observe;
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	if (event.kind === "session" || event.kind === "unknown") return null;
	const station = stationLine(event);
	const took = durationOf(event);
	const result = resultOf(c, event);
	const label = eventLabel(c, event, hideDetails);
	const api = event.kind === "api" ? event : null;
	const context = api === null ? undefined : contextTokensOf(api);
	return (
		<aside className="lmd-panel" aria-label={c.detail.label} data-id="lmd-detail" data-kind={event.kind}>
			<header className="lmd-head">
				<div className="lmd-title">
					<h3>{c.detail.kinds[event.kind]}</h3>
					<p className="lmd-note">{event.provisional ? `${clock(c, event.at)} · ${c.detail.provisional}` : clock(c, event.at)}</p>
				</div>
				<button type="button" className="btn btn-sm mx-btn-ghost lmd-close" aria-label={c.close} data-id="lmd-close" onClick={onClose}>
					×
				</button>
			</header>
			<div className="lmd-body">
				<dl className="mx-kv lmd-kv" data-id="lmd-fields">
					<dt>{c.detail.kind}</dt>
					<dd>{c.detail.kinds[event.kind]}</dd>
					{station !== null && (
						<>
							<dt>{c.detail.station}</dt>
							<dd data-id="lmd-station">{station.estimated ? `${observe.stations[station.code]} (${c.detail.estimated})` : observe.stations[station.code]}</dd>
						</>
					)}
					<dt>{c.detail.time}</dt>
					<dd>{clock(c, event.at)}</dd>
					{took !== null && (
						<>
							<dt>{c.detail.duration}</dt>
							<dd>{duration(c, took)}</dd>
						</>
					)}
					{result !== null && (
						<>
							<dt>{c.detail.result}</dt>
							<dd data-id="lmd-result">{result}</dd>
						</>
					)}
					{!hideDetails && label !== "" && (
						<>
							<dt>{c.detail.labels}</dt>
							<dd className="mono" data-id="lmd-labels">
								{label}
							</dd>
						</>
					)}
					{(event.kind === "api" || event.kind === "subagent") && event.model !== "" && (
						<>
							<dt>{c.detail.model}</dt>
							<dd>{event.model}</dd>
						</>
					)}
					{api !== null && api.outputTokens !== undefined && (
						<>
							<dt>{c.detail.tokens}</dt>
							<dd data-id="lmd-event-tokens">{c.detail.tokenLine(tokens(c, api.outputTokens), context === undefined ? null : tokens(c, context))}</dd>
						</>
					)}
				</dl>
				{hideDetails ? (
					<p className="lmd-note" data-id="lmd-hidden">
						{c.detail.hidden}
					</p>
				) : (
					content !== null && (
						<section className="lmd-section" aria-label={c.detail.content}>
							<h4>{c.detail.content}</h4>
							<ContentBlock c={c} content={content} />
						</section>
					)
				)}
			</div>
			<footer className="lmd-foot">
				<button type="button" className="btn btn-sm" data-id="lmd-replay-here" onClick={() => onReplayTo(event.at)}>
					{c.detail.replayHere}
				</button>
			</footer>
		</aside>
	);
}

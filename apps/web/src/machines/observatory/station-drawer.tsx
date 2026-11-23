// A station's drill-down (docs/observatory-wire.md section 6.6): its findings
// first (the sentence with its numbers, threshold, n, and a button per
// evidence event), then calls, p50/p95 and error rate, tokens and Claude
// Code's estimated cost (or "no cost"), the split by sub-key, the comparison
// with up to 5 earlier sessions of the repository, the 5 slowest and the 20
// most recent events. Live it covers the session from its start until now;
// replaying, up to the replayed moment (`at`). A side panel on a wide
// screen, a sheet from the bottom on a phone (live-map-drawer.css), not
// modal: the map stays usable beside it. "Ẩn chi tiết" hides the sub-keys'
// names (files, domains, programs, MCP servers) and the events' labels.
import { useEffect, type ReactNode } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { clock, compareWithPrevious, count, delta, duration, eventLabel, failureRate, findingValue, ruleName, share, tokens, usd, type Comparison } from "./drill-format.ts";
import type { LiveMapBottleneck, LiveMapEvent, StationDrill, StationNumbers } from "./live-map-types.ts";
import { failureText, type ObservatoryLink } from "./observatory-client.ts";
import { useObservatoryCopy, type ObservatoryCopy } from "./observatory-copy.ts";
import type { StationCode } from "./station-catalog.ts";
import { useStationDrill, type Asked } from "./use-observatory-session.ts";
import "./live-map-drawer.css";

/** What a drawer is asked to show and what it can open. */
export interface StationDrawerShared {
	readonly station: StationCode;
	/** 0 while live; the replayed moment otherwise. */
	readonly at: number;
	/** The session's start, for "from … until now". */
	readonly startedAt: number;
	readonly hideDetails: boolean;
	/** An event of the lists: open its detail. */
	readonly onOpenEvent: (event: LiveMapEvent) => void;
	/** A finding's evidence, by event id: open it (the caller finds the event, or replays to it). */
	readonly onEvidence: (eventId: string) => void;
	readonly onClose: () => void;
}

export interface StationDrawerProps extends StationDrawerShared {
	readonly link: ObservatoryLink;
	readonly sessionId: string;
	readonly online: boolean;
}

/** The drawer, asking the machine for the station's numbers (again when `at` or the station changes). */
export function StationDrawer({ link, sessionId, online, ...shown }: StationDrawerProps) {
	const drill = useStationDrill(link, sessionId, shown.station, shown.at, online);
	return <StationDrawerView drill={drill} {...shown} />;
}

/** One event of a list: its time, label, and how long it took or how it ended. */
export function EventRow({ c, event, hideDetails, onOpen }: { c: ObservatoryCopy; event: LiveMapEvent; hideDetails: boolean; onOpen: (event: LiveMapEvent) => void }) {
	const failed = event.kind === "tool" && event.success === false;
	const took = event.kind === "tool" && event.durationMs !== undefined ? duration(c, event.durationMs) : event.kind === "tool" && event.success === undefined ? c.detail.running : "";
	return (
		<li>
			<button type="button" className="lmd-event" data-id={`lmd-event-${event.id}`} data-result={failed ? "failed" : undefined} onClick={() => onOpen(event)}>
				<span className="lmd-time">{clock(c, event.at)}</span>
				<span className="lmd-name">{eventLabel(c, event, hideDetails)}</span>
				<span className="lmd-took">{failed ? `${c.detail.failed}${took === "" ? "" : ` · ${took}`}` : took}</span>
			</button>
		</li>
	);
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
	return (
		<section className="lmd-section" data-id={id} aria-label={title}>
			<h4>{title}</h4>
			{children}
		</section>
	);
}

function Finding({ c, finding, hideDetails, onEvidence }: { c: ObservatoryCopy; finding: LiveMapBottleneck; hideDetails: boolean; onEvidence: (id: string) => void }) {
	const sentence = c.drawer.finding(ruleName(c, finding), findingValue(c, finding, finding.value), findingValue(c, finding, finding.threshold));
	const what = hideDetails || finding.subkey === "" ? "" : ` (${finding.subkey})`;
	return (
		<li className="lmd-finding" data-severity={finding.severity} data-open={finding.open} data-id={`lmd-finding-${finding.rule}`}>
			<p>
				<strong>{finding.open ? c.drawer.open : c.drawer.closed}</strong> · {c.severity[finding.severity]} · {sentence}
				{what}
				{finding.n === undefined ? "" : ` · ${c.drawer.findingN(finding.n)}`}
			</p>
			{finding.evidenceIds.length > 0 && (
				<div className="lmd-evidence">
					{finding.evidenceIds.map((id, i) => (
						<button key={id} type="button" className="btn btn-sm mx-btn-ghost" data-id={`lmd-evidence-${id}`} onClick={() => onEvidence(id)}>
							{c.drawer.evidence(i + 1)}
						</button>
					))}
				</div>
			)}
		</li>
	);
}

function latency(c: ObservatoryCopy, n: StationNumbers): string {
	if (n.p50Ms === undefined && n.p95Ms === undefined) return "—";
	const both = `${n.p50Ms === undefined ? "—" : duration(c, n.p50Ms)} / ${n.p95Ms === undefined ? "—" : duration(c, n.p95Ms)}`;
	return n.sampled ? `${both} (${c.drawer.sampled})` : both;
}

function compareLabel(c: ObservatoryCopy, row: Comparison): string {
	switch (row.metric) {
		case "p95":
			return c.drawer.compareP95;
		case "errors":
			return c.drawer.compareErrors;
		case "tokens":
			return c.drawer.compareTokens;
	}
}

function Numbers({ c, numbers }: { c: ObservatoryCopy; numbers: StationNumbers }) {
	const rate = failureRate(numbers);
	const hasTokens = numbers.apiRequests > 0;
	return (
		<>
			<dl className="lmd-tiles" data-id="lmd-numbers">
				<div>
					<dt>{c.drawer.calls}</dt>
					<dd>{count(c, numbers.calls)}</dd>
				</div>
				<div>
					<dt>{c.drawer.latency}</dt>
					<dd>{latency(c, numbers)}</dd>
				</div>
				<div>
					<dt>{c.drawer.errorRate}</dt>
					<dd>{rate === null ? "—" : share(c, rate)}</dd>
				</div>
			</dl>
			{hasTokens && (
				<dl className="mx-kv lmd-kv" data-id="lmd-tokens">
					<dt>{c.drawer.tokens}</dt>
					<dd>{c.drawer.tokenParts(tokens(c, numbers.inputTokens), tokens(c, numbers.outputTokens), tokens(c, numbers.cacheReadTokens + numbers.cacheWriteTokens))}</dd>
					<dt>{c.drawer.cost}</dt>
					<dd data-id="lmd-cost">
						{numbers.hasCost ? usd(c, numbers.costUsdEstimate) : c.drawer.noCost}
						{numbers.hasCost && numbers.requestsWithoutCost > 0 ? ` · ${c.drawer.withoutCost(numbers.requestsWithoutCost)}` : ""}
					</dd>
				</dl>
			)}
			{hasTokens && numbers.hasCost && <p className="lmd-note">{c.drawer.costNote}</p>}
		</>
	);
}

function DrillBody({ c, drill, hideDetails, onOpenEvent, onEvidence }: { c: ObservatoryCopy; drill: StationDrill } & Pick<StationDrawerShared, "hideDetails" | "onOpenEvent" | "onEvidence">) {
	const findings = [...drill.bottlenecks].sort((a, b) => Number(b.open) - Number(a.open));
	const comparison = compareWithPrevious(
		drill.numbers,
		drill.previous.map((p) => p.numbers),
	);
	const partKind = drill.parts[0]?.kind ?? "";
	return (
		<>
			<Section title={c.drawer.findings} id="lmd-findings">
				{findings.length === 0 ? (
					<p className="lmd-note">{c.drawer.noFindings}</p>
				) : (
					<ul className="lmd-list">
						{findings.map((f) => (
							<Finding key={`${f.rule}:${f.subkey}`} c={c} finding={f} hideDetails={hideDetails} onEvidence={onEvidence} />
						))}
					</ul>
				)}
			</Section>
			<Numbers c={c} numbers={drill.numbers} />
			{drill.parts.length > 0 && (
				<Section title={c.drawer.parts[partKind] ?? c.drawer.partsOther} id="lmd-parts">
					<ul className="lmd-list">
						{drill.parts.map((part, i) => (
							<li key={`${part.kind}:${part.key}`} className="lmd-part">
								<span className="lmd-name">{hideDetails ? c.drawer.hiddenPart(i + 1) : part.key}</span>
								<span className="lmd-took">{c.drawer.partLine(count(c, part.numbers.calls), part.numbers.p95Ms === undefined ? "—" : duration(c, part.numbers.p95Ms))}</span>
							</li>
						))}
					</ul>
				</Section>
			)}
			<Section title={c.drawer.previous} id="lmd-previous">
				{drill.previous.length === 0 ? (
					<p className="lmd-note">{c.drawer.previousNone}</p>
				) : (
					<>
						<dl className="mx-kv lmd-kv">
							{comparison.map((row) => (
								<div key={row.metric} className="lmd-compare" data-metric={row.metric}>
									<dt>{compareLabel(c, row)}</dt>
									<dd>{row.delta === null ? c.drawer.compareNone : delta(c, row.delta)}</dd>
								</div>
							))}
						</dl>
						<p className="lmd-note">{c.drawer.previousOver(drill.previous.length)}</p>
					</>
				)}
			</Section>
			<Section title={c.drawer.slowest} id="lmd-slowest">
				{drill.slowest.length === 0 ? (
					<p className="lmd-note">{c.drawer.noEvents}</p>
				) : (
					<ul className="lmd-list">
						{drill.slowest.map((e) => (
							<EventRow key={e.id} c={c} event={e} hideDetails={hideDetails} onOpen={onOpenEvent} />
						))}
					</ul>
				)}
			</Section>
			<Section title={c.drawer.recent} id="lmd-recent">
				{drill.recent.length === 0 ? (
					<p className="lmd-note">{c.drawer.noEvents}</p>
				) : (
					<ul className="lmd-list">
						{drill.recent.map((e) => (
							<EventRow key={e.id} c={c} event={e} hideDetails={hideDetails} onOpen={onOpenEvent} />
						))}
					</ul>
				)}
			</Section>
		</>
	);
}

/** The drawer for numbers already asked (loading, the numbers, or why they failed). */
export function StationDrawerView({ drill, station, at, startedAt, hideDetails, onOpenEvent, onEvidence, onClose }: StationDrawerShared & { drill: Asked<StationDrill> }) {
	const c = useObservatoryCopy();
	const observe = useMachinesCopy().observe;
	const name = observe.stations[station];
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<aside className="lmd-panel" aria-label={c.drawer.label(name)} data-id="lmd-drawer" data-station={station}>
			<header className="lmd-head">
				<div className="lmd-title">
					<h3>{name}</h3>
					<p className="lmd-note">{at > 0 ? c.drawer.scopeReplay(clock(c, at)) : c.drawer.scopeLive(clock(c, startedAt))}</p>
				</div>
				<button type="button" className="btn btn-sm mx-btn-ghost lmd-close" aria-label={c.close} data-id="lmd-close" onClick={onClose}>
					×
				</button>
			</header>
			<div className="lmd-body">
				{drill.kind === "loading" && (
					<p className="lmd-note" role="status">
						{c.drawer.loading}
					</p>
				)}
				{drill.kind === "failed" && (
					<p className="mx-error" role="alert">
						{failureText(observe, drill.failure)}
					</p>
				)}
				{drill.kind === "done" && <DrillBody c={c} drill={drill.value} hideDetails={hideDetails} onOpenEvent={onOpenEvent} onEvidence={onEvidence} />}
			</div>
		</aside>
	);
}

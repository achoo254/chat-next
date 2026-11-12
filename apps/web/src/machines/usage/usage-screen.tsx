// "Hiệu quả" (route { page: "usage" }): a machine's AI usage of one
// repository, or of all of them, from the ledger the machine keeps
// (remote.proto, "usage of the AIs"), read over the end-to-end link: totals of
// the last 7 and 30 days, the mean context per main-session call against the
// 60 days before, the share of calls the app opened, the rules' suggestions,
// a switch per rule and deleting the ledger. A machine whose agent predates
// the ledger answers UNSUPPORTED_REQUEST: the page asks to update it. Loaded
// on demand with its own styles; no charts.
import { useEffect, useState } from "react";
import type { UsageReport } from "@achoo254/chat-proto/remote/remote";
import { paths } from "../../router.tsx";
import { machineErrorText, unsupportedByMachine } from "../machine-errors.ts";
import { PageHead } from "../page-head.tsx";
import { aiName, useEntry, useHub, useLink } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ask, type WsLink } from "../workspace/ws-client.ts";
import { DeleteLedger, RuleSwitches } from "./usage-controls.tsx";
import { count, hintValue, moment, ruleCopy, tokens } from "./usage-format.ts";
import { dayOf, reportRange, summarize, type UsageSummary, type UsageTotals } from "./usage-summary.ts";
import "./usage.css";

type Loaded = { readonly kind: "ready"; readonly report: UsageReport; readonly today: string } | { readonly kind: "unsupported" } | { readonly kind: "error"; readonly error: unknown };

export interface UsageViewProps {
	readonly link: WsLink;
	readonly online: boolean;
	/** The machine's ref, for the back link. */
	readonly machine: string;
	readonly machineName: string;
	/** The AI's name as the machine reports it, for error sentences. */
	readonly ai: string;
	/** The canonical repository key; "" for every repository. */
	readonly repoKey: string;
}

/** The page over a machine's link (tests render it over a fake machine). */
export function UsageView({ link, online, machine, machineName, ai, repoKey }: UsageViewProps) {
	const t = useMachinesCopy();
	const u = t.usage;
	// Bumped to read the report again (a switch changed, the ledger was deleted, a hint arrived).
	const [version, setVersion] = useState(0);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const reload = () => setVersion((v) => v + 1);
	useEffect(() => {
		if (!online) return;
		let current = true;
		const today = dayOf(new Date());
		ask(link, { case: "usageReportRequest", value: { ...reportRange(today), repoKey: "" } }, "usageReport").then(
			(report) => current && setLoaded({ kind: "ready", report, today }),
			(error: unknown) => current && setLoaded(unsupportedByMachine(error) ? { kind: "unsupported" } : { kind: "error", error }),
		);
		return () => {
			current = false;
		};
	}, [link, online, version]);
	// A hint the machine sends while a session runs: the list is out of date.
	useEffect(() => link.onFrame((body) => body.case === "usageSuggestion" && setVersion((v) => v + 1)), [link]);

	const scope = repoKey === "" ? u.allRepos : repoKey;
	let body;
	if (!online && loaded === null) body = <p className="note" role="status">{u.offline}</p>;
	else if (loaded === null) body = <p className="note" role="status">{u.loading}</p>;
	else if (loaded.kind === "unsupported")
		body = (
			<div className="mx-warn" role="status" data-id="usage-needs-update">
				<p>{u.needsUpdate}</p>
			</div>
		);
	else
		body = (
			<>
				{loaded.kind === "error" ? (
					<div className="mx-usage-actions">
						<p className="mx-error" role="alert">
							{machineErrorText(t, loaded.error, ai)}
						</p>
						<button type="button" className="btn btn-sm" disabled={!online} onClick={reload}>
							{u.retry}
						</button>
					</div>
				) : (
					<Report report={loaded.report} summary={summarize(loaded.report, repoKey, loaded.today)} all={repoKey === ""} />
				)}
				{online && <RuleSwitches link={link} ai={ai} onChanged={reload} />}
				{online && <DeleteLedger link={link} ai={ai} onDeleted={reload} />}
			</>
		);
	return (
		<div className="mx-scroll" role="region" aria-label={u.title}>
			<PageHead back={paths.machine(machine)} backLabel={t.back} title={u.title} subtitle={u.subtitle(scope, machineName)} />
			<div className="mx-body mx-usage">{body}</div>
		</div>
	);
}

const TOTAL_ROWS = ["mainTurns", "subagentTurns", "input", "cacheRead", "cacheWrite", "output"] as const;

function Report({ report, summary, all }: { report: UsageReport; summary: UsageSummary; all: boolean }) {
	const t = useMachinesCopy();
	const u = t.usage;
	const lastScan = Number(report.lastScanAt);
	const shape = report.shape;
	const cell = (row: (typeof TOTAL_ROWS)[number], x: UsageTotals) => (row === "mainTurns" || row === "subagentTurns" ? count(u, x[row]) : tokens(u, x[row]));
	const mean = (x: UsageTotals) => (x.meanContext === null ? u.contextNone : tokens(u, x.meanContext));
	return (
		<>
			<p className="note" data-id="usage-last-scan">
				{lastScan > 0 ? u.lastScan(moment(u, lastScan)) : u.neverScanned}
			</p>
			{shape !== undefined && (shape.lowUsageRatio || shape.drift || shape.unknownTypes > 0) && (
				<p className="mx-warn" role="note">
					{u.shapeChanged}
				</p>
			)}
			{summary.empty ? (
				<p className="note" role="status" data-id="usage-empty">
					{u.empty}
				</p>
			) : (
				<>
					<section className="mx-card" aria-labelledby="usage-totals-title" data-id="usage-totals">
						<h3 id="usage-totals-title">{u.totals}</h3>
						<table className="mx-usage-table">
							<thead>
								<tr>
									<td />
									<th scope="col">{u.days7}</th>
									<th scope="col">{u.days30}</th>
								</tr>
							</thead>
							<tbody>
								{TOTAL_ROWS.map((row) => (
									<tr key={row}>
										<th scope="row">{u[row]}</th>
										<td>{cell(row, summary.week)}</td>
										<td>{cell(row, summary.month)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
					<section className="mx-card" aria-labelledby="usage-context-title" data-id="usage-context">
						<h3 id="usage-context-title">{u.contextTitle}</h3>
						<dl className="mx-kv">
							<dt>{u.contextRecent}</dt>
							<dd>{mean(summary.month)}</dd>
							<dt>{u.contextBaseline}</dt>
							<dd>{mean(summary.baseline)}</dd>
						</dl>
						{summary.changePercent !== null && <p className={summary.changePercent <= 0 ? "mx-usage-better" : "mx-usage-worse"}>{u.contextChange(summary.changePercent)}</p>}
					</section>
					<section className="mx-card" aria-labelledby="usage-app-title" data-id="usage-app-share">
						<h3 id="usage-app-title">{u.appShareTitle}</h3>
						<p>{summary.appPercent === null ? u.contextNone : u.appShare(summary.appPercent, count(u, summary.month.appTurns), count(u, summary.month.mainTurns))}</p>
					</section>
				</>
			)}
			<section className="mx-card" aria-labelledby="usage-hints-title" data-id="usage-hints">
				<h3 id="usage-hints-title">{u.hintsTitle}</h3>
				{summary.hints.length === 0 ? (
					<p className="note">{u.hintsEmpty}</p>
				) : (
					<ul className="mx-usage-hints">
						{summary.hints.map((s) => {
							const rule = ruleCopy(u, s.rule);
							return (
								<li key={`${s.sessionId}/${s.rule}`}>
									<b>{rule.name}</b>
									{s.experimental && <span className="mx-tag">{u.experimental}</span>}
									{Number(s.notifiedAt) > 0 && <span className="mx-tag">{u.notified}</span>}
									<p>{rule.hint(hintValue(u, s))}</p>
									<small className="note">
										{all ? `${s.repoKey} · ` : ""}
										{u.hintMeta(s.sessionId.slice(0, 8), s.turn, moment(u, Number(s.at)))}
									</small>
								</li>
							);
						})}
					</ul>
				)}
			</section>
		</>
	);
}

/** The route's page: the machine's link from the hub. */
export default function UsageScreen({ machine, repoKey }: { machine: string; repoKey: string }) {
	const hub = useHub();
	const [link, state] = useLink(hub, machine);
	const entry = useEntry(hub, machine);
	const name = entry?.name ?? state.info?.name ?? machine;
	return <UsageView link={link} online={state.status.kind === "open"} machine={machine} machineName={name} ai={aiName(state.info, "claude")} repoKey={repoKey} />;
}

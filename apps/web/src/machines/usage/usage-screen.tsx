// "Hiệu quả" (route { page: "usage" }): a machine's AI usage of one
// repository, or of all of them, from the ledger the machine keeps
// (remote.proto, "usage of the AIs"), read over the end-to-end link. In the
// order a user asks: is there plan usage left (the accounts' windows), how
// were the last 30 days against the 30 before, where did it go (by day, by
// repository, model or session), which habits cost the most and what to do
// instead, and what the sessions left in git; the raw token table, the
// rules' switches and deleting the ledger are folded away at the end.
//
// A machine before tunelo 3.30.0 sends no costs, models, sessions or
// commits: those parts are hidden and a line asks to update it. A machine
// whose agent predates the ledger answers UNSUPPORTED_REQUEST: the page asks
// to update it. Loaded on demand with its own styles.
import { useEffect, useState } from "react";
import type { AiAccount, ProviderInfo, UsageReport } from "@achoo254/chat-proto/remote/remote";
import { paths } from "../../router.tsx";
import { machineErrorText, unsupportedByMachine } from "../machine-errors.ts";
import { useAccountList } from "../machine-profile.ts";
import { PageHead } from "../page-head.tsx";
import { aiName, useEntry, useHub, useLink } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ask, type WsLink } from "../workspace/ws-client.ts";
import { UsageChart } from "./usage-chart.tsx";
import { DeleteLedger, RuleSwitches } from "./usage-controls.tsx";
import { count, moment, percent, tokens, usd } from "./usage-format.ts";
import { UsageHabits } from "./usage-habits.tsx";
import { RULE_LIMITS, cacheShare, changeOf, insightsOf, type Insights } from "./usage-insights.ts";
import { UsageOutcome } from "./usage-outcome.tsx";
import { QuotaBlock } from "./usage-quota.tsx";
import { useSessionNames } from "./usage-session-names.ts";
import { dayOf, reportRange, summarize, type UsageSummary, type UsageTotals } from "./usage-summary.ts";
import { UsageWhere } from "./usage-where.tsx";
import "./usage.css";

type Loaded = { readonly kind: "ready"; readonly report: UsageReport; readonly today: string; /** When it arrived, Unix milliseconds. */ readonly at: number } | { readonly kind: "unsupported" } | { readonly kind: "error"; readonly error: unknown };

export interface UsageViewProps {
	readonly link: WsLink;
	readonly online: boolean;
	/** The machine's ref, for the back link and the links to its threads. */
	readonly machine: string;
	readonly machineName: string;
	/** The AI's name as the machine reports it, for error sentences. */
	readonly ai: string;
	/** The canonical repository key; "" for every repository. */
	readonly repoKey: string;
	/** Every AI account of the machine with its last plan usage; null while unknown. */
	readonly accounts?: readonly AiAccount[] | null;
	/** The AIs the machine reports, for the accounts' names. */
	readonly providers?: readonly ProviderInfo[];
}

/** The page over a machine's link (tests render it over a fake machine). */
export function UsageView({ link, online, machine, machineName, ai, repoKey, accounts = null, providers = [] }: UsageViewProps) {
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
			(report) => current && setLoaded({ kind: "ready", report, today, at: Date.now() }),
			(error: unknown) => current && setLoaded(unsupportedByMachine(error) ? { kind: "unsupported" } : { kind: "error", error }),
		);
		return () => {
			current = false;
		};
	}, [link, online, version]);
	// A hint the machine sends while a session runs: the numbers are out of date.
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
					<Report link={link} online={online} machine={machine} report={loaded.report} today={loaded.today} at={loaded.at} repoKey={repoKey} accounts={accounts} providers={providers} />
				)}
				{online && (
					<details className="mx-card mx-usage-fold" data-id="usage-controls">
						<summary>{u.controls}</summary>
						<RuleSwitches link={link} ai={ai} onChanged={reload} />
						<DeleteLedger link={link} ai={ai} onDeleted={reload} />
					</details>
				)}
			</>
		);
	return (
		<div className="mx-scroll" role="region" aria-label={u.title}>
			<PageHead back={paths.machine(machine)} backLabel={t.back} title={u.title} subtitle={u.subtitle(scope, machineName)} />
			<div className="mx-body mx-usage">{body}</div>
		</div>
	);
}

interface ReportProps {
	readonly link: WsLink;
	readonly online: boolean;
	readonly machine: string;
	readonly report: UsageReport;
	readonly today: string;
	/** When the report arrived, for the plan usage's forecast. */
	readonly at: number;
	readonly repoKey: string;
	readonly accounts: readonly AiAccount[] | null;
	readonly providers: readonly ProviderInfo[];
}

function Report({ link, online, machine, report, today, at, repoKey, accounts, providers }: ReportProps) {
	const u = useMachinesCopy().usage;
	const summary = summarize(report, repoKey, today);
	const insights = insightsOf(report, repoKey, today);
	const names = useSessionNames(link, report, online);
	const lastScan = Number(report.lastScanAt);
	const shape = report.shape;
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
			<QuotaBlock accounts={accounts} providers={providers} points={report.quota} now={at} />
			{summary.empty ? (
				<p className="note" role="status" data-id="usage-empty">
					{u.empty}
				</p>
			) : (
				<>
					{!insights.rich && (
						<p className="note" role="note" data-id="usage-rich-needs-update">
							{u.richNeedsUpdate}
						</p>
					)}
					<Overview summary={summary} insights={insights} />
					<UsageChart report={report} repoKey={repoKey} today={today} rich={insights.rich} />
					<UsageWhere machine={machine} repos={insights.repos} models={insights.models} sessions={insights.sessions} names={names} all={repoKey === ""} rich={insights.rich} />
				</>
			)}
			<UsageHabits machine={machine} rules={insights.rules} names={names} />
			{insights.outcomes !== null && <UsageOutcome machine={machine} outcomes={insights.outcomes} names={names} />}
			{!summary.empty && <TokenDetails summary={summary} />}
		</>
	);
}

function Overview({ summary, insights }: { summary: UsageSummary; insights: Insights }) {
	const u = useMachinesCopy().usage;
	const o = u.overview;
	const { month, previous } = insights;
	const noPrevious = previous.turns === 0;
	const unpriced = insights.sessions.reduce((s, x) => s + x.unpricedTurns, 0);
	const shareNow = cacheShare(month);
	const shareBefore = cacheShare(previous);
	return (
		<section className="mx-usage-section" aria-labelledby="usage-overview-title" data-id="usage-overview">
			<div className="mx-usage-section-head">
				<h3 id="usage-overview-title">{o.title}</h3>
				{!noPrevious && <small className="note">{o.vsPrevious}</small>}
			</div>
			<div className="mx-usage-tiles">
				{month.cost !== null && (
					<Tile label={o.cost} value={usd(u, month.cost)} change={changeOf(month.cost, previous.cost)} upIsBad hint={unpriced > 0 ? `${o.costHint} ${o.unpriced(count(u, unpriced))}` : o.costHint} />
				)}
				<Tile
					label={o.turns}
					value={count(u, month.turns)}
					change={changeOf(month.turns, previous.turns)}
					hint={o.turnsHint(summary.appPercent === null ? u.contextNone : `${summary.appPercent}%`, count(u, summary.month.subagentTurns))}
				/>
				<Tile
					label={o.context}
					value={summary.month.meanContext === null ? u.contextNone : tokens(u, summary.month.meanContext)}
					change={changeOf(summary.month.meanContext, summary.previous.meanContext)}
					upIsBad
					hint={o.contextHint(tokens(u, RULE_LIMITS.maxContext))}
				/>
				<Tile
					label={o.cache}
					value={shareNow === null ? u.contextNone : percent(u, shareNow)}
					change={changeOf(shareNow, shareBefore)}
					hint={o.cacheHint}
				/>
			</div>
			{noPrevious && <p className="note">{o.noPrevious}</p>}
		</section>
	);
}

/** A number with its change against the 30 days before; `upIsBad` colours a rise as a warning. */
function Tile({ label, value, change, hint, upIsBad = false }: { label: string; value: string; change: number | null; hint: string; upIsBad?: boolean }) {
	const o = useMachinesCopy().usage.overview;
	const text = change === null ? "" : change > 0 ? o.up(change) : change < 0 ? o.down(-change) : o.same;
	const tone = change === null || change === 0 ? "" : change > 0 === upIsBad ? "mx-usage-worse" : "mx-usage-better";
	return (
		<div className="mx-card mx-usage-tile" data-id="usage-tile">
			<span className="note">{label}</span>
			<b className="mx-usage-big">{value}</b>
			{text !== "" && <span className={tone}>{text}</span>}
			<small className="note">{hint}</small>
		</div>
	);
}

const TOTAL_ROWS = ["mainTurns", "subagentTurns", "input", "cacheRead", "cacheWrite", "output"] as const;

function TokenDetails({ summary }: { summary: UsageSummary }) {
	const u = useMachinesCopy().usage;
	const d = u.details;
	const cell = (row: (typeof TOTAL_ROWS)[number], x: UsageTotals) => (row === "mainTurns" || row === "subagentTurns" ? count(u, x[row]) : tokens(u, x[row]));
	return (
		<details className="mx-card mx-usage-fold" data-id="usage-totals">
			<summary>{d.title}</summary>
			<table className="mx-usage-table">
				<thead>
					<tr>
						<td />
						<th scope="col">{d.days7}</th>
						<th scope="col">{d.days30}</th>
					</tr>
				</thead>
				<tbody>
					{TOTAL_ROWS.map((row) => (
						<tr key={row}>
							<th scope="row">{d[row]}</th>
							<td>{cell(row, summary.week)}</td>
							<td>{cell(row, summary.month)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</details>
	);
}

/** The route's page: the machine's link from the hub, with its AI accounts for the plan usage. */
export default function UsageScreen({ machine, repoKey }: { machine: string; repoKey: string }) {
	const hub = useHub();
	const [link, state] = useLink(hub, machine);
	const entry = useEntry(hub, machine);
	const online = state.status.kind === "open";
	const providers = state.info?.providers ?? [];
	const accounts = useAccountList(link, state.machineAccounts, online, providers.some((p) => p.capabilities?.accounts === true));
	const name = entry?.name ?? state.info?.name ?? machine;
	return (
		<UsageView
			link={link}
			online={online}
			machine={machine}
			machineName={name}
			ai={aiName(state.info, "")}
			repoKey={repoKey}
			accounts={accounts.whole?.accounts ?? null}
			providers={providers}
		/>
	);
}

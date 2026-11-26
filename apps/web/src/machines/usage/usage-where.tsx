// "Tiêu vào đâu" of the "Hiệu quả" page: the last 30 days by repository,
// and from tunelo 3.30.0 by model and by session (the machine's costliest).
// A repository row opens the page filtered to it; a session held by a thread
// opens that thread.
import type { UsageSession } from "@achoo254/chat-proto/remote/remote";
import { useState } from "react";
import { Link, paths } from "../../router.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { Segmented } from "./usage-chart.tsx";
import { count, percent, tokens, usd } from "./usage-format.ts";
import type { Breakdown } from "./usage-insights.ts";
import { usagePath } from "./usage-paths.ts";
import type { SessionName } from "./usage-session-names.ts";

type Tab = "repos" | "models" | "sessions";

export interface WhereProps {
	readonly machine: string;
	readonly repos: readonly Breakdown[];
	readonly models: readonly Breakdown[];
	readonly sessions: readonly UsageSession[];
	readonly names: ReadonlyMap<string, SessionName>;
	/** Every repository is shown: a repository row opens its own page. */
	readonly all: boolean;
	readonly rich: boolean;
}

export function UsageWhere({ machine, repos, models, sessions, names, all, rich }: WhereProps) {
	const u = useMachinesCopy().usage;
	const w = u.where;
	const [tab, setTab] = useState<Tab>("repos");
	const tabs: { key: Tab; label: string }[] = [{ key: "repos", label: w.repos }, ...(rich ? [{ key: "models" as const, label: w.models }, { key: "sessions" as const, label: w.sessions }] : [])];
	const share = (b: Breakdown) => (
		<>
			<span className="mx-usage-share" aria-hidden="true">
				<i style={{ width: `${Math.round(b.share * 100)}%` }} />
			</span>
			{percent(u, b.share)}
		</>
	);
	return (
		<section className="mx-card mx-usage-section" aria-labelledby="usage-where-title" data-id="usage-where">
			<div className="mx-usage-section-head">
				<h3 id="usage-where-title">{w.title}</h3>
				{tabs.length > 1 && <Segmented label={w.title} value={tab} options={tabs} onChange={setTab} />}
			</div>
			<div className="mx-usage-scroll" data-scroll-x>
				{tab === "sessions" ? (
					<table className="mx-usage-table mx-usage-wide">
						<thead>
							<tr>
								<th scope="col">{w.name}</th>
								<th scope="col">{w.cost}</th>
								<th scope="col">{w.turns}</th>
								<th scope="col">{w.peak}</th>
								<th scope="col">{w.commits}</th>
							</tr>
						</thead>
						<tbody>
							{sessions.map((s) => (
								<tr key={`${s.provider}/${s.sessionId}`}>
									<th scope="row">
										<SessionLabel machine={machine} sessionId={s.sessionId} names={names} />
										<small className="note">{s.model}</small>
									</th>
									<td>{usd(u, s.costUsd)}</td>
									<td>{count(u, s.mainTurns + s.subagentTurns)}</td>
									<td>{tokens(u, Number(s.peakContext))}</td>
									<td>{s.outcomeKnown ? count(u, s.commits) : u.contextNone}</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<table className="mx-usage-table mx-usage-wide">
						<thead>
							<tr>
								<th scope="col">{tab === "repos" ? w.repos : w.models}</th>
								{rich && <th scope="col">{w.cost}</th>}
								<th scope="col">{w.share}</th>
								<th scope="col">{w.turns}</th>
								<th scope="col">{w.context}</th>
							</tr>
						</thead>
						<tbody>
							{(tab === "repos" ? repos : models).map((b) => (
								<tr key={b.key}>
									<th scope="row">
										{tab === "repos" && all ? (
											<Link to={usagePath(machine, b.key)} title={w.openRepo(b.key)}>
												{b.key}
											</Link>
										) : (
											b.key || u.contextNone
										)}
									</th>
									{rich && <td>{usd(u, b.cost ?? 0)}</td>}
									<td>{share(b)}</td>
									<td>{count(u, b.turns)}</td>
									<td>{tokens(u, b.context)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
			{tab === "sessions" && <p className="note">{w.sessionsNote}</p>}
		</section>
	);
}

/** A session by its title when this device knows it, opening its thread when one holds it. */
export function SessionLabel({ machine, sessionId, names }: { machine: string; sessionId: string; names: ReadonlyMap<string, SessionName> }) {
	const w = useMachinesCopy().usage.where;
	const known = names.get(sessionId);
	const text = known?.title || w.session(sessionId.slice(0, 8));
	if (known === undefined || known.threadId === "") return <span className="mx-usage-session">{text}</span>;
	return (
		<Link to={paths.machineSession(machine, known.threadId)} className="mx-usage-session">
			{text}
		</Link>
	);
}

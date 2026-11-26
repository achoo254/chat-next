// "AI làm ra được gì" of the "Hiệu quả" page (tunelo 3.30.0+): the commits
// made while the last 30 days' costliest sessions ran, the files they
// changed, the cost per commit, the share of sessions without a commit and
// the costly sessions with at most one. Hidden when no session's folder is a
// git repository the machine could read.
import { useMachinesCopy } from "../use-machines-copy.ts";
import { count, percent, usd } from "./usage-format.ts";
import type { Outcomes } from "./usage-insights.ts";
import type { SessionName } from "./usage-session-names.ts";
import { SessionLabel } from "./usage-where.tsx";

export function UsageOutcome({ machine, outcomes, names }: { machine: string; outcomes: Outcomes; names: ReadonlyMap<string, SessionName> }) {
	const u = useMachinesCopy().usage;
	const o = u.outcome;
	return (
		<section className="mx-card mx-usage-section" aria-labelledby="usage-outcome-title" data-id="usage-outcome">
			<h3 id="usage-outcome-title">{o.title}</h3>
			<div className="mx-usage-split">
				<dl className="mx-kv mx-usage-kv">
					<dt>{o.commits}</dt>
					<dd>{count(u, outcomes.commits)}</dd>
					<dt>{o.files}</dt>
					<dd>{count(u, outcomes.filesChanged)}</dd>
					<dt>{o.perCommit}</dt>
					<dd>{outcomes.costPerCommit === null ? u.contextNone : usd(u, outcomes.costPerCommit)}</dd>
					<dt>{o.withoutCommit}</dt>
					<dd>{percent(u, outcomes.withoutCommit)}</dd>
				</dl>
				{outcomes.costly.length > 0 && (
					<div>
						<h4>{o.costly}</h4>
						<ul className="mx-usage-top">
							{outcomes.costly.map((s) => (
								<li key={s.sessionId}>
									<SessionLabel machine={machine} sessionId={s.sessionId} names={names} />
									<small className="note">
										{usd(u, s.costUsd)} · {o.commitsOf(count(u, s.commits))}
									</small>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
			<p className="note">{o.note}</p>
		</section>
	);
}

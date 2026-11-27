// "Thói quen" of the "Hiệu quả" page: one card per rule that fired in the
// last 5 weeks, with how many sessions it fired in over 30 days, its weekly
// trend, what the habit cost (tunelo 3.30.0+), what to do instead and the
// sessions it fired in, each opening its thread when one holds it. Hovering
// the trend line shows each week's count (chart-tip.tsx).
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ChartTip, useChartHover } from "./chart-tip.tsx";
import { count, hintValue, moment, ruleCopy, usd } from "./usage-format.ts";
import type { RuleGroup } from "./usage-insights.ts";
import type { SessionName } from "./usage-session-names.ts";
import { SessionLabel } from "./usage-where.tsx";

export interface HabitsProps {
	readonly machine: string;
	readonly rules: readonly RuleGroup[];
	readonly names: ReadonlyMap<string, SessionName>;
}

export function UsageHabits({ machine, rules, names }: HabitsProps) {
	const u = useMachinesCopy().usage;
	const h = u.habits;
	return (
		<section className="mx-usage-section" aria-labelledby="usage-habits-title" data-id="usage-habits">
			<h3 id="usage-habits-title">{h.title}</h3>
			{rules.length === 0 ? (
				<p className="note mx-card">{h.empty}</p>
			) : (
				<ul className="mx-usage-cards">
					{rules.map((g) => {
						const rule = ruleCopy(u, g.rule);
						const excess = g.excessUsd !== null && g.excessUsd > 0 ? rule.excess(usd(u, g.excessUsd)) : "";
						return (
							<li key={g.rule} className="mx-card mx-usage-rule" data-id="usage-rule">
								<div className="mx-usage-rule-head">
									<b>{rule.name}</b>
									{g.experimental && <span className="mx-tag">{u.experimental}</span>}
									<span className={`mx-tag mx-usage-trend-${g.trend}`}>{h[g.trend]}</span>
								</div>
								<div className="mx-usage-rule-stats">
									<div>
										<span className="mx-usage-big">{count(u, g.count)}</span>
										<small className="note">{h.count(count(u, g.count))}</small>
									</div>
									<Spark weekly={g.weekly} label={h.weeks} tip={(ago, n) => h.week(ago, count(u, n))} />
								</div>
								{excess !== "" && <p className="mx-usage-excess">{excess}</p>}
								{rule.fix !== "" && (
									<p>
										<span className="note">{h.fix}</span> {rule.fix}
									</p>
								)}
								{g.top.length > 0 && (
									<ul className="mx-usage-top">
										{g.top.map((s) => (
											<li key={s.sessionId}>
												<SessionLabel machine={machine} sessionId={s.sessionId} names={names} />
												<small className="note">
													{rule.hint(hintValue(u, s))} · {moment(u, Number(s.at))}
													{Number(s.notifiedAt) > 0 ? ` · ${h.notified}` : ""}
												</small>
											</li>
										))}
									</ul>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

function Spark({ weekly, label, tip }: { weekly: readonly number[]; label: string; tip: (weeksAgo: number, n: number) => string }) {
	const max = Math.max(...weekly, 1);
	const w = 100;
	const h = 28;
	const last = Math.max(1, weekly.length - 1);
	const at = (i: number) => ({ x: (i / last) * w, y: h - 3 - ((weekly[i] ?? 0) / max) * (h - 6) });
	const points = weekly.map((_, i) => `${at(i).x},${at(i).y}`).join(" ");
	const hover = useChartHover(weekly.length, (f) => (weekly.length === 0 ? null : Math.min(weekly.length - 1, Math.max(0, Math.round(f * last)))));
	const hi = hover.index;
	return (
		<figure className="mx-usage-spark">
			<div className="mx-usage-plot">
				<svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${weekly.join(", ")}`} {...hover.svgProps}>
					<polyline points={points} />
					{hi !== null && <line className="mx-usage-spark-cursor" x1={at(hi).x} x2={at(hi).x} y1={0} y2={h} />}
				</svg>
				{hi !== null && <i className="mx-usage-spark-dot" aria-hidden="true" style={{ left: `${(hi / last) * 100}%`, top: `${(at(hi).y / h) * 100}%` }} />}
				{hi !== null && <ChartTip fraction={hi / last}>{tip(weekly.length - 1 - hi, weekly[hi] ?? 0)}</ChartTip>}
			</div>
			<figcaption className="note">{label}</figcaption>
		</figure>
	);
}

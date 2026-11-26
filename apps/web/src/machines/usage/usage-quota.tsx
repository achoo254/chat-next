// "Hạn mức" of the "Hiệu quả" page: every AI account of the machine whose
// plan usage is known (the list the "Tài khoản AI" page shows), its 5-hour
// and 7-day windows with when they reset, and, from the machine's own
// readings in the usage report, when the 5-hour window fills at the pace of
// the last 3 hours if that comes before it resets.
import type { AiAccount, ProviderInfo, UsageQuotaPoint } from "@achoo254/chat-proto/remote/remote";
import { PercentBar } from "../percent-bar.tsx";
import { usageOf } from "../status-line.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { fillsAt } from "./usage-insights.ts";
import { moment } from "./usage-format.ts";

export interface QuotaProps {
	/** Accounts of every AI on the machine; null while unknown. */
	readonly accounts: readonly AiAccount[] | null;
	readonly providers: readonly ProviderInfo[];
	readonly points: readonly UsageQuotaPoint[];
	readonly now: number;
}

const warnAt = 80;

export function QuotaBlock({ accounts, providers, points, now }: QuotaProps) {
	const u = useMachinesCopy().usage;
	const q = u.quota;
	const known = (accounts ?? []).filter((a) => a.usage?.fiveHour !== undefined || a.usage?.sevenDay !== undefined);
	const aiName = (id: string) => providers.find((p) => p.id === id)?.name || id;
	const time = (ms: number) => new Intl.DateTimeFormat(u.locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
	return (
		<section className="mx-card mx-usage-section" aria-labelledby="usage-quota-title" data-id="usage-quota">
			<h3 id="usage-quota-title">{q.title}</h3>
			{known.length === 0 ? (
				<p className="note">{q.none}</p>
			) : (
				<div className="mx-usage-quota">
					{known.map((a) => {
						const five = usageOf(a.usage?.fiveHour, now);
						const week = usageOf(a.usage?.sevenDay, now);
						const fills = five === null ? null : fillsAt(points, five.resetsAt, now);
						const updated = Number(a.usageUpdatedAt);
						return (
							<div key={`${a.provider}/${a.id}`} className="mx-usage-account" data-id="usage-quota-account">
								<div className="mx-usage-account-head">
									<b>{q.account(aiName(a.provider), a.email || a.label || q.ownSignIn)}</b>
									{updated > 0 && <small className="note">{q.updated(moment(u, updated))}</small>}
								</div>
								{five !== null && <Window label={q.fiveHour} pct={five.pct} resets={five.resetsAt > 0 ? q.resets(time(five.resetsAt)) : ""} />}
								{week !== null && <Window label={q.sevenDay} pct={week.pct} resets={week.resetsAt > 0 ? q.resets(time(week.resetsAt)) : ""} />}
								{fills !== null && (
									<p className="mx-warn" role="note" data-id="usage-quota-fills">
										{q.fillsAt(time(fills))}
									</p>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

function Window({ label, pct, resets }: { label: string; pct: number; resets: string }) {
	return (
		<div className={pct >= warnAt ? "mx-usage-window warn" : "mx-usage-window"}>
			<span>{label}</span>
			<PercentBar pct={pct} />
			<span className="mx-usage-num">
				<b>{pct}%</b>
				{resets !== "" && ` · ${resets}`}
			</span>
		</div>
	);
}

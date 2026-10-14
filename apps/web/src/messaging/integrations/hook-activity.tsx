// What a webhook received (mockups/integrations.html#hook-stats): the
// aggregated counters of a period with the failures by reason, and the
// failed requests kept for 30 days (dead letters) with their bodies.
// There is no per-member delivery state, by design.
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { Choice } from "../ui/parts.tsx";
import type { HookDeadLetter, HookStats } from "./api.ts";
import type { HooksCopy } from "./copy-vi.ts";
import { usePaged, useNow, whenText } from "./hook-parts.tsx";
import { useHooksCopy } from "./use-hooks-copy.ts";

type Period = "day" | "week" | "month";
const PERIOD_HOURS: Record<Period, number> = { day: 24, week: 168, month: 720 };
const DEAD_PAGE = 20;

export function failureLabel(reason: string, t: HooksCopy): string {
	return t.failures[reason] ?? reason;
}

function formatCount(n: number, locale: string): string {
	return new Intl.NumberFormat(locale).format(n);
}

export function StatsCard({ hookId }: { hookId: string }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { locale } = useI18n();
	const { integrations } = useServices();
	const [period, setPeriod] = useState<Period>("day");
	const [state, setState] = useState<{ key: string; stats: HookStats | null; failed: boolean }>({ key: "", stats: null, failed: false });
	const [attempt, setAttempt] = useState(0);
	const now = useNow(false);
	const key = `${period}#${attempt}`;
	const current = state.key === key ? state : { key, stats: null, failed: false };
	const id = `stats-${hookId}`;

	useEffect(() => {
		let active = true;
		integrations.stats(hookId, PERIOD_HOURS[period]).then(
			(stats) => {
				if (active) setState({ key, stats, failed: false });
			},
			() => {
				if (active) setState({ key, stats: null, failed: true });
			},
		);
		return () => {
			active = false;
		};
	}, [integrations, hookId, period, key]);

	const stats = current.stats;
	let body: ReactNode;
	if (current.failed) {
		body = (
			<p className="status bad">
				{copy.common.loadFailed}{" "}
				<button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
					{copy.common.retry}
				</button>
			</p>
		);
	} else if (stats === null) {
		body = <p className="status">{copy.common.loading}</p>;
	} else {
		body = (
			<>
				<div className="tiles">
					<div className="stat">
						<span>{t.detail.accepted}</span>
						<b>{formatCount(stats.accepted, locale)}</b>
						<span>{t.detail.acceptedSub}</span>
					</div>
					<div className="stat">
						<span>{t.detail.delivered}</span>
						<b>{formatCount(stats.deliveredRealtime, locale)}</b>
						<span>{t.detail.deliveredSub}</span>
					</div>
					<div className={stats.failed > 0 ? "stat bad" : "stat"}>
						<span>{t.detail.failed}</span>
						<b>{formatCount(stats.failed, locale)}</b>
						<span>{t.detail.failedSub}</span>
					</div>
				</div>
				{stats.failures.length === 0 ? (
					<p className="note">{t.detail.noFailures}</p>
				) : (
					<table className="data hook-table compact">
						<thead>
							<tr>
								<th scope="col">{t.detail.failureColumns.reason}</th>
								<th scope="col" className="num">
									{t.detail.failureColumns.count}
								</th>
								<th scope="col">{t.detail.failureColumns.last}</th>
							</tr>
						</thead>
						<tbody>
							{stats.failures.map((failure) => (
								<tr key={failure.reason}>
									<td data-label={t.detail.failureColumns.reason}>{failureLabel(failure.reason, t)}</td>
									<td data-label={t.detail.failureColumns.count} className="num">
										{formatCount(failure.count, locale)}
									</td>
									<td data-label={t.detail.failureColumns.last}>{failure.lastAt === 0 ? "" : whenText(failure.lastAt, now, locale, copy)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</>
		);
	}
	return (
		<section className="card" aria-labelledby={id}>
			<div className="card-head">
				<h3 id={id}>{t.detail.statsTitle}</h3>
				<Choice
					label={t.detail.window}
					value={period}
					onChange={setPeriod}
					options={[
						{ value: "day", label: t.detail.windows.day },
						{ value: "week", label: t.detail.windows.week },
						{ value: "month", label: t.detail.windows.month },
					]}
				/>
			</div>
			{body}
			<p className="note with-icon">
				<Icon name="info" small />
				<span>{t.detail.noPerMember}</span>
			</p>
		</section>
	);
}

function DeadLetter({ letter, now }: { letter: HookDeadLetter; now: number }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { locale } = useI18n();
	return (
		<li>
			<details>
				<summary>
					<Icon name="chevron-right" small />
					<span className="dl-reason">{failureLabel(letter.reason, t)}</span>
					<span className="dl-meta">
						{t.detail.deadStatus(letter.httpStatus)} · {whenText(letter.date, now, locale, copy)}
					</span>
				</summary>
				<div className="dl-body">
					{letter.detail !== "" && <p>{letter.detail}</p>}
					<p className="dl-meta">{t.detail.deadContentType(letter.contentType)}</p>
					<pre className="snippet" aria-label={t.detail.deadBody}>
						{letter.body === "" ? t.detail.deadEmptyBody : letter.body}
					</pre>
					{letter.bodyTruncated && <p className="dl-meta">{t.detail.deadTruncated}</p>}
				</div>
			</details>
		</li>
	);
}

export function DeadLettersCard({ hookId }: { hookId: string }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { integrations } = useServices();
	const now = useNow(false);
	const id = `dead-${hookId}`;
	const page = usePaged<HookDeadLetter>(hookId, DEAD_PAGE, (beforeId) => integrations.deadLetters(hookId, beforeId, DEAD_PAGE), (letter) => letter.id);
	let body: ReactNode;
	if (page.status === "loading") body = <p className="status">{copy.common.loading}</p>;
	else if (page.status === "error") {
		body = (
			<p className="status bad">
				{copy.common.loadFailed}{" "}
				<button type="button" className="btn btn-sm" onClick={page.reload}>
					{copy.common.retry}
				</button>
			</p>
		);
	} else if (page.items.length === 0) body = <p className="note">{t.detail.deadEmpty}</p>;
	else {
		body = (
			<ul className="dead-list">
				{page.items.map((letter) => (
					<DeadLetter key={letter.id} letter={letter} now={now} />
				))}
			</ul>
		);
	}
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{t.detail.deadTitle}</h3>
			<p>{t.detail.deadNote}</p>
			{body}
			{page.more && (
				<button type="button" className="see-all" onClick={page.loadMore}>
					{t.detail.more}
				</button>
			)}
		</section>
	);
}

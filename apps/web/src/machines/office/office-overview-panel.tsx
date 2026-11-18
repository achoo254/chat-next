// The panel beside the office scene, open from the start: the office's own
// news instead of boards hung over the picture. Who is at work and on what
// (a press on a line opens that person's inspector), how many rest and how,
// then the session's counts: to-do with a progress bar, checks, tokens and
// cost ("no numbers yet" rather than zeros; tokens only when the AI reports no
// cost), the session's time. Only counts: the agent never sends todo text or
// tool output. A column on a wide screen; on a phone one folded line under the
// scene (its headline) that opens to the same content, so the scene keeps the
// screen. When a person is opened, their inspector panel takes the column.
import { useId, type CSSProperties, type ReactNode } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import type { OfficeCopy } from "./office-names.ts";
import type { OfficeOverview, OverviewWorker } from "./office-overview.ts";
import type { OfficeState } from "./office-store.ts";

type ColorStyle = CSSProperties & { "--of-color": string };

/** How long the session has run, h:mm: machine time on the viewer's clock. */
function sessionLength(state: OfficeState, now: number): string {
	const started = state.session.startedAt;
	if (started <= 0) return "–";
	const minutes = Math.max(0, Math.floor((now - (started + state.clockOffset)) / 60_000));
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | "bad" | undefined }) {
	return (
		<div className="of-stat" data-tone={tone}>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

function Section({ title, count, id, children }: { title: string; count?: number | undefined; id: string; children: ReactNode }) {
	const heading = useId();
	return (
		<section className="of-ov-section" data-id={`office-overview-${id}`} aria-labelledby={heading}>
			<h4 id={heading}>
				{title}
				{count !== undefined && <span className="of-ov-count">{count}</span>}
			</h4>
			{children}
		</section>
	);
}

function Worker({ w, t, onSelect }: { w: OverviewWorker; t: OfficeCopy; onSelect: (key: string) => void }) {
	const style: ColorStyle = { "--of-color": w.color };
	return (
		<li>
			<button type="button" className="of-ov-worker" data-status={w.status} data-key={w.key} style={style} onClick={() => onSelect(w.key)}>
				<span className="of-dot" aria-hidden="true" />
				<span className="of-ov-worker-text">
					<span className="of-ov-worker-name">
						{w.name}
						{w.state !== "" && <span className="of-ov-worker-state"> · {w.state}</span>}
					</span>
					<span className="of-ov-worker-doing">
						{w.doing === "" ? t.inspector.working : w.doing}
						<span className="of-panel-muted"> · {t.rooms[w.room]}</span>
					</span>
				</span>
			</button>
		</li>
	);
}

function Progress({ state, t, count }: { state: OfficeState; t: OfficeCopy; count: Intl.NumberFormat }) {
	const { pending, inProgress, done } = state.session.todo;
	const total = pending + inProgress + done;
	if (total === 0) return <p className="of-note">{t.summary.progressNone}</p>;
	const share = (n: number): CSSProperties => ({ flexGrow: n });
	return (
		<>
			<div className="of-ov-progress" role="progressbar" aria-label={t.summary.progress} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={t.summary.progressOf(done, total)}>
				{done > 0 && <span data-part="done" style={share(done)} />}
				{inProgress > 0 && <span data-part="doing" style={share(inProgress)} />}
				{pending > 0 && <span data-part="pending" style={share(pending)} />}
			</div>
			<dl className="of-ov-stats">
				<Stat label={t.board.todoDone} value={count.format(done)} tone="good" />
				<Stat label={t.board.todoInProgress} value={count.format(inProgress)} />
				<Stat label={t.board.todoPending} value={count.format(pending)} />
			</dl>
		</>
	);
}

function Numbers({ state, t, locale, count }: { state: OfficeState; t: OfficeCopy; locale: string; count: Intl.NumberFormat }) {
	const s = state.session;
	const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
	return (
		<>
			{s.checks.passed + s.checks.failed > 0 && (
				<Section title={t.board.qa} id="checks">
					<dl className="of-ov-stats">
						<Stat label={t.board.passed} value={count.format(s.checks.passed)} tone="good" />
						<Stat label={t.board.failed} value={count.format(s.checks.failed)} tone={s.checks.failed > 0 ? "bad" : undefined} />
					</dl>
				</Section>
			)}
			<Section title={t.board.audit} id="cost">
				{!s.usage.available ? (
					<p className="of-note">{t.board.noData}</p>
				) : (
					<dl className="of-ov-stats">
						<Stat label={t.board.tokensIn} value={compact.format(s.usage.inputTokens)} />
						<Stat label={t.board.tokensOut} value={compact.format(s.usage.outputTokens)} />
						{s.usage.hasCost && <Stat label={t.board.cost} value={new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(s.usage.costUsd)} />}
					</dl>
				)}
			</Section>
		</>
	);
}

/** `compact`: a phone, the panel folded to its headline under the scene. */
export function OverviewPanel({ overview, state, now, compact, onSelect }: { overview: OfficeOverview; state: OfficeState; now: number; compact: boolean; onSelect: (key: string) => void }) {
	const copy = useMachinesCopy();
	const t = copy.office;
	const locale = copy.usage.locale;
	const count = new Intl.NumberFormat(locale);
	const headline = t.summary.headline(overview.working.length, overview.restingCount);
	const background = state.session.backgroundMachines;
	const body = (
		<>
			<Section title={t.summary.working} count={overview.working.length} id="working">
				{overview.working.length === 0 ? (
					<p className="of-note">{t.summary.workingNone}</p>
				) : (
					<ul className="of-ov-workers">
						{overview.working.map((w) => (
							<Worker key={w.key} w={w} t={t} onSelect={onSelect} />
						))}
					</ul>
				)}
				{(overview.atSeat > 0 || background > 0) && (
					<p className="of-note of-ov-extra">{[overview.atSeat > 0 ? t.summary.atSeat(overview.atSeat) : "", background > 0 ? t.summary.background(background) : ""].filter((x) => x !== "").join(" · ")}</p>
				)}
			</Section>
			<Section title={t.summary.resting} count={overview.restingCount} id="resting">
				{overview.resting.length === 0 ? (
					<p className="of-note">{t.summary.restingNone}</p>
				) : (
					<ul className="of-ov-rest">
						{overview.resting.map((r) => (
							<li key={r.act} data-act={r.act}>
								<span>{t.life[r.act]}</span>
								<b>{count.format(r.count)}</b>
							</li>
						))}
					</ul>
				)}
			</Section>
			<Section title={t.summary.progress} id="progress">
				<Progress state={state} t={t} count={count} />
			</Section>
			<Numbers state={state} t={t} locale={locale} count={count} />
			<dl className="of-ov-foot">
				<Stat label={t.board.sessionTime} value={sessionLength(state, now)} />
				<Stat label={t.board.tasksDone} value={count.format(state.session.tasksDone)} />
			</dl>
		</>
	);
	if (compact) {
		return (
			<details className="of-panel of-overview" data-id="office-overview" aria-label={t.summary.label}>
				<summary>
					<span className="of-ov-title">{t.summary.title}</span>
					<span className="of-panel-muted">{headline}</span>
				</summary>
				{body}
			</details>
		);
	}
	return (
		<aside className="of-panel of-overview" aria-label={t.summary.label} data-id="office-overview">
			<header className="of-ov-head">
				<h3>{t.summary.title}</h3>
				<p className="of-panel-muted">{headline}</p>
			</header>
			{body}
		</aside>
	);
}

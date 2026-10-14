// Minimal moderation for R1 (mockups/moderation.html#queue, #report-detail,
// #actions): the tenant's report queue, a report with its context, and the
// actions with a required reason. Bot verification and the audit log come
// with later releases.
import { useEffect, useEffectEvent, useState, type FormEvent } from "react";
import { Icon, type IconName } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { clock, listTime, toneOf } from "../data/format.ts";
import type {
	LockDuration,
	ModerationAction,
	ModerationDetail,
	ModerationObject,
	ModerationRow,
	ModerationStatus,
} from "../data/pending-backend.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, Choice, DialogHead, Modal, useDomId } from "../ui/parts.tsx";

const OBJECT_ICONS: Record<ModerationObject, IconName> = {
	message: "message",
	user: "user",
	bot: "robot",
	channel: "megaphone",
	webhook: "webhook",
};

type Loaded<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

function useLoad<T>(load: () => Promise<T>, key: string): [Loaded<T>, () => void] {
	const [state, setState] = useState<Loaded<T> & { key: string }>({ status: "loading", key });
	const [attempt, setAttempt] = useState(0);
	// `load` is recreated per render; `key` identifies what it loads.
	const run = useEffectEvent(load);
	useEffect(() => {
		let active = true;
		run().then(
			(value) => {
				if (active) setState({ status: "ready", value, key });
			},
			() => {
				if (active) setState({ status: "error", key });
			},
		);
		return () => {
			active = false;
		};
	}, [key, attempt]);
	return [state.key === key ? state : { status: "loading" }, () => setAttempt((n) => n + 1)];
}

export default function Moderation({ reportId, actions }: { reportId: string | null; actions: boolean }) {
	const copy = useScreensCopy();
	const { backend, self } = useServices();
	const [scope] = useLoad(() => backend.moderationScope(), "scope");
	const scopeValue = scope.status === "ready" ? scope.value : null;
	return (
		<div className="mod">
			<nav className="mod-side" aria-label={copy.moderation.title}>
				<div className="mod-brand">
					<Icon name="shield" />
					<span>{copy.moderation.title}</span>
				</div>
				<Link to={paths.moderation()} className="nav" current>
					<Icon name="inbox" />
					<span>{copy.moderation.queue}</span>
				</Link>
				<div className="me">
					<ChatAvatar id={self.id} name={self.name} size="sm" />
					<span>
						{self.name}
						{scopeValue !== null && <small>{copy.moderation.scopeNote(scopeValue)}</small>}
					</span>
				</div>
			</nav>
			<div className="mod-main">
				{scope.status === "loading" ? (
					<p className="status pad">
						<span className="spin" aria-hidden="true" />
						{copy.common.loading}
					</p>
				) : scopeValue === null ? (
					<div className="empty">
						<Icon name="shield" />
						<strong>{copy.moderation.noAccess}</strong>
					</div>
				) : reportId === null ? (
					<Queue scope={scopeValue} />
				) : actions ? (
					<Actions reportId={reportId} />
				) : (
					<Detail reportId={reportId} />
				)}
			</div>
		</div>
	);
}

function Pill({ row }: { row: ModerationRow }) {
	const copy = useScreensCopy();
	if (row.status === "handled") return <span className="pill done">{copy.moderation.pills.done}</span>;
	if (row.status === "skipped") return <span className="pill skip">{copy.moderation.pills.skip}</span>;
	if (row.reviewer !== "") return <span className="pill review">{copy.moderation.reviewing(row.reviewer)}</span>;
	return <span className="pill new">{copy.moderation.pills.new}</span>;
}

type StatusFilter = ModerationStatus | "all";
type TypeFilter = ModerationObject | "all";

function Queue({ scope }: { scope: string }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { backend } = useServices();
	const [rows, retry] = useLoad(() => backend.moderationQueue(), "queue");
	const [status, setStatus] = useState<StatusFilter>("open");
	const [type, setType] = useState<TypeFilter>("all");
	const [query, setQuery] = useState("");
	const t = copy.moderation;
	const all = rows.status === "ready" ? rows.value : [];
	const needle = query.trim().toLowerCase();
	const shown = all.filter(
		(row) =>
			(status === "all" || row.status === status) &&
			(type === "all" || row.object === type) &&
			(needle === "" || row.id.toLowerCase().includes(needle) || `${row.title} ${row.subtitle}`.toLowerCase().includes(needle)),
	);
	const openCount = all.filter((row) => row.status === "open").length;
	const tabs: { value: StatusFilter; label: string }[] = [
		{ value: "open", label: t.open },
		{ value: "handled", label: t.handled },
		{ value: "skipped", label: t.skipped },
		{ value: "all", label: t.all },
	];
	const columns = [t.object, t.kind, t.mainReason, t.reports, t.status, t.latest];
	return (
		<>
			<header className="mod-head">
				<h1>{t.queue}</h1>
				<span className="scope-lock">
					<Icon name="lock" small />
					{t.scopeNote(scope)}
				</span>
			</header>
			<div className="mod-body">
				<div className="toolbar">
					<div className="tabs" role="tablist" aria-label={t.status}>
						{tabs.map((tab) => (
							<button key={tab.value} type="button" role="tab" aria-selected={status === tab.value} onClick={() => setStatus(tab.value)}>
								{tab.label}
								{tab.value === "open" && openCount > 0 && <span className="count">{openCount}</span>}
							</button>
						))}
					</div>
					<div className="filters">
						<Choice<TypeFilter>
							label={t.typeFilter}
							value={type}
							onChange={setType}
							options={[
								{ value: "all", label: t.all },
								...(Object.keys(OBJECT_ICONS) as ModerationObject[]).map((value) => ({ value, label: t.types[value] ?? value })),
							]}
						/>
						<label className="search-field compact">
							<Icon name="search" small />
							<span className="sr-only">{t.search}</span>
							<input type="search" placeholder={t.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />
						</label>
					</div>
				</div>
				{rows.status === "error" ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button type="button" className="btn btn-sm" onClick={retry}>
							{copy.common.retry}
						</button>
					</div>
				) : (
					<div className="table-wrap">
						<table className="data queue">
							<thead>
								<tr>
									{columns.map((column, index) => (
										<th key={column} scope="col" className={index === 3 ? "num" : undefined}>
											{column}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{shown.map((row) => (
									<tr key={row.id}>
										<td>
											<Link to={paths.moderation(row.id)} className="obj">
												<b>{row.title}</b>
												<span>{row.subtitle}</span>
											</Link>
										</td>
										<td data-label={columns[1]}>
											<span className="kind">
												<Icon name={OBJECT_ICONS[row.object]} small />
												{t.types[row.object]}
											</span>
										</td>
										<td data-label={columns[2]}>{copy.report[row.reason]}</td>
										<td data-label={columns[3]} className="num">
											{row.reports >= 10 ? (
												<span className="hot">
													<Icon name="alert-triangle" small />
													{row.reports}
												</span>
											) : (
												row.reports
											)}
										</td>
										<td data-label={columns[4]}>
											<Pill row={row} />
										</td>
										<td data-label={columns[5]} className="mono">
											{listTime(row.latestAt, new Date(), locale, copy)}
										</td>
									</tr>
								))}
								{rows.status === "ready" && shown.length === 0 && (
									<tr className="no-rows">
										<td colSpan={6}>
											<div className="empty">
												<Icon name="inbox" />
												<strong>{t.noRows}</strong>
												<span>{t.noRowsHint}</span>
											</div>
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</>
	);
}

function Detail({ reportId }: { reportId: string }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { backend, toasts } = useServices();
	const [detail] = useLoad(() => backend.moderationDetail(reportId), `detail:${reportId}`);
	const t = copy.moderation;
	if (detail.status === "loading") return <p className="status pad">{copy.common.loading}</p>;
	if (detail.status === "error" || detail.value === null) {
		return (
			<div className="empty">
				<strong>{t.notFound}</strong>
				<Link to={paths.moderation()} className="link">
					{t.backToQueue}
				</Link>
			</div>
		);
	}
	const value: ModerationDetail = detail.value;
	const total = value.reasons.reduce((sum, r) => sum + r.count, 0);
	return (
		<>
			<header className="mod-head">
				<Link to={paths.moderation()} className="icon-btn" aria-label={t.backToQueue}>
					<Icon name="back" />
				</Link>
				<h1>
					{value.row.object === "message" ? t.detailTitle : t.detailTitleObject(t.types[value.row.object] ?? "")}{" "}
					<span className="mono muted id">{value.row.id}</span>
				</h1>
				<Pill row={value.row} />
				<button
					type="button"
					className="btn btn-sm hide-narrow"
					onClick={() => backend.claimReport(reportId).then(() => toasts.show(t.claimed), () => toasts.show(copy.common.failed))}
				>
					{t.claim}
				</button>
				<Link to={paths.moderation(reportId, true)} className="btn btn-sm btn-primary">
					{t.actions}
				</Link>
			</header>
			<div className="mod-body detail">
				<div className="col">
					<div className="card">
						<h2 className="card-title">{t.context}</h2>
						<div className="thread">
							{value.context.map((message) => (
								<div className="msg" key={message.seq}>
									<ChatAvatar id={message.seq} name={message.fromName} size="sm" />
									<div className={message.reported ? "bubble reported" : "bubble"}>
										{message.reported && (
											<span className="flag-label">
												<Icon name="flag" small />
												{t.reported}
											</span>
										)}
										<span className={`who s-${toneOf(message.seq)}`}>{message.fromName}</span>
										<p>
											{message.text}
											<span className="stamp">{clock(message.date, locale)}</span>
										</p>
									</div>
								</div>
							))}
						</div>
						<p className="note pad-x pad-b">
							<Icon name="eye-off" small /> {t.contextNote}
						</p>
					</div>
					<div className="card pad">
						<h2 className="card-title flush">{t.reporters(total, value.notes.length)}</h2>
						<div className="reasons">
							{value.reasons.map((reason) => (
								<FragmentRow key={reason.reason} label={copy.report[reason.reason]} count={reason.count} total={total} />
							))}
						</div>
						{value.notes.length > 0 && (
							<ul className="notes">
								{value.notes.map((note, index) => (
									<li key={index}>“{note}”</li>
								))}
							</ul>
						)}
					</div>
				</div>
				<aside className="col">
					<div className="card">
						<h2 className="card-title">{t.history}</h2>
						{value.history.length === 0 ? (
							<p className="note pad-x pad-b">{t.noHistory}</p>
						) : (
							<ol className="timeline pad-x pad-b">
								{value.history.map((entry, index) => (
									<li key={index}>
										<b>{entry.action}</b>
										<span>
											{entry.by} · {listTime(entry.at, new Date(), locale, copy)}
										</span>
										{entry.note !== "" && <small>{entry.note}</small>}
									</li>
								))}
							</ol>
						)}
					</div>
				</aside>
			</div>
		</>
	);
}

function FragmentRow({ label, count, total }: { label: string; count: number; total: number }) {
	const percent = total === 0 ? 0 : Math.round((count / total) * 100);
	return (
		<>
			<span>{label}</span>
			<progress className="meter" max={100} value={percent} aria-label={label} />
			<b>{count}</b>
		</>
	);
}

const DURATIONS: readonly LockDuration[] = ["day", "week", "month", "forever"];

function Actions({ reportId }: { reportId: string }) {
	const copy = useScreensCopy();
	const { backend, toasts } = useServices();
	const [detail] = useLoad(() => backend.moderationDetail(reportId), `detail:${reportId}`);
	const [chosen, setChosen] = useState<ReadonlySet<ModerationAction>>(new Set<ModerationAction>(["remove"]));
	const [lock, setLock] = useState<LockDuration>("week");
	const [confirming, setConfirming] = useState(false);
	const t = copy.moderation;
	if (detail.status !== "ready" || detail.value === null) {
		return <p className="status pad">{detail.status === "loading" ? copy.common.loading : t.notFound}</p>;
	}
	const row = detail.value.row;
	const toggle = (action: ModerationAction) =>
		setChosen((current) => {
			const next = new Set(current);
			if (next.has(action)) next.delete(action);
			else next.add(action);
			return next;
		});
	const options: { action: ModerationAction; label: string; hint: string; disabled: boolean }[] = [
		{ action: "remove", label: t.remove, hint: t.removeHint, disabled: row.object !== "message" },
		{ action: "lock", label: t.lock, hint: t.lockHint, disabled: row.object === "webhook" },
		{ action: "warn", label: t.warn, hint: t.warnHint, disabled: row.object === "webhook" },
		{ action: "disable_webhook", label: t.disableHook, hint: t.disableHookHint, disabled: row.object !== "webhook" },
	];
	const skip = () =>
		backend.decideReport(reportId, "skip").then(
			() => {
				toasts.show(t.skippedDone);
				navigate(paths.moderation());
			},
			() => toasts.show(copy.common.failed),
		);
	return (
		<>
			<header className="mod-head">
				<Link to={paths.moderation(reportId)} className="icon-btn" aria-label={t.backToDetail}>
					<Icon name="back" />
				</Link>
				<h1>
					{t.actions} <span className="mono muted id">{row.id}</span>
				</h1>
			</header>
			<div className="mod-body narrow-body">
				<div className="card target pad">
					<ChatAvatar id={row.title.length} name={row.title} />
					<div className="grow">
						<b>{row.title}</b>
						<span className="muted">{row.subtitle}</span>
					</div>
				</div>
				<fieldset className="card acts">
					<legend className="sr-only">{t.actions}</legend>
					{options.map((option) => (
						<div className={option.disabled ? "act is-disabled" : "act"} key={option.action}>
							<label className="opt check">
								<input
									type="checkbox"
									checked={chosen.has(option.action) && !option.disabled}
									disabled={option.disabled}
									onChange={() => toggle(option.action)}
								/>
								<span>
									{option.label}
									<small>{option.hint}</small>
								</span>
							</label>
							{option.action === "lock" && chosen.has("lock") && !option.disabled && (
								<div className="act-extra">
									<Choice<LockDuration>
										label={t.lockDuration}
										value={lock}
										onChange={setLock}
										options={DURATIONS.map((value) => ({ value, label: t.durations[value] ?? value }))}
									/>
									<p className="note">
										<Icon name="info" small /> {t.lockNote}
									</p>
								</div>
							)}
						</div>
					))}
				</fieldset>
				<div className="save-bar">
					<button type="button" className="btn" onClick={() => void skip()}>
						{t.skip}
					</button>
					<button
						type="button"
						className="btn btn-primary"
						disabled={![...chosen].some((action) => !options.find((o) => o.action === action)?.disabled)}
						onClick={() => setConfirming(true)}
					>
						{t.next}
					</button>
				</div>
			</div>
			{confirming && (
				<ConfirmActions
					reportId={reportId}
					target={row.title}
					actions={[...chosen].filter((action) => !options.find((o) => o.action === action)?.disabled)}
					lock={lock}
					onClose={() => setConfirming(false)}
				/>
			)}
		</>
	);
}

interface ConfirmProps {
	reportId: string;
	target: string;
	actions: readonly ModerationAction[];
	lock: LockDuration;
	onClose: () => void;
}

function ConfirmActions({ reportId, target, actions, lock, onClose }: ConfirmProps) {
	const copy = useScreensCopy();
	const { backend, toasts } = useServices();
	const [reason, setReason] = useState("");
	const [notify, setNotify] = useState(true);
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("confirm");
	const t = copy.moderation;
	const summary: Record<ModerationAction, { icon: IconName; text: string }> = {
		remove: { icon: "trash", text: t.summaryRemove(target) },
		lock: { icon: "ban", text: t.summaryLock(target, t.durations[lock] ?? lock) },
		warn: { icon: "alert-triangle", text: t.summaryWarn(target) },
		disable_webhook: { icon: "webhook", text: t.summaryHook(target) },
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (reason.trim() === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		backend.decideReport(reportId, { actions, lock, reason: reason.trim(), notify }).then(
			() => {
				toasts.show(t.doneActions);
				onClose();
				navigate(paths.moderation());
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<form onSubmit={submit}>
				<DialogHead id={id} title={t.confirmTitle} onClose={onClose} />
				<div className="dlg-body flow">
					<ul className="summary">
						{actions.map((action) => (
							<li key={action}>
								<Icon name={summary[action].icon} small />
								{summary[action].text}
							</li>
						))}
					</ul>
					<div className="field">
						<label htmlFor={`${id}-reason`}>
							{t.reasonLabel} <span className="muted">{t.reasonHint}</span>
						</label>
						<textarea
							id={`${id}-reason`}
							className="input"
							rows={2}
							value={reason}
							aria-invalid={invalid}
							aria-describedby={invalid ? `${id}-err` : undefined}
							onChange={(event) => {
								setReason(event.target.value);
								if (event.target.value.trim() !== "") setInvalid(false);
							}}
						/>
						{invalid && (
							<span className="error-text" id={`${id}-err`}>
								{t.reasonRequired}
							</span>
						)}
					</div>
					<label className="opt check">
						<input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
						<span>{t.notify}</span>
					</label>
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className="btn btn-danger" aria-busy={busy} disabled={busy}>
						{t.confirm}
					</button>
				</div>
			</form>
		</Modal>
	);
}

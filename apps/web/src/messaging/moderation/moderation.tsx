// Moderation for operators (GetSelf.is_operator) on ModerationService
// (mockups/moderation.html#queue, #report-detail, #actions): the tenant's
// report queue by status, a report with the messages around it and earlier
// actions on the people involved, and the actions with a required reason:
// remove content, remove and ban from the chat, restrict the chat account,
// or dismiss. Active restrictions can be lifted early. The feedback users
// sent the assistant bot (#feedback) is listed next to the reports: mark it
// handled or answer it through the bot. Everyone else sees "no access"; the
// server refuses them too.
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useEffectEvent, useState, type FormEvent } from "react";
import { useLoader as useDelayedLoader } from "../../components/delayed-loader.tsx";
import { Icon, type IconName } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useScreensCopy, type FullCopy } from "../copy/use-screens-copy.ts";
import { clock, listTime, orgDomain, shortDate, toneOf } from "../data/format.ts";
import type {
	ChatBrief,
	FeedbackItem,
	FeedbackPage,
	FeedbackStatus,
	ModerationAction,
	ModerationReport,
	Person,
	ReportDetail,
	ReportStatus,
	ReportsPage,
	Restriction,
} from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, Choice, DialogHead, Modal, useDomId } from "../ui/parts.tsx";

/** What a report is about, as the queue filters it. */
type ObjectKind = "message" | "user" | "bot" | "group" | "channel";

const OBJECT_ICONS: Record<ObjectKind, IconName> = {
	message: "message",
	user: "user",
	bot: "robot",
	group: "users",
	channel: "megaphone",
};

type LockDuration = "day" | "week" | "month" | "forever";
const LOCK_SECONDS: Record<LockDuration, number> = { day: 86_400, week: 604_800, month: 2_592_000, forever: 0 };
const DURATIONS: readonly LockDuration[] = ["day", "week", "month", "forever"];

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

/** Report ids in the path are decimal; anything else is not a report. */
function parseReportId(value: string): number | null {
	if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : null;
}

function objectKind(report: ModerationReport, people: ReadonlyMap<number, Person>, chats: ReadonlyMap<number, ChatBrief>): ObjectKind {
	if (report.kind === "messages") return "message";
	if (report.kind === "user") return people.get(report.targetUserId)?.isBot === true ? "bot" : "user";
	return chats.get(report.targetChatId)?.channel === true ? "channel" : "group";
}

/** Title and second line of a report's object. */
function describe(report: ModerationReport, people: ReadonlyMap<number, Person>, chats: ReadonlyMap<number, ChatBrief>, copy: FullCopy): { title: string; sub: string } {
	const t = copy.moderation;
	if (report.kind === "user") {
		const person = people.get(report.targetUserId);
		return { title: person?.name ?? copy.message.unknownUser, sub: person === undefined || person.username === "" ? "" : `@${person.username}` };
	}
	const chat = chats.get(report.targetChatId);
	const chatTitle = chat?.title ?? t.unknownChat;
	if (report.kind === "messages") return { title: t.messagesIn(report.seqs.length, chatTitle), sub: report.comment };
	return { title: chatTitle, sub: chat === undefined ? "" : t.memberCount(chat.memberCount, chat.channel) };
}

export default function Moderation({ reportId, actions, feedback = false }: { reportId: string | null; actions: boolean; feedback?: boolean }) {
	const copy = useScreensCopy();
	const { self } = useServices();
	const scope = orgDomain(window.location.host);
	const id = reportId === null ? null : parseReportId(reportId);
	return (
		<div className="mod">
			<nav className="mod-side" aria-label={copy.moderation.title}>
				<div className="mod-brand">
					<Icon name="shield" />
					<span>{copy.moderation.title}</span>
				</div>
				<Link to={paths.moderation()} className="nav" current={!feedback}>
					<Icon name="inbox" />
					<span>{copy.moderation.queue}</span>
				</Link>
				<Link to={paths.feedback()} className="nav" current={feedback}>
					<Icon name="message-dot" />
					<span>{copy.moderation.feedback}</span>
				</Link>
				<div className="me">
					<ChatAvatar id={self.id} name={self.name} size="sm" />
					<span>
						{self.name}
						<small>{copy.moderation.scopeNote(scope)}</small>
					</span>
				</div>
			</nav>
			<div className="mod-main">
				{self.isOperator && (
					<nav className="mod-tabs" aria-label={copy.moderation.title}>
						<Link to={paths.moderation()} current={!feedback}>
							{copy.moderation.queue}
						</Link>
						<Link to={paths.feedback()} current={feedback}>
							{copy.moderation.feedback}
						</Link>
					</nav>
				)}
				{!self.isOperator ? (
					<div className="empty">
						<Icon name="shield" />
						<strong>{copy.moderation.noAccess}</strong>
					</div>
				) : feedback ? (
					<FeedbackQueue />
				) : reportId === null ? (
					<Queue scope={scope} />
				) : id === null ? (
					<NotFound />
				) : actions ? (
					<Actions reportId={id} />
				) : (
					<Detail reportId={id} />
				)}
			</div>
		</div>
	);
}

function NotFound() {
	const copy = useScreensCopy();
	return (
		<div className="empty">
			<strong>{copy.moderation.notFound}</strong>
			<Link to={paths.moderation()} className="link">
				{copy.moderation.backToQueue}
			</Link>
		</div>
	);
}

function Pill({ status }: { status: ReportStatus }) {
	const copy = useScreensCopy();
	const className = status === "open" ? "pill new" : status === "resolved" ? "pill done" : "pill skip";
	return <span className={className}>{copy.moderation.pills[status]}</span>;
}

type TypeFilter = ObjectKind | "all";

function Queue({ scope }: { scope: string }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const [status, setStatus] = useState<ReportStatus>("open");
	const [type, setType] = useState<TypeFilter>("all");
	const [query, setQuery] = useState("");
	const [pages, retry] = useLoad(() => remote.moderationReports(status), `queue:${status}`);
	const [extra, setExtra] = useState<{ status: ReportStatus; pages: readonly ReportsPage[] }>({ status, pages: [] });
	if (extra.status !== status) setExtra({ status, pages: [] });
	const t = copy.moderation;

	const loaded = pages.status === "ready" ? [pages.value, ...extra.pages] : [];
	const people = new Map(loaded.flatMap((page) => [...page.people]));
	const chats = new Map(loaded.flatMap((page) => [...page.chats]));
	const reports = loaded.flatMap((page) => page.reports);
	const cursor = loaded.at(-1)?.nextCursor ?? "";
	const needle = query.trim().toLowerCase().replace(/^@/, "");
	const rows = reports
		.map((report) => ({ report, kind: objectKind(report, people, chats), ...describe(report, people, chats, copy) }))
		.filter(
			(row) =>
				(type === "all" || row.kind === type) &&
				(needle === "" || String(row.report.id).includes(needle) || `${row.title} ${row.sub}`.toLowerCase().includes(needle)),
		);
	const more = () => {
		if (cursor === "") return;
		remote.moderationReports(status, cursor).then(
			(page) => setExtra((current) => (current.status === status ? { status, pages: [...current.pages, page] } : current)),
			() => toasts.show(copy.common.failed),
		);
	};
	const tabs: { value: ReportStatus; label: string }[] = [
		{ value: "open", label: t.open },
		{ value: "resolved", label: t.resolved },
		{ value: "dismissed", label: t.dismissed },
	];
	const columns = [t.object, t.kind, t.mainReason, t.reporter, t.status, t.latest];
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
								{tab.value === "open" && status === "open" && reports.length > 0 && <span className="count">{cursor === "" ? reports.length : `${reports.length}+`}</span>}
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
								...(Object.keys(OBJECT_ICONS) as ObjectKind[]).map((value) => ({ value, label: t.types[value] ?? value })),
							]}
						/>
						<label className="search-field compact">
							<Icon name="search" small />
							<span className="sr-only">{t.search}</span>
							<input type="search" placeholder={t.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />
						</label>
					</div>
				</div>
				{pages.status === "error" ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button type="button" className="btn btn-sm" onClick={retry}>
							{copy.common.retry}
						</button>
					</div>
				) : (
					<div className="table-wrap">
						<table className="data queue" aria-busy={pages.status === "loading"}>
							<thead>
								<tr>
									{columns.map((column) => (
										<th key={column} scope="col">
											{column}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{rows.map(({ report, kind, title, sub }) => (
									<tr key={report.id}>
										<td>
											<Link to={paths.moderation(String(report.id))} className="obj">
												<b>{title}</b>
												{sub !== "" && <span>{sub}</span>}
											</Link>
										</td>
										<td data-label={columns[1]}>
											<span className="kind">
												<Icon name={OBJECT_ICONS[kind]} small />
												{t.types[kind]}
											</span>
										</td>
										<td data-label={columns[2]}>{copy.report[report.reason]}</td>
										<td data-label={columns[3]}>{people.get(report.reporterId)?.name ?? copy.message.unknownUser}</td>
										<td data-label={columns[4]}>
											<Pill status={report.status} />
										</td>
										<td data-label={columns[5]} className="mono">
											{listTime(report.createdAt, new Date(), locale, copy)}
										</td>
									</tr>
								))}
								{pages.status === "ready" && rows.length === 0 && (
									<tr className="no-rows">
										<td colSpan={columns.length}>
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
				{cursor !== "" && (
					<button type="button" className="btn" onClick={more}>
						{t.more}
					</button>
				)}
			</div>
		</>
	);
}

function DetailHead({ report, kind, actions }: { report: ModerationReport; kind: ObjectKind; actions: boolean }) {
	const copy = useScreensCopy();
	const t = copy.moderation;
	return (
		<header className="mod-head">
			<Link to={actions ? paths.moderation(String(report.id)) : paths.moderation()} className="icon-btn" aria-label={actions ? t.backToDetail : t.backToQueue}>
				<Icon name="back" />
			</Link>
			<h1>
				{actions ? t.actions : t.detailTitle(t.types[kind] ?? "")} <span className="mono muted id">#{report.id}</span>
			</h1>
			<Pill status={report.status} />
			{!actions && report.status === "open" && (
				<Link to={paths.moderation(String(report.id), true)} className="btn btn-sm btn-primary">
					{t.actions}
				</Link>
			)}
		</header>
	);
}

function detailKind(detail: ReportDetail): ObjectKind {
	const chats = new Map(detail.chat === null ? [] : [[detail.chat.id, detail.chat] as const]);
	return objectKind(detail.report, detail.people, chats);
}

function Detail({ reportId }: { reportId: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote } = useServices();
	const [detail, reload] = useLoad(() => remote.moderationReport(reportId), `detail:${reportId}`);
	const [lifting, setLifting] = useState<Restriction | null>(null);
	const t = copy.moderation;
	const loader = useDelayedLoader(detail.status === "loading", copy.common.loading);
	if (loader !== null) return loader;
	if (detail.status !== "ready") return <NotFound />;
	const value = detail.value;
	const { report, people } = value;
	const nameOf = (userId: number) => people.get(userId)?.name ?? copy.message.unknownUser;
	const reported = new Set(report.seqs);
	const evidence = new Map(value.evidence.map((message) => [message.seq, message]));
	return (
		<>
			<DetailHead report={report} kind={detailKind(value)} actions={false} />
			<div className="mod-body detail">
				<div className="col">
					{value.context.length > 0 && (
						<div className="card">
							<h2 className="card-title">{t.context}</h2>
							{value.chat !== null && <p className="note pad-x">{t.memberCount(value.chat.memberCount, value.chat.channel)} · {value.chat.title}</p>}
							<div className="thread">
								{value.context.map((message) => {
									const flagged = reported.has(message.seq);
									const filed = evidence.get(message.seq);
									const text = message.text !== "" ? message.text : (filed?.text ?? "");
									return (
										<div className="msg" key={message.seq}>
											<ChatAvatar id={message.fromId} name={nameOf(message.fromId)} size="sm" />
											<div className={flagged ? "bubble reported" : "bubble"}>
												{flagged && (
													<span className="flag-label">
														<Icon name="flag" small />
														{filed?.deleted === true ? t.reportedDeleted : t.reported}
													</span>
												)}
												<span className={`who s-${toneOf(message.fromId)}`}>{nameOf(message.fromId)}</span>
												<p>
													{text === "" ? <i className="muted">{t.removedText}</i> : text}
													<span className="stamp">{clock(message.date, locale)}</span>
												</p>
											</div>
										</div>
									);
								})}
							</div>
							<p className="note pad-x pad-b">
								<Icon name="eye-off" small /> {t.contextNote}
							</p>
						</div>
					)}
					<div className="card pad">
						<h2 className="card-title flush">{t.reportBy(nameOf(report.reporterId), listTime(report.createdAt, new Date(), locale, copy))}</h2>
						<p className="muted">{copy.report[report.reason]}</p>
						{report.comment !== "" && (
							<ul className="notes">
								<li>“{report.comment}”</li>
							</ul>
						)}
						{report.status !== "open" && (
							<div className="resolution">
								<h3 className="card-title flush">{t.resolution}</h3>
								<p>
									{report.actions.map((action) => t.actionNames[action] ?? action).join(", ")}
									<small className="muted"> · {t.resolvedBy(nameOf(report.resolvedBy), listTime(report.resolvedAt, new Date(), locale, copy))}</small>
								</p>
								{report.resolutionNote !== "" && <p className="muted">“{report.resolutionNote}”</p>}
							</div>
						)}
					</div>
				</div>
				<aside className="col">
					{value.restrictions.length > 0 && (
						<div className="card">
							<h2 className="card-title">{t.restrictions}</h2>
							<ul className="plain pad-x pad-b">
								{value.restrictions.map((restriction) => (
									<li className="row" key={restriction.userId}>
										<ChatAvatar id={restriction.userId} name={nameOf(restriction.userId)} size="sm" />
										<span className="grow">
											{nameOf(restriction.userId)}
											<small>{restriction.until === 0 ? t.untilLifted : t.until(shortDate(restriction.until, locale))}</small>
										</span>
										<button type="button" className="btn btn-sm" onClick={() => setLifting(restriction)}>
											{t.lift}
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					<div className="card">
						<h2 className="card-title">{t.history}</h2>
						{value.history.length === 0 ? (
							<p className="note pad-x pad-b">{t.noHistory}</p>
						) : (
							<ol className="timeline pad-x pad-b">
								{value.history.map((entry) => (
									<li key={entry.id}>
										<b>{t.actionNames[entry.action] ?? entry.action}</b>
										<span>
											{nameOf(entry.operatorId)} · {listTime(entry.createdAt, new Date(), locale, copy)}
										</span>
										{entry.note !== "" && <small>{entry.note}</small>}
									</li>
								))}
							</ol>
						)}
					</div>
				</aside>
			</div>
			{lifting !== null && (
				<LiftDialog
					userId={lifting.userId}
					name={nameOf(lifting.userId)}
					onClose={() => setLifting(null)}
					onDone={() => {
						setLifting(null);
						reload();
					}}
				/>
			)}
		</>
	);
}

interface ActionOption {
	readonly action: Exclude<ModerationAction, "dismiss" | "lift_restriction">;
	readonly label: string;
	readonly hint: string;
	readonly disabled: boolean;
}

function Actions({ reportId }: { reportId: number }) {
	const copy = useScreensCopy();
	const { remote } = useServices();
	const [detail] = useLoad(() => remote.moderationReport(reportId), `detail:${reportId}`);
	const [chosen, setChosen] = useState<ReadonlySet<ModerationAction>>(new Set<ModerationAction>(["delete_messages"]));
	const [lock, setLock] = useState<LockDuration>("week");
	const [confirming, setConfirming] = useState<readonly ModerationAction[] | null>(null);
	const t = copy.moderation;
	const loader = useDelayedLoader(detail.status === "loading", copy.common.loading);
	if (loader !== null) return loader;
	if (detail.status !== "ready") return <NotFound />;
	const value = detail.value;
	const report = value.report;
	const messages = report.kind === "messages";
	const options: ActionOption[] = [
		{ action: "delete_messages", label: t.deleteMessages, hint: t.deleteMessagesHint, disabled: !messages },
		{ action: "ban_from_chat", label: t.banFromChat, hint: t.banFromChatHint, disabled: !messages },
		{ action: "restrict_account", label: t.lock, hint: t.lockHint, disabled: report.kind === "chat" },
	];
	const usable = options.filter((option) => !option.disabled && chosen.has(option.action)).map((option) => option.action);
	const toggle = (action: ModerationAction) =>
		setChosen((current) => {
			const next = new Set(current);
			if (next.has(action)) next.delete(action);
			else next.add(action);
			return next;
		});
	const target = describe(report, value.people, new Map(value.chat === null ? [] : [[value.chat.id, value.chat] as const]), copy);
	if (report.status !== "open") {
		return (
			<>
				<DetailHead report={report} kind={detailKind(value)} actions />
				<div className="mod-body">
					<p className="note">{t.closed}</p>
				</div>
			</>
		);
	}
	return (
		<>
			<DetailHead report={report} kind={detailKind(value)} actions />
			<div className="mod-body narrow-body">
				<div className="card target pad">
					<ChatAvatar id={report.targetUserId || report.targetChatId} name={target.title} />
					<div className="grow">
						<b>{target.title}</b>
						{target.sub !== "" && <span className="muted">{target.sub}</span>}
					</div>
				</div>
				<fieldset className="card acts">
					<legend className="sr-only">{t.actions}</legend>
					{options.map((option) => (
						<div className={option.disabled ? "act is-disabled" : "act"} key={option.action}>
							<label className="opt check">
								<input type="checkbox" checked={chosen.has(option.action) && !option.disabled} disabled={option.disabled} onChange={() => toggle(option.action)} />
								<span>
									{option.label}
									<small>{option.disabled ? t.notForKind : option.hint}</small>
								</span>
							</label>
							{option.action === "restrict_account" && chosen.has("restrict_account") && !option.disabled && (
								<div className="act-extra">
									<Choice<LockDuration>
										label={t.lockDuration}
										value={lock}
										onChange={setLock}
										options={DURATIONS.map((duration) => ({ value: duration, label: t.durations[duration] ?? duration }))}
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
					<button type="button" className="btn" onClick={() => setConfirming(["dismiss"])}>
						{t.skip}
					</button>
					<button type="button" className="btn btn-primary" disabled={usable.length === 0} onClick={() => setConfirming(usable)}>
						{t.next}
					</button>
				</div>
			</div>
			{confirming !== null && (
				<ConfirmActions
					report={report}
					target={target.title}
					chatTitle={value.chat?.title ?? t.unknownChat}
					actions={confirming}
					lock={lock}
					onClose={() => setConfirming(null)}
				/>
			)}
		</>
	);
}

interface ConfirmProps {
	report: ModerationReport;
	target: string;
	chatTitle: string;
	actions: readonly ModerationAction[];
	lock: LockDuration;
	onClose: () => void;
}

/** The chosen actions and the reason the log keeps (required by the server). */
function ConfirmActions({ report, target, chatTitle, actions, lock, onClose }: ConfirmProps) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [reason, setReason] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("confirm");
	const t = copy.moderation;
	const dismiss = actions.includes("dismiss");
	const summary: Partial<Record<ModerationAction, { icon: IconName; text: string }>> = {
		delete_messages: { icon: "trash", text: t.summaryDelete(target) },
		ban_from_chat: { icon: "ban", text: t.summaryBan(target, chatTitle) },
		restrict_account: { icon: "lock", text: t.summaryLock(target, t.durations[lock] ?? lock) },
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const note = reason.trim();
		if (note === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		remote.resolveReport(report.id, actions, note, actions.includes("restrict_account") ? LOCK_SECONDS[lock] : 0).then(
			() => {
				toasts.show(dismiss ? t.skippedDone : t.doneActions);
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
				<DialogHead id={id} title={dismiss ? t.skipTitle : t.confirmTitle} onClose={onClose} />
				<div className="dlg-body flow">
					{!dismiss && (
						<ul className="summary">
							{actions.map((action) => {
								const line = summary[action];
								return line === undefined ? null : (
									<li key={action}>
										<Icon name={line.icon} small />
										{line.text}
									</li>
								);
							})}
						</ul>
					)}
					<div className="field">
						<label htmlFor={`${id}-reason`}>
							{t.reasonLabel} <span className="muted">{t.reasonHint}</span>
						</label>
						<textarea
							id={`${id}-reason`}
							className="input"
							rows={2}
							maxLength={1000}
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
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className={dismiss ? "btn btn-primary" : "btn btn-danger"} aria-busy={busy} disabled={busy}>
						{t.confirm}
					</button>
				</div>
			</form>
		</Modal>
	);
}

/** Ends an account restriction early, with the reason the log keeps. */
function LiftDialog({ userId, name, onClose, onDone }: { userId: number; name: string; onClose: () => void; onDone: () => void }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [note, setNote] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("lift");
	const t = copy.moderation;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (note.trim() === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		remote.liftRestriction(userId, note.trim()).then(
			() => {
				toasts.show(t.lifted(name));
				onDone();
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<form onSubmit={submit}>
				<DialogHead id={id} title={t.liftTitle(name)} onClose={onClose} />
				<div className="dlg-body flow">
					<div className="field">
						<label htmlFor={`${id}-note`}>
							{t.liftNote} <span className="muted">{t.reasonHint}</span>
						</label>
						<textarea
							id={`${id}-note`}
							className="input"
							rows={2}
							maxLength={1000}
							value={note}
							aria-invalid={invalid}
							aria-describedby={invalid ? `${id}-err` : undefined}
							onChange={(event) => {
								setNote(event.target.value);
								if (event.target.value.trim() !== "") setInvalid(false);
							}}
						/>
						{invalid && (
							<span className="error-text" id={`${id}-err`}>
								{t.reasonRequired}
							</span>
						)}
					</div>
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className="btn btn-primary" aria-busy={busy} disabled={busy}>
						{t.lift}
					</button>
				</div>
			</form>
		</Modal>
	);
}

/** The tabs of the feedback list. */
const FEEDBACK_TABS: readonly FeedbackStatus[] = ["open", "handled"];

function FeedbackQueue() {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const [status, setStatus] = useState<FeedbackStatus>("open");
	const [first, retry] = useLoad(() => remote.moderationFeedback(status), `feedback:${status}`);
	const [extra, setExtra] = useState<{ status: FeedbackStatus; pages: readonly FeedbackPage[] }>({ status, pages: [] });
	if (extra.status !== status) setExtra({ status, pages: [] });
	// Items changed here (handled, answered) since they were loaded.
	const [changed, setChanged] = useState<ReadonlyMap<number, FeedbackItem>>(new Map());
	const [replying, setReplying] = useState<FeedbackItem | null>(null);
	const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
	const t = copy.moderation;

	const pages = first.status === "ready" ? [first.value, ...extra.pages] : [];
	const people = new Map(pages.flatMap((page) => [...page.people]));
	const cursor = pages.at(-1)?.nextCursor ?? "";
	const items = pages
		.flatMap((page) => page.items)
		.map((item) => changed.get(item.id) ?? item)
		.filter((item) => item.status === status);
	const nameOf = (userId: number) => people.get(userId)?.name ?? copy.message.unknownUser;
	const update = (item: FeedbackItem) => setChanged((current) => new Map(current).set(item.id, item));
	const more = () => {
		if (cursor === "") return;
		remote.moderationFeedback(status, cursor).then(
			(page) => setExtra((current) => (current.status === status ? { status, pages: [...current.pages, page] } : current)),
			() => toasts.show(copy.common.failed),
		);
	};
	const markHandled = (item: FeedbackItem) => {
		setBusy((current) => new Set(current).add(item.id));
		const done = () =>
			setBusy((current) => {
				const next = new Set(current);
				next.delete(item.id);
				return next;
			});
		remote.resolveFeedback(item.id).then(
			(resolved) => {
				done();
				update(resolved);
				toasts.show(t.markedHandled);
			},
			() => {
				done();
				toasts.show(copy.common.failed);
			},
		);
	};
	const now = new Date();
	return (
		<>
			<header className="mod-head">
				<h1>{t.feedback}</h1>
				<span className="scope-lock hide-narrow">
					<Icon name="robot" small />
					{t.feedbackVia}
				</span>
			</header>
			<div className="mod-body">
				<div className="tabs" role="tablist" aria-label={t.feedbackStatus}>
					{FEEDBACK_TABS.map((value) => (
						<button key={value} type="button" role="tab" aria-selected={status === value} onClick={() => setStatus(value)}>
							{value === "open" ? t.feedbackOpen : t.feedbackHandled}
							{value === "open" && status === "open" && items.length > 0 && <span className="count">{cursor === "" ? items.length : `${items.length}+`}</span>}
						</button>
					))}
				</div>
				{first.status === "error" ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button type="button" className="btn btn-sm" onClick={retry}>
							{copy.common.retry}
						</button>
					</div>
				) : (
					<ul className="fb-list" aria-busy={first.status === "loading"}>
						{items.map((item) => {
							const person = people.get(item.userId);
							const name = nameOf(item.userId);
							return (
								<li className="fb-item" key={item.id}>
									<div className="fb-head">
										<ChatAvatar id={item.userId} name={name} size="sm" />
										<span className="fb-who">
											<b>{name}</b>
											{person !== undefined && person.username !== "" && <span className="mono muted">@{person.username}</span>}
										</span>
										<span className={item.kind === "bug" ? "pill review" : "pill new"}>{t.feedbackKinds[item.kind] ?? item.kind}</span>
										<span className="fb-time mono muted">{listTime(item.createdAt, now, locale, copy)}</span>
									</div>
									<p className="fb-text">{item.text}</p>
									{item.status === "open" ? (
										<div className="fb-actions">
											<button type="button" className="btn btn-sm btn-primary" onClick={() => setReplying(item)}>
												<Icon name="reply" small />
												{t.reply}
											</button>
											<button type="button" className="btn btn-sm" aria-busy={busy.has(item.id)} disabled={busy.has(item.id)} onClick={() => markHandled(item)}>
												{t.markHandled}
											</button>
										</div>
									) : (
										<div className="fb-reply">
											<span className="fb-meta">
												<Icon name="check" small />
												{item.replyText !== ""
													? t.repliedBy(nameOf(item.repliedBy), listTime(item.repliedAt, now, locale, copy))
													: t.handledBy(nameOf(item.handledBy), listTime(item.handledAt, now, locale, copy))}
											</span>
											{item.replyText !== "" && <p>{item.replyText}</p>}
										</div>
									)}
								</li>
							);
						})}
						{first.status === "ready" && items.length === 0 && (
							<li>
								<div className="empty">
									<Icon name="inbox" />
									<strong>{status === "open" ? t.noFeedback : t.noHandledFeedback}</strong>
									{status === "open" && <span>{t.noFeedbackHint}</span>}
								</div>
							</li>
						)}
					</ul>
				)}
				{cursor !== "" && (
					<button type="button" className="btn" onClick={more}>
						{t.more}
					</button>
				)}
			</div>
			{replying !== null && (
				<ReplyDialog
					item={replying}
					name={nameOf(replying.userId)}
					onClose={() => setReplying(null)}
					onDone={(answered) => {
						setReplying(null);
						update(answered);
					}}
				/>
			)}
		</>
	);
}

/** Why an answer was refused, as the server says it (message prefix). */
function replyFailure(err: unknown, t: FullCopy["moderation"], fallback: string): string {
	const error = ConnectError.from(err);
	if (error.code === Code.FailedPrecondition && error.rawMessage.startsWith("already_replied")) return t.alreadyReplied;
	if (error.code === Code.FailedPrecondition && error.rawMessage.startsWith("user_unreachable")) return t.userUnreachable;
	return fallback;
}

/** Answers one feedback item through the assistant bot. */
function ReplyDialog({ item, name, onClose, onDone }: { item: FeedbackItem; name: string; onClose: () => void; onDone: (item: FeedbackItem) => void }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [text, setText] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("reply");
	const t = copy.moderation;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const answer = text.trim();
		if (answer === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		remote.replyFeedback(item.id, answer).then(
			(answered) => {
				toasts.show(t.replied);
				onDone(answered);
			},
			(err: unknown) => {
				setBusy(false);
				toasts.show(replyFailure(err, t, copy.common.failed));
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<form onSubmit={submit}>
				<DialogHead id={id} title={t.replyTitle(name)} onClose={onClose} />
				<div className="dlg-body flow">
					<blockquote className="fb-quote">{item.text}</blockquote>
					<div className="field">
						<label htmlFor={`${id}-text`}>
							{t.replyLabel} <span className="muted">{t.replyHint}</span>
						</label>
						<textarea
							id={`${id}-text`}
							className="input"
							rows={4}
							maxLength={2000}
							value={text}
							aria-invalid={invalid}
							aria-describedby={invalid ? `${id}-err` : undefined}
							onChange={(event) => {
								setText(event.target.value);
								if (event.target.value.trim() !== "") setInvalid(false);
							}}
						/>
						{invalid && (
							<span className="error-text" id={`${id}-err`}>
								{t.replyRequired}
							</span>
						)}
					</div>
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className="btn btn-primary" aria-busy={busy} disabled={busy}>
						{t.sendReply}
					</button>
				</div>
			</form>
		</Modal>
	);
}

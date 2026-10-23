// Moderation for operators (GetSelf.is_operator) on ModerationService
// (mockups/moderation.html): the tenant's reports grouped by target, a
// report with the messages around it, what the reported people did lately
// and earlier actions on them, and the actions with a required reason:
// remove content, remove and ban from the chat, restrict the chat account,
// warn, turn off a webhook, or dismiss. Closing a report closes every open
// report about the same target. Bots the anti-abuse rule restricted wait for
// review (keep or restore), operators grant or revoke the verified badge,
// and the moderation log lists every action, the automatic rules included.
// The feedback users sent from Settings or to the assistant bot (#feedback) sits next to the
// reports, and the operators' announcements (#announce, announcements.tsx). Everyone else sees "no access"; the server refuses them too.
import { Code, ConnectError } from "@connectrpc/connect";
import { useState, type FormEvent } from "react";
import { useLoader as useDelayedLoader } from "../../components/delayed-loader.tsx";
import { Icon, type IconName } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useScreensCopy, type FullCopy } from "../copy/use-screens-copy.ts";
import { clock, listTime, orgDomain, shortDate, toneOf } from "../data/format.ts";
import type {
	BotReview,
	BotReviews,
	BotTierName,
	ChatBrief,
	FeedbackItem,
	FeedbackPage,
	FeedbackStatus,
	ModerationAction,
	ModerationEntry,
	ModerationLogFilter,
	ModerationLogPage,
	ModerationReport,
	Person,
	ReportDetail,
	ReportGroupsPage,
	ReportStatus,
	ResolveAction,
	Restriction,
	SenderSignals,
} from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, Choice, DialogHead, Modal, useDomId } from "../ui/parts.tsx";
import "./moderation.css";
import { useLoad } from "./use-load.ts";
import Announcements from "./announcements.tsx";
import { serverHost } from "../../server-origin.ts";

/** Which moderation screen is open. */
export type ModerationView =
	| { readonly page: "queue" }
	| { readonly page: "report"; readonly reportId: string; readonly actions: boolean }
	| { readonly page: "feedback" }
	| { readonly page: "announcements" }
	| { readonly page: "log" }
	| { readonly page: "bot"; readonly botId: number };

/** What a report is about, as the queue filters it. */
type ObjectKind = "message" | "user" | "bot" | "group" | "channel" | "webhook";

const OBJECT_ICONS: Record<ObjectKind, IconName> = {
	message: "message",
	user: "user",
	bot: "robot",
	group: "users",
	channel: "megaphone",
	webhook: "webhook",
};

type LockDuration = "day" | "week" | "month" | "forever";
const LOCK_SECONDS: Record<LockDuration, number> = { day: 86_400, week: 604_800, month: 2_592_000, forever: 0 };
const DURATIONS: readonly LockDuration[] = ["day", "week", "month", "forever"];

/** A group this large stands out in the queue. */
const HOT_REPORTS = 10;
/** An account younger than this is marked new in the sender signals. */
const NEW_ACCOUNT_SECONDS = 7 * 86_400;

/** Report ids in the path are decimal; anything else is not a report. */
function parseReportId(value: string): number | null {
	if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : null;
}

function objectKind(report: ModerationReport, chats: ReadonlyMap<number, ChatBrief>): ObjectKind {
	switch (report.kind) {
		case "messages":
			return "message";
		case "user":
		case "bot":
		case "webhook":
			return report.kind;
		case "chat":
			return chats.get(report.targetChatId)?.channel === true ? "channel" : "group";
	}
}

/** Title and second line of a report's object. */
function describe(report: ModerationReport, people: ReadonlyMap<number, Person>, chats: ReadonlyMap<number, ChatBrief>, copy: FullCopy): { title: string; sub: string } {
	const t = copy.moderation;
	if (report.kind === "user" || report.kind === "bot") {
		const person = people.get(report.targetUserId);
		return { title: person?.name ?? copy.message.unknownUser, sub: person === undefined || person.username === "" ? "" : `@${person.username}` };
	}
	const chat = chats.get(report.targetChatId);
	const chatTitle = chat?.title ?? t.unknownChat;
	if (report.kind === "messages" || report.kind === "webhook") return { title: t.messagesIn(report.seqs.length, chatTitle), sub: report.comment };
	return { title: chatTitle, sub: chat === undefined ? "" : t.memberCount(chat.memberCount, chat.channel) };
}

/** An operator's name in the log and history; 0 is an automatic rule. */
function actorName(operatorId: number, people: ReadonlyMap<number, Person>, selfId: number, copy: FullCopy): string {
	if (operatorId === 0) return copy.moderation.autoRule;
	const name = people.get(operatorId)?.name ?? copy.message.unknownUser;
	return operatorId === selfId ? copy.moderation.you(name) : name;
}

export default function Moderation({ view }: { view: ModerationView }) {
	const copy = useScreensCopy();
	const { self } = useServices();
	const scope = orgDomain(serverHost());
	const t = copy.moderation;
	const section = view.page === "feedback" || view.page === "announcements" || view.page === "log" ? view.page : "queue";
	const nav = [
		{ to: paths.moderation(), icon: "inbox" as const, label: t.queue, current: section === "queue" },
		{ to: paths.feedback(), icon: "message-dot" as const, label: t.feedback, current: section === "feedback" },
		{ to: paths.announcements(), icon: "megaphone" as const, label: t.announcements, current: section === "announcements" },
		{ to: paths.moderationLog(), icon: "clock" as const, label: t.logNav, current: section === "log" },
	];
	return (
		<div className="mod">
			<nav className="mod-side" aria-label={t.title}>
				<div className="mod-brand">
					<Icon name="shield" />
					<span>{t.title}</span>
				</div>
				{nav.map((item) => (
					<Link key={item.to} to={item.to} className="nav" current={item.current}>
						<Icon name={item.icon} />
						<span>{item.label}</span>
					</Link>
				))}
				<div className="me">
					<ChatAvatar id={self.id} name={self.name} photoOf={self.id} photoId={self.photoId} size="sm" />
					<span>
						{self.name}
						<small>{t.scopeNote(scope)}</small>
					</span>
				</div>
			</nav>
			<div className="mod-main">
				{self.isOperator && (
					<nav className="mod-tabs" aria-label={t.title}>
						{nav.map((item) => (
							<Link key={item.to} to={item.to} current={item.current}>
								{item.label}
							</Link>
						))}
					</nav>
				)}
				{!self.isOperator ? (
					<div className="empty">
						<Icon name="shield" />
						<strong>{t.noAccess}</strong>
					</div>
				) : (
					<Page view={view} scope={scope} />
				)}
			</div>
		</div>
	);
}

function Page({ view, scope }: { view: ModerationView; scope: string }) {
	switch (view.page) {
		case "queue":
			return <Queue scope={scope} />;
		case "feedback":
			return <FeedbackQueue />;
		case "announcements":
			return <Announcements />;
		case "log":
			return <ModerationLog />;
		case "bot":
			return <BotPage botId={view.botId} />;
		case "report": {
			const id = parseReportId(view.reportId);
			if (id === null) return <NotFound />;
			return view.actions ? <Actions reportId={id} /> : <Detail reportId={id} />;
		}
	}
}

function NotFound({ message }: { message?: string }) {
	const copy = useScreensCopy();
	return (
		<div className="empty">
			<strong>{message ?? copy.moderation.notFound}</strong>
			<Link to={paths.moderation()} className="link">
				{copy.moderation.backToQueue}
			</Link>
		</div>
	);
}

function LoadError({ retry }: { retry: () => void }) {
	const copy = useScreensCopy();
	return (
		<div className="banner error" role="alert">
			<Icon name="alert" small />
			<span className="grow">{copy.common.loadFailed}</span>
			<button type="button" className="btn btn-sm" onClick={retry}>
				{copy.common.retry}
			</button>
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
	const [pages, retry] = useLoad(() => remote.moderationGroups(status), `queue:${status}`);
	const [extra, setExtra] = useState<{ status: ReportStatus; pages: readonly ReportGroupsPage[] }>({ status, pages: [] });
	if (extra.status !== status) setExtra({ status, pages: [] });
	const t = copy.moderation;

	const loaded = pages.status === "ready" ? [pages.value, ...extra.pages] : [];
	const people = new Map(loaded.flatMap((page) => [...page.people]));
	const chats = new Map(loaded.flatMap((page) => [...page.chats]));
	const groups = loaded.flatMap((page) => page.groups);
	const cursor = loaded.at(-1)?.nextCursor ?? "";
	const needle = query.trim().toLowerCase().replace(/^@/, "");
	const rows = groups
		.map((group) => ({ group, kind: objectKind(group.report, chats), ...describe(group.report, people, chats, copy) }))
		.filter(
			(row) =>
				(type === "all" || row.kind === type) &&
				(needle === "" || String(row.group.report.id).includes(needle) || `${row.title} ${row.sub}`.toLowerCase().includes(needle)),
		);
	const more = () => {
		if (cursor === "") return;
		remote.moderationGroups(status, cursor).then(
			(page) => setExtra((current) => (current.status === status ? { status, pages: [...current.pages, page] } : current)),
			() => toasts.show(copy.common.failed),
		);
	};
	const tabs: { value: ReportStatus; label: string }[] = [
		{ value: "open", label: t.open },
		{ value: "resolved", label: t.resolved },
		{ value: "dismissed", label: t.dismissed },
	];
	const columns = [t.object, t.kind, t.mainReason, t.reportCount, t.status, t.latest];
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
				<BotReviewsBanner />
				<div className="toolbar">
					<div className="tabs" role="tablist" aria-label={t.status}>
						{tabs.map((tab) => (
							<button key={tab.value} type="button" role="tab" aria-selected={status === tab.value} onClick={() => setStatus(tab.value)}>
								{tab.label}
								{tab.value === "open" && status === "open" && groups.length > 0 && <span className="count">{cursor === "" ? groups.length : `${groups.length}+`}</span>}
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
					<LoadError retry={retry} />
				) : (
					<div className="table-wrap">
						<table className="data queue" aria-busy={pages.status === "loading"}>
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
								{rows.map(({ group, kind, title, sub }) => (
									<tr key={group.report.id}>
										<td>
											<Link to={paths.moderation(String(group.report.id))} className="obj">
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
										<td data-label={columns[2]}>{copy.report[group.mainReason]}</td>
										<td data-label={columns[3]} className="num">
											<span className={group.count >= HOT_REPORTS ? "hot" : undefined}>{group.count}</span>
										</td>
										<td data-label={columns[4]}>
											<Pill status={group.report.status} />
										</td>
										<td data-label={columns[5]} className="mono">
											{listTime(group.report.createdAt, new Date(), locale, copy)}
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

/** Bots the anti-abuse rule restricted that wait for an operator. */
function BotReviewsBanner() {
	const copy = useScreensCopy();
	const { remote } = useServices();
	const [reviews] = useLoad(() => remote.botReviews(), "bot-reviews");
	if (reviews.status !== "ready" || reviews.value.reviews.length === 0) return null;
	const { people } = reviews.value;
	const t = copy.moderation;
	return (
		<div className="banner warn downgraded" role="status">
			<Icon name="robot" small />
			<p>
				<b>{t.botReviewsBanner(reviews.value.reviews.length)}</b>
			</p>
			<ul className="plain">
				{reviews.value.reviews.map((review) => (
					<li className="bot-row" key={review.botId}>
						<span className="grow">
							<b>{people.get(review.botId)?.name ?? copy.message.unknownUser}</b>
							<small className="muted">{review.restrictedReason}</small>
						</span>
						<Link to={paths.moderationBot(review.botId)} className="btn btn-sm">
							{t.reviewBot}
						</Link>
					</li>
				))}
			</ul>
		</div>
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
			{!actions && kind === "bot" && (
				<Link to={paths.moderationBot(report.targetUserId)} className="btn btn-sm">
					<Icon name="robot" small />
					{t.viewBot}
				</Link>
			)}
			{!actions && report.status === "open" && (
				<Link to={paths.moderation(String(report.id), true)} className="btn btn-sm btn-primary">
					{t.actions}
				</Link>
			)}
		</header>
	);
}

function detailKind(detail: ReportDetail): ObjectKind {
	return objectKind(detail.report, new Map(detail.chat === null ? [] : [[detail.chat.id, detail.chat] as const]));
}

function Detail({ reportId }: { reportId: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, self } = useServices();
	const [detail, reload] = useLoad(() => remote.moderationReport(reportId), `detail:${reportId}`);
	const [lifting, setLifting] = useState<Restriction | null>(null);
	const t = copy.moderation;
	const loader = useDelayedLoader(detail.status === "loading", copy.common.loading);
	if (loader !== null) return loader;
	if (detail.status !== "ready") return <NotFound />;
	const value = detail.value;
	const { report, people, group } = value;
	const nameOf = (userId: number) => people.get(userId)?.name ?? copy.message.unknownUser;
	const reported = new Set(report.seqs);
	const evidence = new Map(value.evidence.map((message) => [message.seq, message]));
	const comments = group.comments.length > 0 ? group.comments : report.comment === "" ? [] : [report.comment];
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
						<h2 className="card-title flush">
							{group.reportCount > 1
								? t.reporters(group.reporterCount, comments.length)
								: t.reportBy(nameOf(report.reporterId), listTime(report.createdAt, new Date(), locale, copy))}
						</h2>
						<p className="muted">
							{group.reasons.length > 0 ? group.reasons.map((entry) => `${copy.report[entry.reason]} ${entry.count}`).join(" · ") : copy.report[report.reason]}
						</p>
						{comments.length > 0 && (
							<ul className="notes">
								{comments.map((comment, index) => (
									<li key={index}>“{comment}”</li>
								))}
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
					{value.signals.map((signals) => (
						<SignalsCard key={signals.userId} signals={signals} person={people.get(signals.userId)} />
					))}
					{report.kind === "webhook" && (
						<div className="card">
							<h2 className="card-title">{t.hooksTitle}</h2>
							{value.hooks.length === 0 ? (
								<p className="note pad-x pad-b">{t.noHooks}</p>
							) : (
								<dl className="facts">
									{value.hooks.map((hook) => (
										<div key={hook.id}>
											<dt>{hook.name}</dt>
											<dd>
												<span className={hook.disabled ? "pill skip" : "pill done"}>{hook.disabled ? t.hookOff : t.hookOn}</span>
											</dd>
										</div>
									))}
								</dl>
							)}
						</div>
					)}
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
											{actorName(entry.operatorId, people, self.id, copy)} · {listTime(entry.createdAt, new Date(), locale, copy)}
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
				<NoteDialog
					title={t.liftTitle(nameOf(lifting.userId))}
					label={t.liftNote}
					submit={t.lift}
					run={(note) => remote.liftRestriction(lifting.userId, note)}
					done={t.lifted(nameOf(lifting.userId))}
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

/** What a reported person did lately (mockups/moderation.html#report-detail). */
function SignalsCard({ signals, person }: { signals: SenderSignals; person: Person | undefined }) {
	const copy = useScreensCopy();
	const t = copy.moderation;
	const name = person?.name ?? copy.message.unknownUser;
	const facts: { label: string; value: string; flag?: boolean }[] = [
		{ label: t.accountAge, value: t.ageValue(signals.accountAgeSeconds), flag: signals.accountAgeSeconds < NEW_ACCOUNT_SECONDS },
		{ label: t.strangerChats, value: String(signals.strangerChats24h) },
		{ label: t.blockedBy, value: t.peopleCount(signals.blockedBy) },
		{ label: t.chatsJoined, value: String(signals.chatsJoined24h) },
		{ label: t.otherReports, value: String(signals.otherOpenReports) },
	];
	return (
		<div className="card">
			<h2 className="card-title">{t.signals}</h2>
			<div className="person pad-x pad-b">
				<ChatAvatar id={signals.userId} name={name} />
				<div>
					<b>{name}</b>
					{person !== undefined && person.username !== "" && <span className="mono muted">@{person.username}</span>}
				</div>
			</div>
			<dl className="facts">
				{facts.map((fact) => (
					<div key={fact.label}>
						<dt>{fact.label}</dt>
						<dd>
							{fact.value}
							{fact.flag === true && <span className="pill review">{t.newAccount}</span>}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

interface ActionOption {
	readonly action: Exclude<ResolveAction, "dismiss">;
	readonly label: string;
	readonly hint: string;
	readonly disabled: boolean;
}

/** The action checked first for a kind of report. */
function defaultAction(kind: ObjectKind): ResolveAction {
	if (kind === "webhook") return "disable_webhook";
	if (kind === "message") return "delete_messages";
	return "warn";
}

function Actions({ reportId }: { reportId: number }) {
	const copy = useScreensCopy();
	const { remote } = useServices();
	const [detail] = useLoad(() => remote.moderationReport(reportId), `detail:${reportId}`);
	const [chosen, setChosen] = useState<ReadonlySet<ResolveAction> | null>(null);
	const [lock, setLock] = useState<LockDuration>("week");
	const [confirming, setConfirming] = useState<readonly ResolveAction[] | null>(null);
	const t = copy.moderation;
	const loader = useDelayedLoader(detail.status === "loading", copy.common.loading);
	if (loader !== null) return loader;
	if (detail.status !== "ready") return <NotFound />;
	const value = detail.value;
	const report = value.report;
	const kind = detailKind(value);
	const messages = kind === "message";
	const webhook = kind === "webhook";
	const people = kind === "message" || kind === "user" || kind === "bot";
	const selected = chosen ?? new Set<ResolveAction>([defaultAction(kind)]);
	const options: ActionOption[] = [
		{ action: "delete_messages", label: t.deleteMessages, hint: t.deleteMessagesHint, disabled: !messages && !webhook },
		{ action: "ban_from_chat", label: t.banFromChat, hint: t.banFromChatHint, disabled: !messages },
		{ action: "restrict_account", label: t.lock, hint: t.lockHint, disabled: !people },
		{ action: "warn", label: t.warn, hint: t.warnHint, disabled: !people || kind === "bot" },
		{ action: "disable_webhook", label: t.disableWebhook, hint: t.disableWebhookHint, disabled: !webhook },
	];
	const usable = options.filter((option) => !option.disabled && selected.has(option.action)).map((option) => option.action);
	const toggle = (action: ResolveAction) => {
		const next = new Set(selected);
		if (next.has(action)) next.delete(action);
		else next.add(action);
		setChosen(next);
	};
	const target = describe(report, value.people, new Map(value.chat === null ? [] : [[value.chat.id, value.chat] as const]), copy);
	if (report.status !== "open") {
		return (
			<>
				<DetailHead report={report} kind={kind} actions />
				<div className="mod-body">
					<p className="note">{t.closed}</p>
				</div>
			</>
		);
	}
	return (
		<>
			<DetailHead report={report} kind={kind} actions />
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
								<input type="checkbox" checked={selected.has(option.action) && !option.disabled} disabled={option.disabled} onChange={() => toggle(option.action)} />
								<span>
									{option.label}
									<small>{option.disabled ? t.notForKind : option.hint}</small>
								</span>
							</label>
							{option.action === "restrict_account" && selected.has("restrict_account") && !option.disabled && (
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
					hooks={value.hooks.filter((hook) => !hook.disabled).map((hook) => hook.name)}
					groupSize={value.group.reportCount}
					canNotify={people && kind !== "bot"}
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
	/** The webhooks disable_webhook turns off. */
	hooks: readonly string[];
	/** Open reports about the same target, closed together. */
	groupSize: number;
	/** The reported people can be told about it. */
	canNotify: boolean;
	actions: readonly ResolveAction[];
	lock: LockDuration;
	onClose: () => void;
}

/** The chosen actions and the reason the log keeps (required by the server). */
function ConfirmActions({ report, target, chatTitle, hooks, groupSize, canNotify, actions, lock, onClose }: ConfirmProps) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [reason, setReason] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notify, setNotify] = useState(true);
	const id = useDomId("confirm");
	const t = copy.moderation;
	const dismiss = actions.includes("dismiss");
	// A warning always reaches the person; the other actions only when asked.
	const offerNotify = canNotify && !dismiss && !actions.includes("warn");
	const summary: Partial<Record<ResolveAction, { icon: IconName; text: string }>> = {
		delete_messages: { icon: "trash", text: t.summaryDelete(target) },
		ban_from_chat: { icon: "ban", text: t.summaryBan(target, chatTitle) },
		restrict_account: { icon: "lock", text: t.summaryLock(target, t.durations[lock] ?? lock) },
		warn: { icon: "alert-triangle", text: t.summaryWarn(target) },
		disable_webhook: { icon: "webhook", text: t.summaryDisableHook(hooks.join(", ")) },
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const note = reason.trim();
		if (note === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		remote.resolveReport(report.id, actions, note, actions.includes("restrict_account") ? LOCK_SECONDS[lock] : 0, offerNotify && notify).then(
			() => {
				toasts.show(dismiss ? t.skippedDone : t.doneActions);
				onClose();
				navigate(paths.moderation());
			},
			(err: unknown) => {
				setBusy(false);
				const error = ConnectError.from(err);
				toasts.show(error.code === Code.FailedPrecondition && error.rawMessage.startsWith("no_webhook") ? t.noHookToDisable : copy.common.failed);
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
					{groupSize > 1 && <p className="note">{t.groupClose(groupSize)}</p>}
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
					{offerNotify && (
						<label className="opt check">
							<input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
							<span>{t.notify}</span>
						</label>
					)}
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

interface NoteDialogProps {
	title: string;
	label: string;
	submit: string;
	/** Runs the change with the reason the log keeps. */
	run: (note: string) => Promise<unknown>;
	/** The toast once it is done. */
	done: string;
	danger?: boolean;
	onClose: () => void;
	onDone: () => void;
}

/** A change that needs a reason for the log: lifting a restriction, reviewing a bot. */
function NoteDialog({ title, label, submit: submitLabel, run, done, danger = false, onClose, onDone }: NoteDialogProps) {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const [note, setNote] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("note");
	const t = copy.moderation;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (note.trim() === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		run(note.trim()).then(
			() => {
				toasts.show(done);
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
				<DialogHead id={id} title={title} onClose={onClose} />
				<div className="dlg-body flow">
					<div className="field">
						<label htmlFor={`${id}-note`}>
							{label} <span className="muted">{t.reasonHint}</span>
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
					<button type="submit" className={danger ? "btn btn-danger" : "btn btn-primary"} aria-busy={busy} disabled={busy}>
						{submitLabel}
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
					<Icon name="message-dot" small />
					{t.feedbackSources}
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
										<span className="fb-src muted">{t.feedbackSource[item.source]}</span>
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
							{t.replyLabel} <span className="muted">{item.source === "settings" ? t.replyHintSettings : t.replyHint}</span>
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

type LogPeriod = "week" | "month" | "all";
const PERIOD_SECONDS: Record<LogPeriod, number> = { week: 7 * 86_400, month: 30 * 86_400, all: 0 };
/** The CSV export reads at most this many pages of 500 entries. */
const EXPORT_PAGES = 20;
const LOG_ACTIONS: readonly ModerationAction[] = [
	"delete_messages",
	"ban_from_chat",
	"restrict_account",
	"lift_restriction",
	"warn",
	"disable_webhook",
	"dismiss",
	"restrict_bot",
	"restore_bot_tier",
	"keep_bot_restricted",
	"verify_bot",
	"unverify_bot",
	"limit_stranger_chats",
];

/** The look of an action in the log. */
function actionTone(action: ModerationAction): string {
	switch (action) {
		case "delete_messages":
		case "ban_from_chat":
		case "disable_webhook":
		case "restrict_bot":
			return "t-remove";
		case "restrict_account":
		case "keep_bot_restricted":
			return "t-lock";
		case "warn":
		case "limit_stranger_chats":
			return "t-warn";
		case "dismiss":
			return "t-skip";
		default:
			return "t-ok";
	}
}

/** Who or what an entry was about. */
function entryTarget(entry: ModerationEntry, page: { people: ReadonlyMap<number, Person>; chats: ReadonlyMap<number, ChatBrief> }, copy: FullCopy): string {
	const t = copy.moderation;
	const chat = page.chats.get(entry.targetChatId)?.title ?? t.unknownChat;
	if (entry.hookId !== "") return t.targetHook(chat);
	if (entry.action === "delete_messages" && entry.seqs.length > 0) return t.targetMessages(entry.seqs.length, chat);
	if (entry.targetUserId !== 0) {
		const person = page.people.get(entry.targetUserId);
		return person === undefined ? copy.message.unknownUser : person.username === "" ? person.name : `@${person.username}`;
	}
	return entry.targetChatId === 0 ? "" : chat;
}

/**
 * One CSV field. Names and reasons come from users, so a field a spreadsheet
 * would run as a formula (= + - @, tab, carriage return) gets a leading
 * apostrophe and is shown as text.
 */
function csvCell(value: string): string {
	const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The moderation log (mockups/moderation.html#audit-log), append only. */
function ModerationLog() {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts, self } = useServices();
	const [actor, setActor] = useState<"all" | "auto" | "me">("all");
	const [action, setAction] = useState<ModerationAction | "all">("all");
	const [period, setPeriod] = useState<LogPeriod>("week");
	const [exporting, setExporting] = useState(false);
	const t = copy.moderation;
	// The start of the period, fixed while the filters stay the same.
	const [since] = useState(() => Math.floor(Date.now() / 1000));
	const filter: ModerationLogFilter = {
		actor: actor === "me" ? self.id : actor,
		action,
		since: PERIOD_SECONDS[period] === 0 ? 0 : since - PERIOD_SECONDS[period],
	};
	const key = `log:${actor}:${action}:${period}`;
	const [first, retry] = useLoad(() => remote.moderationLog(filter), key);
	const [extra, setExtra] = useState<{ key: string; pages: readonly ModerationLogPage[] }>({ key, pages: [] });
	if (extra.key !== key) setExtra({ key, pages: [] });
	const pages = first.status === "ready" ? [first.value, ...extra.pages] : [];
	const people = new Map(pages.flatMap((page) => [...page.people]));
	const chats = new Map(pages.flatMap((page) => [...page.chats]));
	const entries = pages.flatMap((page) => page.entries);
	const cursor = pages.at(-1)?.nextCursor ?? "";
	const more = () => {
		remote.moderationLog(filter, cursor).then(
			(page) => setExtra((current) => (current.key === key ? { key, pages: [...current.pages, page] } : current)),
			() => toasts.show(copy.common.failed),
		);
	};
	const columns = [t.time, t.actor, t.actionFilter, t.target, t.reason];
	const exportCsv = async () => {
		setExporting(true);
		try {
			const all: ModerationLogPage[] = [];
			let next = "";
			for (let i = 0; i < EXPORT_PAGES; i++) {
				const page = await remote.moderationLog(filter, next, 500);
				all.push(page);
				next = page.nextCursor;
				if (next === "") break;
			}
			const lookup = { people: new Map(all.flatMap((page) => [...page.people])), chats: new Map(all.flatMap((page) => [...page.chats])) };
			const rows = all
				.flatMap((page) => page.entries)
				.map((entry) =>
					[
						new Date(entry.createdAt * 1000).toISOString(),
						actorName(entry.operatorId, lookup.people, self.id, copy),
						t.actionNames[entry.action] ?? entry.action,
						entryTarget(entry, lookup, copy),
						entry.note,
					]
						.map(csvCell)
						.join(","),
				);
			// The byte order mark makes spreadsheet apps read the file as UTF-8.
			const blob = new Blob([`\uFEFF${columns.map(csvCell).join(",")}\n${rows.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = t.csvFile;
			link.click();
			URL.revokeObjectURL(url);
		} catch {
			toasts.show(copy.common.failed);
		} finally {
			setExporting(false);
		}
	};
	return (
		<>
			<header className="mod-head">
				<h1>{t.logTitle}</h1>
				<button type="button" className="btn btn-sm" onClick={() => void exportCsv()} aria-busy={exporting} disabled={exporting || entries.length === 0}>
					<Icon name="download" small />
					{exporting ? t.exporting : t.exportCsv}
				</button>
			</header>
			<div className="mod-body">
				<div className="filters">
					<Choice<"all" | "auto" | "me">
						label={t.actor}
						value={actor}
						onChange={setActor}
						options={[
							{ value: "all", label: t.actorAll },
							{ value: "auto", label: t.autoRule },
							{ value: "me", label: t.actorMe },
						]}
					/>
					<Choice<LogPeriod>
						label={t.period}
						value={period}
						onChange={setPeriod}
						options={(["week", "month", "all"] as const).map((value) => ({ value, label: t.periods[value] ?? value }))}
					/>
					<span className="append-only muted">
						<Icon name="lock" small />
						{t.appendOnly}
					</span>
				</div>
				<div className="filters">
					<Choice<ModerationAction | "all">
						label={t.actionFilter}
						value={action}
						onChange={setAction}
						options={[{ value: "all", label: t.actionAll }, ...LOG_ACTIONS.map((value) => ({ value, label: t.actionNames[value] ?? value }))]}
					/>
				</div>
				{first.status === "error" ? (
					<LoadError retry={retry} />
				) : (
					<div className="table-wrap">
						<table className="data audit" aria-busy={first.status === "loading"}>
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
								{entries.map((entry) => (
									<tr key={entry.id}>
										<td className="mono">
											{shortDate(entry.createdAt, locale)} {clock(entry.createdAt, locale)}
										</td>
										<td data-label={columns[1]}>
											{entry.operatorId === 0 ? (
												<span className="by-rule">
													<Icon name="shield" small />
													{t.autoRule}
												</span>
											) : (
												actorName(entry.operatorId, people, self.id, copy)
											)}
										</td>
										<td data-label={columns[2]}>
											<span className={`act-tag ${actionTone(entry.action)}`}>{t.actionNames[entry.action] ?? entry.action}</span>
										</td>
										<td data-label={columns[3]}>{entryTarget(entry, { people, chats }, copy)}</td>
										<td data-label={columns[4]} className="why">
											{entry.note}
										</td>
									</tr>
								))}
								{first.status === "ready" && entries.length === 0 && (
									<tr className="no-rows">
										<td colSpan={columns.length}>
											<div className="empty">
												<Icon name="clock" />
												<strong>{t.noLog}</strong>
												<span>{t.noLogHint}</span>
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

/** Rate limits per tier, as the Bot API applies them (botapi tiers). */
const TIER_ROWS: readonly { tier: BotTierName; sends: number; calls: number }[] = [
	{ tier: "restricted", sends: 1, calls: 5 },
	{ tier: "new", sends: 5, calls: 10 },
	{ tier: "default", sends: 30, calls: 30 },
	{ tier: "verified", sends: 100, calls: 100 },
];

type BotChange = "verify" | "unverify" | "keep" | "restore";

/** One bot as the operators review it (mockups/moderation.html#bot-verified). */
function BotPage({ botId }: { botId: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote } = useServices();
	const [loaded, reload] = useLoad(() => remote.botReview(botId), `bot:${botId}`);
	const [change, setChange] = useState<BotChange | null>(null);
	const t = copy.moderation;
	const loader = useDelayedLoader(loaded.status === "loading", copy.common.loading);
	if (loader !== null) return loader;
	if (loaded.status !== "ready" || loaded.value.reviews[0] === undefined) return <NotFound message={t.botNotFound} />;
	const value: BotReviews = loaded.value;
	const review: BotReview = loaded.value.reviews[0];
	const bot = value.people.get(review.botId);
	const owner = value.people.get(review.ownerId);
	const name = bot?.name ?? copy.message.unknownUser;
	const stats = [
		{ label: t.botUsers, value: review.users.toLocaleString(locale) },
		{ label: t.botMessages, value: review.messages7d.toLocaleString(locale) },
		{ label: t.botBlocked, value: t.percent(review.blockedPermille24h) },
		{ label: t.botReports, value: review.openReports.toLocaleString(locale) },
	];
	const dialogs: Record<BotChange, { title: string; submit: string; run: (note: string) => Promise<unknown>; danger: boolean }> = {
		verify: { title: t.verifyTitle(name), submit: t.grantVerify, run: (note) => remote.setBotVerified(review.botId, true, note), danger: false },
		unverify: { title: t.unverifyTitle(name), submit: t.revokeVerify, run: (note) => remote.setBotVerified(review.botId, false, note), danger: true },
		keep: { title: t.keepTitle(name), submit: t.keepRestricted, run: (note) => remote.reviewBotRestriction(review.botId, false, note), danger: true },
		restore: { title: t.restoreTitle(name), submit: t.restoreTier, run: (note) => remote.reviewBotRestriction(review.botId, true, note), danger: false },
	};
	const dialog = change === null ? null : dialogs[change];
	return (
		<>
			<header className="mod-head">
				<Link to={paths.moderation()} className="icon-btn" aria-label={t.backToQueue}>
					<Icon name="back" />
				</Link>
				<h1>{t.bot}</h1>
			</header>
			<div className="mod-body narrow-body">
				<div className="card pad bot-hero">
					<ChatAvatar id={review.botId} name={name} size="lg" />
					<div className="grow">
						<span className="bot-name">
							{name}
							{review.verified && (
								<span className="verified">
									<Icon name="check" small />
									{t.verifiedBadge}
								</span>
							)}
						</span>
						<span className="muted">
							{bot !== undefined && bot.username !== "" && <span className="mono">@{bot.username} · </span>}
							{owner !== undefined && `${t.botOwner(owner.username === "" ? owner.name : `${owner.name} (@${owner.username})`)} · `}
							{t.botCreated(shortDate(review.createdAt, locale))}
						</span>
					</div>
					{review.tier !== "internal" && (
						<button type="button" className={review.verified ? "btn btn-sm" : "btn btn-sm btn-primary"} onClick={() => setChange(review.verified ? "unverify" : "verify")}>
							{review.verified ? t.revokeVerify : t.grantVerify}
						</button>
					)}
				</div>
				{review.restrictedAt !== 0 && (
					<div className="banner warn downgraded" role="status">
						<Icon name="alert-triangle" small />
						<p>
							{review.restrictedAutomatically ? t.restrictedAuto(`${clock(review.restrictedAt, locale)} ${shortDate(review.restrictedAt, locale)}`, review.restrictedReason) : review.restrictedReason}
							{review.restrictionReviewed && <small className="muted"> {t.restrictedReviewed}</small>}
						</p>
						<div className="btn-row">
							{!review.restrictionReviewed && (
								<button type="button" className="btn btn-sm" onClick={() => setChange("keep")}>
									{t.keepRestricted}
								</button>
							)}
							<button type="button" className="btn btn-sm btn-primary" onClick={() => setChange("restore")}>
								{t.restoreTier}
							</button>
						</div>
					</div>
				)}
				<div className="stats">
					{stats.map((stat) => (
						<div className="stat" key={stat.label}>
							<b>{stat.value}</b>
							<span>{stat.label}</span>
						</div>
					))}
				</div>
				<div className="card">
					<h2 className="card-title">{t.tiersTitle}</h2>
					<div className="table-wrap">
						<table className="data tiers">
							<thead>
								<tr>
									<th scope="col">{t.tier}</th>
									<th scope="col" className="num">
										{t.tierSends}
									</th>
									<th scope="col" className="num">
										{t.tierCalls}
									</th>
								</tr>
							</thead>
							<tbody>
								{TIER_ROWS.map((row) => (
									<tr key={row.tier} aria-current={row.tier === review.tier ? "true" : undefined}>
										<td>
											{t.tierNames[row.tier] ?? row.tier}
											{row.tier === review.tier && <span className="here">{t.tierHere}</span>}
										</td>
										<td className="num">{row.sends}</td>
										<td className="num">{row.calls}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="note pad-x pad-b">{t.tiersNote}</p>
				</div>
			</div>
			{change !== null && dialog !== null && (
				<NoteDialog
					title={dialog.title}
					label={t.reasonLabel}
					submit={dialog.submit}
					run={dialog.run}
					done={t.botReviewDone}
					danger={dialog.danger}
					onClose={() => setChange(null)}
					onDone={() => {
						setChange(null);
						reload();
					}}
				/>
			)}
		</>
	);
}

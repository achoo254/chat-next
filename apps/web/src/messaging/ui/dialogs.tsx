// Confirmation and detail dialogs: delete (mockups #delete), leave with the
// owner's hand-over (#channel-owner-leave), external link (#external-link),
// report (settings.html#report), another user's profile (#user-profile) and
// who read a message (#read-by).
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { clock, dialogTitle, hostOf, messagePreview, orgDomain, userName } from "../data/format.ts";
import type { ReportReason, ReportTarget } from "../data/pending-backend.ts";
import type { Member, Reader } from "../data/remote.ts";
import { useChat, useMessage, useServices, useUser } from "../data/services.tsx";
import { ContactRow } from "./contact-row.tsx";
import { Glyph } from "./glyphs.tsx";
import { useMembers } from "./members.ts";
import { ChatAvatar, copyText, CopyButton, DialogHead, Modal, useDomId } from "./parts.tsx";
import { usePresence, usePresenceText } from "./presence.tsx";
import { useUi } from "./ui-context.tsx";

interface CloseProps {
	onClose: () => void;
}

function Quote({ chatId, seq }: { chatId: number; seq: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { store } = useServices();
	const message = useMessage(chatId, seq);
	const author = useUser(message != null && message.fromId !== store.selfId ? message.fromId : 0);
	if (message == null) return null;
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	const name = message.fromId === store.selfId ? copy.common.you : (author?.name ?? copy.message.unknownUser);
	return (
		<div className="quote">
			<b>
				{name} · {clock(message.date, locale)}
			</b>
			{messagePreview(message, nameOf, copy)}
		</div>
	);
}

export function DeleteDialog({ chatId, seq, mine, onClose }: CloseProps & { chatId: number; seq: number; mine: boolean }) {
	const copy = useScreensCopy();
	const { source, store, toasts } = useServices();
	const chat = useChat(chatId);
	const message = useMessage(chatId, seq);
	const author = useUser(message != null && !mine ? message.fromId : 0);
	const [forEveryone, setForEveryone] = useState(true);
	const [busy, setBusy] = useState(false);
	const id = useDomId("del");
	const chatTitle = chat == null ? "" : dialogTitle({ chat, peer: store.user(chat.peerUserId) ?? null }, copy);
	const everyone = mine && forEveryone;
	const confirm = () => {
		setBusy(true);
		source.deleteMessages(chatId, [seq], everyone).then(
			() => {
				toasts.show(everyone ? copy.deleteDialog.deleted : copy.deleteDialog.hidden);
				onClose();
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={mine ? copy.deleteDialog.mineTitle : copy.deleteDialog.theirsTitle(author?.name ?? copy.message.unknownUser)} onClose={onClose} />
			<div className="dlg-body stack">
				<Quote chatId={chatId} seq={seq} />
				{mine && (
					<button type="button" className="check-row" role="checkbox" aria-checked={forEveryone} onClick={() => setForEveryone((on) => !on)}>
						<span className="tick sq">
							<Icon name="check" />
						</span>
						{copy.deleteDialog.forEveryone(chatTitle)}
					</button>
				)}
				{(everyone || !mine) && (
					<p className="note">
						<Icon name={mine ? "info" : "eye-off"} />
						<span>{mine ? copy.deleteDialog.forEveryoneNote : copy.deleteDialog.onlyMeNote}</span>
					</p>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={confirm}>
					{mine ? copy.deleteDialog.delete : copy.deleteDialog.deleteForMe}
				</button>
			</div>
		</Modal>
	);
}

/** LeaveChat's answer when an owner would leave members behind without an admin. */
function ownerNeedsAdmin(err: unknown): boolean {
	const error = ConnectError.from(err);
	return error.code === Code.FailedPrecondition && error.rawMessage.startsWith("owner_needs_admin");
}

export function LeaveDialog({ chatId, onClose }: CloseProps & { chatId: number }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const chat = useChat(chatId);
	const [view, setView] = useState<"confirm" | "blocked" | "pick">("confirm");
	const [busy, setBusy] = useState(false);
	const owner = chat?.myRole === "owner";
	const channel = chat?.type === "channel";
	const { members, reload } = useMembers(chatId, "", owner);
	const id = useDomId("leave");
	const title = chat?.title ?? "";
	const t = copy.ownerLeave;
	const leave = () => {
		setBusy(true);
		remote.leaveChat(chatId).then(
			() => {
				toasts.show(copy.info.left(title));
				onClose();
				navigate(paths.home);
			},
			(err: unknown) => {
				setBusy(false);
				if (ownerNeedsAdmin(err)) setView("blocked");
				else toasts.show(copy.common.failed);
			},
		);
	};

	if (view === "pick") {
		return (
			<PickAdmin
				chatId={chatId}
				channel={channel}
				memberCount={chat?.memberCount ?? 0}
				onBack={() => setView("blocked")}
				onDone={() => {
					reload();
					setView("confirm");
				}}
				onClose={onClose}
			/>
		);
	}
	if (view === "blocked") {
		return (
			<Modal labelledBy={id} onClose={onClose} className="narrow">
				<DialogHead id={id} title={t.blockedTitle(channel)} onClose={onClose} />
				<div className="hero">
					<span className="big-icon">
						<Glyph name="crown" />
					</span>
					<p>
						{t.blockedKind(channel)} <b>{title}</b>
						{t.blockedRest(channel)}
					</p>
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="button" className="btn btn-primary" onClick={() => setView("pick")}>
						<Icon name="user-plus" />
						{t.pickAdmin}
					</button>
				</div>
			</Modal>
		);
	}
	const admins = members.filter((member) => member.role === "admin");
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.info.leaveTitle(title)} onClose={onClose} />
			<div className="dlg-body stack">
				{owner ? (
					<>
						<p className="note">
							<Glyph name="crown" />
							<span>{t.transferNote(channel)}</span>
						</p>
						{admins.length > 0 && (
							<div>
								<h3>{t.admins}</h3>
								{admins.map((member) => (
									<div className="row" key={member.person.id}>
										<ChatAvatar id={member.person.id} name={member.person.name} size="sm" />
										<span className="grow">{member.person.name}</span>
									</div>
								))}
							</div>
						)}
						<p className="note">
							<Icon name="info" />
							<span>{t.transferInfo(channel)}</span>
						</p>
					</>
				) : (
					<p className="note">
						<Icon name="info" />
						<span>{copy.info.leaveNote}</span>
					</p>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={leave}>
					{owner ? t.transferLeave(channel) : channel ? copy.info.leaveChannel : copy.info.leaveGroup}
				</button>
			</div>
		</Modal>
	);
}

interface PickAdminProps extends CloseProps {
	chatId: number;
	channel: boolean;
	memberCount: number;
	onBack: () => void;
	onDone: () => void;
}

/** Makes a member an admin so the owner can hand the chat over (#channel-owner-leave, lower frame). */
function PickAdmin({ chatId, channel, memberCount, onBack, onDone, onClose }: PickAdminProps) {
	const copy = useScreensCopy();
	const { remote, store, toasts } = useServices();
	const [query, setQuery] = useState("");
	const [picked, setPicked] = useState<Member | null>(null);
	const [busy, setBusy] = useState(false);
	const { members, status } = useMembers(chatId, query.trim());
	const id = useDomId("pick-admin");
	const t = copy.ownerLeave;
	const candidates = members.filter((member) => member.role === "member" && !member.person.isBot && member.person.id !== store.selfId);
	const grant = () => {
		if (picked === null) return;
		setBusy(true);
		remote.setAdmin(chatId, picked.person.id, true).then(
			() => {
				toasts.show(t.granted(picked.person.name, channel));
				onDone();
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.pickTitle(channel)} onBack={onBack} onClose={onClose} />
			<div className="dlg-body stack">
				<label className="search-field">
					<Icon name="search" small />
					<span className="sr-only">{t.pickSearch(memberCount, channel)}</span>
					<input type="search" placeholder={t.pickSearch(memberCount, channel)} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				{status === "loading" && <p className="note">{copy.common.loading}</p>}
				{status === "ready" && candidates.length === 0 && <p className="note">{t.noCandidates}</p>}
				<div className="pick-list" role="radiogroup" aria-label={t.pickList(channel)}>
					{candidates.map((member) => (
						<button
							key={member.person.id}
							type="button"
							className="pick"
							role="radio"
							aria-checked={picked?.person.id === member.person.id}
							onClick={() => setPicked(member)}
						>
							<ChatAvatar id={member.person.id} name={member.person.name} />
							<span>
								<b>{member.person.name}</b>
								<small>{member.person.username === "" ? t.pickRole(channel) : `@${member.person.username} · ${t.pickRole(channel)}`}</small>
							</span>
							<span className="tick">
								<Icon name="check" />
							</span>
						</button>
					))}
				</div>
				<p className="note">
					<Icon name="info" />
					<span>{t.pickNote(channel)}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onBack}>
					{copy.common.back}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={picked === null || busy} onClick={grant}>
					{t.grant}
				</button>
			</div>
		</Modal>
	);
}

/** Host of the text a message shows for a link, when that text looks like an address ("" otherwise). */
function shownHost(text: string): string {
	const trimmed = text.trim();
	if (!/^(https?:\/\/)?[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+([/?#:].*)?$/u.test(trimmed)) return "";
	return hostOf(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).toLowerCase();
}

/** The address with its host in bold (the part people check). */
function UrlBox({ url }: { url: string }) {
	const host = hostOf(url);
	const at = host === "" ? -1 : url.indexOf(host);
	if (at < 0) return <div className="url-box">{url}</div>;
	return (
		<div className="url-box">
			{url.slice(0, at)}
			<b>{host}</b>
			{url.slice(at + host.length)}
		</div>
	);
}

/** Confirmation before opening a link off the tenant's sites (#external-link). */
export function LinkDialog({ url, text, fromId, onClose }: CloseProps & { url: string; text: string; fromId: number }) {
	const copy = useScreensCopy();
	const { store, toasts } = useServices();
	const sender = useUser(fromId === store.selfId ? 0 : fromId);
	const id = useDomId("link");
	const domain = orgDomain(window.location.host);
	const claimed = shownHost(text);
	const mismatch = claimed !== "" && claimed.replace(/^www\./, "") !== hostOf(url).toLowerCase().replace(/^www\./, "");
	const t = copy.link;
	const open = () => {
		window.open(url, "_blank", "noopener,noreferrer");
		onClose();
	};
	if (mismatch) {
		return (
			<Modal labelledBy={id} onClose={onClose}>
				<DialogHead id={id} title={t.mismatchTitle} onClose={onClose} />
				<div className="dlg-body stack">
					<div className="field">
						<span className="label">{t.shown}</span>
						<div className="url-box">{text}</div>
					</div>
					<div className="field">
						<span className="label">{t.real}</span>
						<UrlBox url={url} />
					</div>
					<p className="note warn">
						<Icon name="alert-triangle" />
						<span>{t.mismatchNote(claimed)}</span>
					</p>
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={open}>
						{t.openAnyway}
					</button>
					<button type="button" className="btn btn-primary" onClick={onClose}>
						{copy.common.cancel}
					</button>
				</div>
			</Modal>
		);
	}
	const name = fromId === 0 ? "" : userName(sender, store.selfId, copy, fromId);
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.title} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="dlg-lede">{name === "" ? t.ledePlain(domain) : t.lede(name, domain)}</p>
				<UrlBox url={url} />
				<p className="note">
					<Icon name="shield" />
					<span>{t.note(domain)}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button
					type="button"
					className="btn"
					onClick={() => {
						void copyText(url).then((ok) => toasts.show(ok ? t.copied : copy.common.failed));
					}}
				>
					{t.copy}
				</button>
				<button type="button" className="btn btn-primary" onClick={open}>
					<Icon name="external" />
					{t.open}
				</button>
			</div>
		</Modal>
	);
}

const REASONS: readonly ReportReason[] = ["spam", "scam", "violence", "sexual", "other"];

interface ReportProps extends CloseProps {
	target: ReportTarget;
	name: string;
	blockUserId: number;
}

export function ReportDialog({ target, name, blockUserId, onClose }: ReportProps) {
	const copy = useScreensCopy();
	const { backend, remote, toasts } = useServices();
	const [reason, setReason] = useState<ReportReason | null>(null);
	const [note, setNote] = useState("");
	const [block, setBlock] = useState(true);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<{ blocked: boolean } | null>(null);
	const id = useDomId("report");
	const hints: Record<ReportReason, string> = {
		spam: copy.report.spamHint,
		scam: copy.report.scamHint,
		violence: copy.report.violenceHint,
		sexual: "",
		other: copy.report.otherHint,
	};
	const title =
		target.kind === "message" ? copy.report.messageTitle : target.kind === "user" ? copy.report.userTitle(name) : copy.report.chatTitle(name);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (reason === null) return;
		setBusy(true);
		try {
			await backend.report(target, reason, note.trim());
			const blocked = block && blockUserId !== 0 ? await remote.block(blockUserId).then(() => true, () => false) : false;
			setDone({ blocked });
		} catch {
			toasts.show(copy.common.failed);
		} finally {
			setBusy(false);
		}
	};

	if (done !== null) {
		return (
			<Modal labelledBy={id} onClose={onClose}>
				<div className="done">
					<span className="done-mark">
						<Icon name="check" />
					</span>
					<h2 id={id}>{copy.report.doneTitle}</h2>
					<p className="muted">{copy.report.doneBody(window.location.hostname.replace(/^chat\./, ""))}</p>
					{done.blocked && <p className="muted">{copy.report.doneBlocked(name)}</p>}
					<button type="button" className="btn btn-primary" onClick={onClose}>
						{copy.common.done}
					</button>
				</div>
			</Modal>
		);
	}

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<form onSubmit={(event) => void submit(event)}>
				<DialogHead id={id} title={title} onClose={onClose} />
				<div className="dlg-body flow">
					{target.kind === "message" && <ReportQuote chatId={target.chatId} seq={target.seq} />}
					<fieldset className="opts">
						<legend>{copy.report.reason}</legend>
						{REASONS.map((value) => (
							<label className="opt" key={value}>
								<input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} />
								<span>
									{copy.report[value]}
									{hints[value] !== "" && <small>{hints[value]}</small>}
								</span>
							</label>
						))}
					</fieldset>
					<div className="field">
						<label htmlFor={`${id}-note`}>
							{copy.report.note} <span className="muted">{copy.report.optional}</span>
						</label>
						<textarea
							id={`${id}-note`}
							className="input"
							rows={2}
							maxLength={500}
							placeholder={copy.report.notePlaceholder}
							value={note}
							onChange={(event) => setNote(event.target.value)}
						/>
					</div>
					{blockUserId !== 0 && (
						<label className="opt check">
							<input type="checkbox" checked={block} onChange={(event) => setBlock(event.target.checked)} />
							<span>{copy.report.alsoBlock(name)}</span>
						</label>
					)}
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className="btn btn-primary" disabled={reason === null || busy} aria-busy={busy}>
						{copy.report.submit}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function ReportQuote({ chatId, seq }: { chatId: number; seq: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { store } = useServices();
	const message = useMessage(chatId, seq);
	const author = useUser(message != null ? message.fromId : 0);
	if (message == null) return null;
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	return (
		<blockquote className="quote report-quote">
			<b>
				{author?.name ?? copy.message.unknownUser} · {clock(message.date, locale)}
			</b>
			{messagePreview(message, nameOf, copy)}
		</blockquote>
	);
}

export function ProfileDialog({ userId, onClose }: CloseProps & { userId: number }) {
	const copy = useScreensCopy();
	const { remote, backend, store, toasts } = useServices();
	const ui = useUi();
	const user = useUser(userId);
	const presence = usePresence(user?.isBot === true ? 0 : userId);
	const presenceLabel = usePresenceText(presence, copy);
	const [blocked, setBlocked] = useState<boolean | null>(null);
	const [opening, setOpening] = useState(false);
	const id = useDomId("profile");
	const self = userId === store.selfId;
	const name = user?.name ?? copy.message.unknownUser;
	const isBlocked = blocked ?? user?.isBlocked ?? false;
	const message = () => {
		setOpening(true);
		remote.createPrivate(userId).then(
			(chatId) => {
				onClose();
				navigate(paths.chat(chatId));
			},
			() => {
				setOpening(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	const toggleBlock = () => {
		const next = !isBlocked;
		(next ? remote.block(userId) : remote.unblock(userId)).then(
			() => {
				setBlocked(next);
				toasts.show(next ? copy.info.blocked(name) : copy.info.unblocked(name));
			},
			() => toasts.show(copy.common.failed),
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<DialogHead id={id} title={user === undefined ? copy.profile.title : copy.profile.titleOf(name)} onClose={onClose} />
			<div className="hero">
				<ChatAvatar id={userId} name={name} size="lg" bot={user?.isBot === true} />
				<h2>{self ? `${name} (${copy.common.you})` : name}</h2>
				<p>{user?.isBot === true ? copy.info.bot : presenceLabel}</p>
			</div>
			{!self && (
				<div className="profile-actions">
					<button type="button" className="btn btn-primary" aria-busy={opening} disabled={opening} onClick={message}>
						<Icon name="message" />
						{copy.info.message}
					</button>
					<button type="button" className="btn" onClick={toggleBlock}>
						<Icon name="ban" />
						{isBlocked ? copy.info.unblock : copy.info.block}
					</button>
					{backend.features.has("report") && (
						<button
							type="button"
							className="btn danger-text"
							onClick={() => ui.dialog.set({ kind: "report", target: { kind: "user", userId }, name, blockUserId: userId })}
						>
							<Icon name="flag" />
							{copy.info.report}
						</button>
					)}
				</div>
			)}
			{!self && user !== undefined && !user.isBot && (
				<div className="profile-sec">
					<ContactRow userId={userId} name={name} />
				</div>
			)}
			<div className="info-sec">
				{user !== undefined && user.username !== "" && (
					<div className="row">
						<Icon name="user" />
						<span className="grow">
							@{user.username}
							<small>{copy.info.username}</small>
						</span>
						<CopyButton text={`@${user.username}`} label={copy.info.copyUsername} copiedLabel={copy.info.copiedUsername(user.username)} />
					</div>
				)}
				{user !== undefined && user.bio !== "" && (
					<div className="row">
						<Icon name="info" />
						<span className="grow">
							{user.bio}
							<small>{copy.info.bio}</small>
						</span>
					</div>
				)}
			</div>
		</Modal>
	);
}

/** Who read your message (mockups/chat.html#read-by): small groups, recent messages. */
export function ReadByDialog({ chatId, seq, onClose }: CloseProps & { chatId: number; seq: number }) {
	const copy = useScreensCopy();
	const { remote } = useServices();
	const chat = useChat(chatId);
	const { locale } = useI18n();
	const [readers, setReaders] = useState<readonly Reader[] | null | "unavailable">(null);
	const id = useDomId("readby");
	useEffect(() => {
		let active = true;
		remote.readers(chatId, seq).then(
			(people) => {
				if (active) setReaders(people);
			},
			() => {
				if (active) setReaders("unavailable");
			},
		);
		return () => {
			active = false;
		};
	}, [remote, chatId, seq]);
	const list = readers === null || readers === "unavailable" ? [] : readers;
	const others = Math.max(0, (chat?.memberCount ?? 0) - 1 - list.length);
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={readers === null || readers === "unavailable" ? copy.readBy.title : copy.readBy.titleCount(list.length)} onClose={onClose} />
			<div className="dlg-body stack">
				<Quote chatId={chatId} seq={seq} />
				{readers === null && <p className="note">{copy.common.loading}</p>}
				{readers === "unavailable" && (
					<p className="note">
						<Icon name="info" />
						<span>{copy.readBy.unavailable}</span>
					</p>
				)}
				{list.length > 0 && (
					<div>
						{list.map(({ person, readAt }) => (
							<div className="row" key={person.id}>
								<ChatAvatar id={person.id} name={person.name} size="sm" bot={person.isBot} />
								<span className="grow">{person.name}</span>
								{readAt > 0 && <span className="role">{clock(readAt, locale)}</span>}
							</div>
						))}
					</div>
				)}
				{readers !== null && readers !== "unavailable" && (
					<p className="note">
						<Icon name="users" />
						<span>{list.length === 0 ? copy.readBy.none : copy.readBy.unread(others)}</span>
					</p>
				)}
			</div>
		</Modal>
	);
}

// Confirmation and detail dialogs: unsending and deleting a message for
// yourself (mockups #delete), external link (#external-link), report
// (settings.html#report), another user's profile (#user-profile) and who has
// seen a message (#read-by). Chat-level dialogs (leave, delete chat, pin,
// reactions) are in chat-dialogs.tsx.
import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { MiddleTruncate } from "../../components/middle-truncate.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { clock, dialogTitle, hostOf, messagePreview, namedUserIds, orgDomain, userName } from "../data/format.ts";
import type { ReportReason, ReportTarget } from "../data/pending-backend.ts";
import type { Reader } from "../data/remote.ts";
import { useChat, useMessage, useServices, useUser } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { CommonChatsSection } from "./common-chats.tsx";
import { ContactRow } from "./contact-row.tsx";
import { Glyph } from "./glyphs.tsx";
import { ChatAvatar, copyText, CopyButton, DialogHead, Modal, useDomId } from "./parts.tsx";
import { usePresence, usePresenceText } from "./presence.tsx";
import { useUi } from "./ui-context.tsx";
import { usePrivateChatFailure } from "./private-chat-failure.ts";

interface CloseProps {
	onClose: () => void;
}

/** The message a dialog acts on: author, time and a one-line preview. */
export function Quote({ chatId, seq, className = "quote" }: { chatId: number; seq: number; className?: string }) {
	const { locale } = useI18n();
	const message = useMessage(chatId, seq);
	const channel = useChat(chatId)?.type === "channel";
	const copy = useScreensCopy();
	const nameOf = useNameOf(message == null ? [] : namedUserIds(message));
	if (message == null) return null;
	return (
		<div className={className}>
			<b>
				{nameOf(message.fromId)} · {clock(message.date, locale)}
			</b>
			{messagePreview(message, nameOf, copy, channel)}
		</div>
	);
}

/**
 * "Thu hồi" removes your message for everyone; "Xoá ở phía tôi" hides any
 * message on your devices only (#delete).
 */
export function DeleteDialog({ chatId, seq, recall, onClose }: CloseProps & { chatId: number; seq: number; recall: boolean }) {
	const copy = useScreensCopy();
	const { source, store, toasts } = useServices();
	const chat = useChat(chatId);
	const peer = useUser(chat?.type === "private" ? chat.peerUserId : 0);
	const message = useMessage(chatId, seq);
	const mine = message != null && message.fromId === store.selfId;
	const author = useUser(message != null && !mine ? message.fromId : 0);
	const [busy, setBusy] = useState(false);
	const id = useDomId("del");
	const t = copy.deleteDialog;
	const chatTitle = chat == null ? "" : dialogTitle({ chat, peer: peer ?? null }, copy);
	const authorName = author?.name ?? copy.message.unknownUser;
	const remove = (forEveryone: boolean) => {
		setBusy(true);
		source.deleteMessages(chatId, [seq], forEveryone).then(
			() => {
				toasts.show(forEveryone ? t.recalled : t.hidden);
				onClose();
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	const title = recall ? t.recallTitle : mine ? t.forMeTitle : t.theirsTitle(authorName);
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={title} onClose={onClose} />
			<div className="dlg-body stack">
				<Quote chatId={chatId} seq={seq} />
				{recall ? (
					<p className="note">
						<Glyph name="refresh" />
						<span>{t.recallNote(chatTitle)}</span>
					</p>
				) : (
					<p className="note">
						<Icon name="eye-off" />
						<span>
							{t.onlyMeNote}
							{!mine && message != null && ` ${t.onlyAuthor(authorName)}`}
						</span>
					</p>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				{recall ? (
					<>
						<button type="button" className="btn" disabled={busy} onClick={() => remove(false)}>
							{t.deleteForMe}
						</button>
						<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={() => remove(true)}>
							{t.recall}
						</button>
					</>
				) : (
					<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={() => remove(false)}>
						{t.deleteForMe}
					</button>
				)}
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
		const blockAfter = block && blockUserId !== 0;
		const reportAndBlock = async () => {
			await backend.report(target, reason, note.trim());
			return blockAfter ? remote.block(blockUserId).then(() => true, () => false) : false;
		};
		try {
			setDone({ blocked: await reportAndBlock() });
		} catch {
			toasts.show(copy.common.failed);
		}
		setBusy(false);
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
					{target.kind === "message" && <Quote chatId={target.chatId} seq={target.seq} className="quote report-quote" />}
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
	const privateChatFailed = usePrivateChatFailure();
	const message = () => {
		setOpening(true);
		remote.createPrivate(userId).then(
			(chatId) => {
				onClose();
				navigate(paths.chat(chatId));
			},
			(err: unknown) => {
				setOpening(false);
				privateChatFailed(err, userId);
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
							<MiddleTruncate text={`@${user.username}`} tail={4} />
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
				{!self && user !== undefined && !user.isBot && (
					<button type="button" className="row link-row" onClick={() => ui.dialog.set({ kind: "newGroup", withUserId: userId })}>
						<Icon name="users" />
						<span className="grow">{copy.profile.createGroupWith(name)}</span>
						<Icon name="chevron-right" small />
					</button>
				)}
			</div>
			{!self && user !== undefined && <CommonChatsSection userId={userId} bot={user.isBot} />}
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
								<ChatAvatar id={person.id} name={person.name} photoOf={person.id} photoId={person.photoId} size="sm" bot={person.isBot} />
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

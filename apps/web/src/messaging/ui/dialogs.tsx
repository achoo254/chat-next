// Confirmation and detail dialogs: delete (mockups #delete), leave, external
// link, report (settings.html#report) and another user's profile
// (#user-profile).
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { clock, dialogTitle, hostOf, messagePreview, userName } from "../data/format.ts";
import type { ReportReason, ReportTarget } from "../data/pending-backend.ts";
import type { Person } from "../data/remote.ts";
import { useChat, useMessage, useServices, useUser } from "../data/services.tsx";
import { ChatAvatar, CopyButton, DialogHead, Modal, useDomId } from "./parts.tsx";
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

export function LeaveDialog({ chatId, onClose }: CloseProps & { chatId: number }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const chat = useChat(chatId);
	const [busy, setBusy] = useState(false);
	const id = useDomId("leave");
	const title = chat?.title ?? "";
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
				// The owner of a group or channel leaves only after naming another admin.
				toasts.show(ConnectError.from(err).code === Code.FailedPrecondition ? copy.info.ownerMustHandOver : copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.info.leaveTitle(title)} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="note">
					<Icon name="info" />
					<span>{copy.info.leaveNote}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={leave}>
					{chat?.type === "channel" ? copy.info.leaveChannel : copy.info.leaveGroup}
				</button>
			</div>
		</Modal>
	);
}

export function LinkDialog({ url, onClose }: CloseProps & { url: string }) {
	const copy = useScreensCopy();
	const id = useDomId("link");
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.message.openLinkTitle} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="note warn">
					<Icon name="alert-triangle" />
					<span>{copy.message.openLinkBody(hostOf(url))}</span>
				</p>
				<span className="link-mono">{url}</span>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button
					type="button"
					className="btn btn-primary"
					onClick={() => {
						window.open(url, "_blank", "noopener,noreferrer");
						onClose();
					}}
				>
					{copy.message.openLink}
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
			<DialogHead id={id} title={copy.profile.title} onClose={onClose} />
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
	const [readers, setReaders] = useState<readonly Person[] | null | "unavailable">(null);
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
						{list.map((person) => (
							<div className="row" key={person.id}>
								<ChatAvatar id={person.id} name={person.name} size="sm" bot={person.isBot} />
								<span className="grow">{person.name}</span>
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

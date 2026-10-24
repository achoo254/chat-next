// Chat-level dialogs: leaving, with the owner picking who takes over
// (mockups/chat.html#group-owner-leave, #channel-owner-leave); deleting a
// chat (#delete-chat: a private chat for you, a group or channel for everyone
// after typing its name); pinning a message (#pin-message, with "Thông báo
// cho mọi thành viên"); and who reacted to a message (#rich-messages).
// Groups say "Trưởng nhóm / Phó nhóm", channels "Chủ kênh / Admin".
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useState } from "react";
import type { Chat } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { isSavedChat } from "../data/format.ts";
import type { Member, Reactor } from "../data/remote.ts";
import { useChat, useDialog, useMessage, useServices, useUser } from "../data/services.tsx";
import { Quote } from "./dialogs.tsx";
import { Glyph } from "./glyphs.tsx";
import { useMembers } from "./members.ts";
import { ChatAvatar, DialogHead, Modal, useDomId } from "./parts.tsx";
import { presenceText } from "./presence.tsx";
import { useUi } from "./ui-context.tsx";

interface CloseProps {
	onClose: () => void;
}

/** LeaveChat's answer when an owner would leave members behind without an admin. */
function ownerNeedsAdmin(err: unknown): boolean {
	const error = ConnectError.from(err);
	return error.code === Code.FailedPrecondition && error.rawMessage.startsWith("owner_needs_admin");
}

/** After leaving or deleting, the chat is gone: leave its screen. */
function leaveChatScreen(chatId: number): void {
	if (window.location.pathname.startsWith(paths.chat(chatId))) navigate(paths.home);
}

export function LeaveDialog({ chatId, onClose }: CloseProps & { chatId: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, store, toasts } = useServices();
	const ui = useUi();
	const chat = useChat(chatId);
	const [view, setView] = useState<"confirm" | "blocked" | "pick">("confirm");
	const [heirId, setHeirId] = useState(0);
	const [busy, setBusy] = useState(false);
	const owner = chat?.myRole === "owner";
	const channel = chat?.type === "channel";
	const { members, status, hasMore, reload } = useMembers(chatId, "", owner);
	const id = useDomId("leave");
	const title = chat?.title ?? "";
	const t = copy.ownerLeave;
	const heirs = members.filter((member) => member.role === "admin" && member.person.id !== store.selfId);
	const heir = heirs.find((member) => member.person.id === heirId) ?? heirs[0];
	// No admin on a complete member list: the owner must appoint one or delete the chat first.
	const noHeir = owner && status === "ready" && heirs.length === 0 && !hasMore;

	const leave = () => {
		setBusy(true);
		const newOwner = owner ? (heir?.person.id ?? 0) : 0;
		remote.leaveChat(chatId, newOwner).then(
			() => {
				toasts.show(owner && heir !== undefined ? t.transferred(heir.person.name, title, channel) : copy.info.left(title));
				onClose();
				leaveChatScreen(chatId);
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
	if (view === "blocked" || noHeir) {
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
				{channel && (
					<div className="dlg-body stack">
						<p className="note warn">
							<Icon name="alert-triangle" />
							<span>{t.deleteWarn(chat?.memberCount ?? 0, channel)}</span>
						</p>
					</div>
				)}
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="button" className="btn danger-text" onClick={() => ui.dialog.set({ kind: "deleteChat", chatId })}>
						{copy.info.deleteGroup(channel)}
					</button>
					<button type="button" className="btn btn-primary" onClick={() => setView("pick")}>
						<Icon name="user-plus" />
						{t.pickAdmin(channel)}
					</button>
				</div>
			</Modal>
		);
	}
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.info.leaveTitle(title, channel)} onClose={onClose} />
			<div className="dlg-body stack">
				{owner ? (
					<>
						<p className="note">
							<Glyph name="crown" />
							<span>{t.transferNote(channel)}</span>
						</p>
						{status === "loading" && <p className="note">{copy.common.loading}</p>}
						{heirs.length > 0 && (
							<div className="pick-list" role="radiogroup" aria-label={t.heirs(channel)}>
								{heirs.map((member) => (
									<button
										key={member.person.id}
										type="button"
										className="pick"
										role="radio"
										aria-checked={heir?.person.id === member.person.id}
										onClick={() => setHeirId(member.person.id)}
									>
										<ChatAvatar id={member.person.id} name={member.person.name} photoOf={member.person.id} photoId={member.person.photoId} />
										<span>
											<b>{member.person.name}</b>
											<small>
												{copy.info.admin(channel)} · {presenceText(member.person.presence, copy, locale)}
											</small>
										</span>
										<span className="tick">
											<Icon name="check" />
										</span>
									</button>
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
						<span>{copy.info.leaveNote(channel)}</span>
					</p>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy || (owner && status !== "ready")} onClick={leave}>
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

/** Makes a member a deputy (admin) so the owner can hand the chat over. */
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
				{status === "ready" && candidates.length === 0 && <p className="note">{t.noCandidates(channel)}</p>}
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
							<ChatAvatar id={member.person.id} name={member.person.name} photoOf={member.person.id} photoId={member.person.photoId} />
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
					{t.grant(channel)}
				</button>
			</div>
		</Modal>
	);
}

/** Deletes a private chat for you, or (owner) a group or channel for everyone after typing its name. */
export function DeleteChatDialog({ chatId, onClose }: CloseProps & { chatId: number }) {
	const chat = useChat(chatId);
	const peer = useUser(chat?.type === "private" ? chat.peerUserId : 0);
	if (chat == null) return null;
	if (chat.type === "group" || chat.type === "channel") return <DeleteGroup chat={chat} onClose={onClose} />;
	return isSavedChat(chat, peer) ? <ClearSaved chat={chat} onClose={onClose} /> : <DeletePrivate chat={chat} onClose={onClose} />;
}

/** "Cloud của tôi" (mockups/chat.html#delete-chat): every message goes on all your devices; the chat stays. */
function ClearSaved({ chat, onClose }: CloseProps & { chat: Chat }) {
	const copy = useScreensCopy();
	const id = useDomId("clear-saved");
	const t = copy.deleteChat;
	const { busy, run } = useDelete(chat.id, t.savedDone, onClose, false);
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.savedTitle} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="note">
					<Icon name="trash" />
					<span>{t.savedNote}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={run}>
					{t.savedAction}
				</button>
			</div>
		</Modal>
	);
}

/** `leave` false keeps the chat open (clearing "Cloud của tôi" leaves an empty chat, not a gone one). */
function useDelete(chatId: number, done: string, onClose: () => void, leave = true): { busy: boolean; run: () => void } {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [busy, setBusy] = useState(false);
	const run = () => {
		setBusy(true);
		remote.deleteChat(chatId).then(
			() => {
				toasts.show(done);
				onClose();
				if (leave) leaveChatScreen(chatId);
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return { busy, run };
}

function DeletePrivate({ chat, onClose }: CloseProps & { chat: Chat }) {
	const copy = useScreensCopy();
	const peer = useUser(chat.peerUserId);
	const id = useDomId("delete-chat");
	const t = copy.deleteChat;
	const name = peer?.name ?? copy.message.unknownUser;
	const { busy, run } = useDelete(chat.id, t.deletedPrivate(name), onClose);
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.privateTitle(name)} onClose={onClose} />
			<div className="dlg-body stack">
				<div className="result">
					<ChatAvatar id={chat.peerUserId} name={name} bot={peer?.isBot === true} />
					<span>
						<b>{name}</b>
						{peer !== undefined && peer.username !== "" && <small>@{peer.username}</small>}
					</span>
				</div>
				<p className="note">
					<Icon name="eye-off" />
					<span>{t.privateNote(name)}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={run}>
					{t.deletePrivate}
				</button>
			</div>
		</Modal>
	);
}

function DeleteGroup({ chat, onClose }: CloseProps & { chat: Chat }) {
	const copy = useScreensCopy();
	const [typed, setTyped] = useState("");
	const id = useDomId("delete-group");
	const t = copy.deleteChat;
	const channel = chat.type === "channel";
	const { busy, run } = useDelete(chat.id, t.deletedGroup(chat.title, channel), onClose);
	const confirmed = typed.trim() === chat.title.trim() && chat.title.trim() !== "";
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.groupTitle(chat.title, channel)} onClose={onClose} />
			<div className="dlg-body stack">
				<ul className="effects">
					<li>
						<Icon name="users" />
						<span>{t.goneForAll(chat.memberCount, channel)}</span>
					</li>
					<li>
						<Icon name="trash" />
						<span>{t.contentGone(channel)}</span>
					</li>
					<li>
						<Icon name="link" />
						<span>{t.linksGone}</span>
					</li>
				</ul>
				<div className="field">
					<label htmlFor={`${id}-confirm`}>
						{t.typeBefore} <b>{chat.title}</b> {t.typeAfter}
					</label>
					<input id={`${id}-confirm`} className="input" autoComplete="off" spellCheck={false} value={typed} onChange={(event) => setTyped(event.target.value)} />
				</div>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={!confirmed || busy} onClick={run}>
					{t.deleteGroup(channel)}
				</button>
			</div>
		</Modal>
	);
}

/** Pins a message in a group or channel, notifying everyone or quietly (PinMessage.silent). */
export function PinDialog({ chatId, seq, onClose }: CloseProps & { chatId: number; seq: number }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const chat = useChat(chatId);
	const pinnedCount = useDialog(chatId)?.dialog.pinnedMessageCount ?? 0;
	const [notify, setNotify] = useState(true);
	const [busy, setBusy] = useState(false);
	const id = useDomId("pin");
	const t = copy.pinDialog;
	const channel = chat?.type === "channel";
	const pin = () => {
		setBusy(true);
		remote.pin(chatId, seq, notify).then(
			() => {
				toasts.show(copy.menu.pinned);
				onClose();
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<DialogHead id={id} title={t.title} onClose={onClose} />
			<div className="dlg-body stack">
				<Quote chatId={chatId} seq={seq} />
				<button type="button" className="check-row" role="checkbox" aria-checked={notify} onClick={() => setNotify((on) => !on)}>
					<span className="tick sq">
						<Icon name="check" />
					</span>
					{channel ? t.notifyChannel : t.notify}
				</button>
				{chat != null && (pinnedCount > 0 || chat.pinnedSeq !== 0) && (
					<p className="note">
						<Icon name="pin" />
						<span>{t.replaces(chat.title, Math.max(pinnedCount, 1))}</span>
					</p>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={pin}>
					{t.pin}
				</button>
			</div>
		</Modal>
	);
}

type ReactorsState = { readonly status: "loading" } | { readonly status: "error" } | { readonly status: "ready"; readonly items: readonly Reactor[]; readonly cursor: string };

/** Who reacted to a message, per emoji (GetMessageReactions). */
export function ReactorsDialog({ chatId, seq, emoji, onClose }: CloseProps & { chatId: number; seq: number; emoji: string }) {
	const copy = useScreensCopy();
	const { remote, store, toasts } = useServices();
	const message = useMessage(chatId, seq);
	const [filter, setFilter] = useState(emoji);
	const [state, setState] = useState<ReactorsState & { key: string }>({ status: "loading", key: "" });
	const id = useDomId("reactors");
	const t = copy.reactors;
	const key = `${chatId}:${seq}:${filter}`;
	const reactions = message?.reactions ?? [];
	const total = reactions.reduce((sum, reaction) => sum + reaction.count, 0);

	useEffect(() => {
		let active = true;
		remote.reactions(chatId, seq, filter).then(
			(page) => {
				if (active) setState({ status: "ready", items: page.items, cursor: page.nextCursor, key });
			},
			() => {
				if (active) setState({ status: "error", key });
			},
		);
		return () => {
			active = false;
		};
	}, [remote, chatId, seq, filter, key]);

	const current: ReactorsState = state.key === key ? state : { status: "loading" };
	const more = () => {
		if (current.status !== "ready" || current.cursor === "") return;
		remote.reactions(chatId, seq, filter, current.cursor).then(
			(page) =>
				setState((previous) =>
					previous.key !== key || previous.status !== "ready" ? previous : { ...previous, items: [...previous.items, ...page.items], cursor: page.nextCursor },
				),
			() => toasts.show(copy.common.failed),
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<DialogHead id={id} title={t.title} onClose={onClose} />
			<div className="dlg-body stack">
				<div className="react-tabs" role="group" aria-label={t.filter}>
					<button type="button" className="reaction" aria-pressed={filter === ""} onClick={() => setFilter("")}>
						{t.all(total)}
					</button>
					{reactions.map((reaction) => (
						<button key={reaction.emoji} type="button" className="reaction" aria-pressed={filter === reaction.emoji} onClick={() => setFilter(reaction.emoji)}>
							{reaction.emoji} {reaction.count}
						</button>
					))}
				</div>
				{current.status === "loading" && <p className="note">{copy.common.loading}</p>}
				{current.status === "error" && (
					<p className="note">
						<Icon name="users" />
						<span>{t.unavailable}</span>
					</p>
				)}
				{current.status === "ready" && current.items.length === 0 && <p className="note">{t.none}</p>}
				{current.status === "ready" && current.items.length > 0 && (
					<div>
						{current.items.map((reactor) => {
							const self = reactor.person.id === store.selfId;
							return (
								<div className="row" key={`${reactor.person.id}:${reactor.emoji}`}>
									<ChatAvatar id={reactor.person.id} name={reactor.person.name} photoOf={reactor.person.id} photoId={reactor.person.photoId} size="sm" bot={reactor.person.isBot} />
									<span className="grow">
										{self ? copy.common.you : reactor.person.name}
										{self && <small>{t.tap}</small>}
									</span>
									<span className="react-emoji">{reactor.emoji}</span>
								</div>
							);
						})}
						{current.cursor !== "" && (
							<button type="button" className="see-all" onClick={more}>
								{t.more}
							</button>
						)}
					</div>
				)}
			</div>
		</Modal>
	);
}

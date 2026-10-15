// Right column (mockups/chat.html#info-panels, #topics): group or channel,
// the other person of a 1-1 chat, a bot, or the open topic, in the order
// people know from Zalo: picture, name, status and description; three quick
// actions (Tắt thông báo · Ghim · Thêm thành viên / Tạo nhóm); members with
// "Xem tất cả"; invite link; Quản lý; leave, delete and report. Opened with
// the "i" button, closed with X; an overlay below 1100px takes focus when it
// opens (#info-overlay), and below 760px it fills the screen with a back
// arrow (#narrow). "Ảnh, file, link" lists the kinds of shared media the
// chat has and opens them in the column, one tab per kind (R3).
import { PINNED_DIALOGS_MAX, type Chat, type User } from "@app/core";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import type { SharedTab } from "../media/shared-media.tsx";
import { Icon } from "../../components/icon.tsx";
import { MiddleTruncate } from "../../components/middle-truncate.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { dialogTitle, isSavedChat, shortDate, userName } from "../data/format.ts";
import type { Topic } from "../data/pending-backend.ts";
import { Permission, type MuteFor } from "../data/remote.ts";
import { useDialog, useListEntry, useServices, useUser } from "../data/services.tsx";
import { CommonChatsSection } from "./common-chats.tsx";
import { ContactRow } from "./contact-row.tsx";
import { hiddenPins, usePinHidden } from "./pinned-bar.tsx";
import { MuteDurations, pinLimitReached, useMute } from "./dialog-settings.tsx";
import { displayLink, inviteLinks, isActiveInvite, useInviteLinks, useMembers, useOnlineCount } from "./members.ts";
import { ChatAvatar, CopyButton, Switch } from "./parts.tsx";
import { usePresence, usePresenceText } from "./presence.tsx";
import { TopicIco } from "./topic-ico.tsx";
import { useUi, type Ui } from "./ui-context.tsx";

const sharedChunk = () => import("../media/shared-media.tsx");
const SharedMediaSection = lazy(() => sharedChunk().then((m) => ({ default: m.SharedMediaSection })));
const SharedMediaView = lazy(() => sharedChunk().then((m) => ({ default: m.SharedMediaView })));

/** Members shown in the column; "Xem tất cả" opens the rest. */
const MEMBERS_SHOWN = 5;
const WIDE_QUERY = "(min-width: 1101px)";
const NARROW_QUERY = "(max-width: 760px)";

function matches(query: string): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Between 760 and 1100px the column lays over the conversation (no media queries: beside it). */
function overlayLayout(): boolean {
	return typeof window.matchMedia === "function" && !matches(WIDE_QUERY) && !matches(NARROW_QUERY);
}

/** Whether the current history entry is the one pushed for the narrow column. */
function infoEntry(): boolean {
	const state: unknown = window.history.state;
	return typeof state === "object" && state !== null && "info" in state && state.info === true;
}

/** Closes the column; on narrow screens through history, so Back and the arrow agree. */
function closeInfo(ui: Ui, refocus: boolean): void {
	if (infoEntry()) window.history.back();
	else ui.toggleInfo(false);
	if (refocus) document.querySelector<HTMLElement>(".convo-head [data-info-toggle]")?.focus();
}

/**
 * Narrow screens give the column a history entry, so the browser's Back
 * closes it (#narrow). As an overlay, Esc or a click in the conversation
 * closes it and focus returns to the "i" button (#info-overlay).
 */
function useColumnBehaviour(ui: Ui): void {
	useEffect(() => {
		if (matches(NARROW_QUERY) && !infoEntry()) window.history.pushState({ info: true }, "");
		const onPop = () => {
			if (matches(NARROW_QUERY) && !infoEntry()) ui.toggleInfo(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || !overlayLayout()) return;
			if (document.querySelector("dialog[open], .ctx-layer") !== null) return;
			closeInfo(ui, true);
		};
		const onDown = (event: PointerEvent) => {
			if (!overlayLayout() || !(event.target instanceof Element)) return;
			if (event.target.closest(".app > .convo") !== null && event.target.closest("[data-info-toggle]") === null) closeInfo(ui, true);
		};
		window.addEventListener("popstate", onPop);
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown);
		return () => {
			window.removeEventListener("popstate", onPop);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown);
		};
	}, [ui]);
}

function InfoHead({ title }: { title: string }) {
	const copy = useScreensCopy();
	const ui = useUi();
	const back = useRef<HTMLButtonElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	// As an overlay or a full screen the column takes focus; beside the chat it does not.
	useEffect(() => {
		if (matches(NARROW_QUERY)) back.current?.focus();
		else if (overlayLayout()) close.current?.focus();
	}, []);
	return (
		<div className="info-head">
			<button ref={back} type="button" className="icon-btn narrow-only" aria-label={copy.infoPanel.backToChat} onClick={() => closeInfo(ui, false)}>
				<Icon name="back" />
			</button>
			<span>{title}</span>
			<button
				ref={close}
				type="button"
				className="icon-btn hide-narrow"
				aria-label={copy.infoPanel.closeEsc}
				onClick={() => closeInfo(ui, true)}
			>
				<Icon name="x" />
			</button>
		</div>
	);
}

/** Mute with a duration menu, or turn notifications back on (#info-panels quick actions). */
function MuteAction({ chatId, title }: { chatId: number; title: string }) {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const entry = useListEntry(chatId);
	const setMute = useMute(chatId, title);
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLDivElement>(null);
	const muted = entry?.muted === true;
	const run = (label: string, muteFor: MuteFor) => {
		setOpen(false);
		setMute(label, muteFor).then(
			(done) => toasts.show(done),
			() => toasts.show(copy.common.failed),
		);
	};
	return (
		<div className="qa-anchor" ref={anchor}>
			<button
				type="button"
				aria-pressed={muted}
				aria-haspopup={muted ? undefined : "menu"}
				aria-expanded={muted ? undefined : open}
				onClick={() => (muted ? run("", 0) : setOpen((on) => !on))}
			>
				<span className="qa-ico">
					<Icon name={muted ? "bell" : "bell-off"} />
				</span>
				<span className="qa-label">{muted ? copy.info.unmute : copy.info.mute}</span>
			</button>
			{open && (
				<MuteDurations
					boundary={anchor}
					className="qa-menu"
					onPick={run}
					onClose={() => {
						setOpen(false);
						anchor.current?.querySelector<HTMLElement>("button")?.focus();
					}}
				/>
			)}
		</div>
	);
}

/** Pin the chat on top of the list (at most PINNED_DIALOGS_MAX) or unpin it. */
function PinAction({ chatId, title }: { chatId: number; title: string }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const entry = useListEntry(chatId);
	const pinned = entry?.pinned === true;
	const toggle = () => {
		remote.setDialogPinned(chatId, !pinned).then(
			(ids) => toasts.show(pinned ? copy.listMenu.unpinned(title) : copy.listMenu.pinned(title, ids.length, PINNED_DIALOGS_MAX)),
			(err: unknown) => toasts.show(pinLimitReached(err) ? copy.listMenu.pinLimit(PINNED_DIALOGS_MAX) : copy.common.failed),
		);
	};
	return (
		<button type="button" aria-pressed={pinned} onClick={toggle}>
			<span className="qa-ico">
				<Icon name="pin" />
			</span>
			<span className="qa-label">{pinned ? copy.info.unpin : copy.info.pin}</span>
		</button>
	);
}

/** Three evenly shared quick actions: mute, pin and one that depends on the chat. */
/** `mute` false: "Cloud của tôi", whose messages are your own, has nothing to mute. */
function QuickActions({ chatId, title, children, mute = true }: { chatId: number; title: string; children?: ReactNode; mute?: boolean }) {
	const copy = useScreensCopy();
	return (
		<div className="quick-acts" role="group" aria-label={copy.info.quickActions}>
			{mute && <MuteAction chatId={chatId} title={title} />}
			<PinAction chatId={chatId} title={title} />
			{children}
		</div>
	);
}

function PinnedBarRow({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const hidden = usePinHidden(chat.id);
	const top = (useDialog(chat.id)?.dialog.pinnedMessageSeq ?? 0) || chat.pinnedSeq;
	// Forum groups hide the bar of a topic, whose newest pin the dialog does not name.
	if (hidden === 0 || (!chat.forum && hidden !== top)) return null;
	return (
		<div className="info-sec">
			<div className="row">
				<Icon name="pin" />
				<span className="grow">{copy.info.pinnedBar}</span>
				<Switch checked={false} label={copy.pinned.show} onChange={() => hiddenPins.set(chat.id, 0)} />
			</div>
		</div>
	);
}

function InviteRow({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const invites = useInviteLinks(chat.id);
	const [busy, setBusy] = useState(false);
	const [now] = useState(Date.now);
	const invite = invites.find((item) => isActiveInvite(item, now));
	if (invite !== undefined) {
		return (
			<div className="row">
				<Icon name="link" />
				<span className="grow">
					<MiddleTruncate className="value" text={displayLink(invite.link)} />
					<small>{invite.expiresAt === 0 ? copy.info.inviteNoExpiry : copy.info.inviteExpires(shortDate(invite.expiresAt, locale))}</small>
				</span>
				<CopyButton text={invite.link} label={copy.info.copyInvite} copiedLabel={copy.info.copiedInvite} />
			</div>
		);
	}
	return (
		<div className="row">
			<Icon name="link" />
			<span className="grow">{copy.info.inviteLink}</span>
			<button
				type="button"
				className="btn btn-sm"
				aria-busy={busy}
				disabled={busy}
				onClick={() => {
					setBusy(true);
					remote
						.exportInvite(chat.id, 0, 0)
						.then(
							(created) => inviteLinks.add(chat.id, created),
							() => toasts.show(copy.common.failed),
						)
						.finally(() => setBusy(false));
				}}
			>
				{copy.info.createInvite}
			</button>
		</div>
	);
}

/** The first members with "Xem tất cả" (#info-panels): the full list opens in a dialog with search. */
function GroupMembers({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const channel = chat.type === "channel";
	const { store } = useServices();
	const ui = useUi();
	const { members, status } = useMembers(chat.id);
	const shown = members.slice(0, MEMBERS_SHOWN);
	return (
		<div className="info-sec">
			<div className="sec-head">
				<h3>{copy.info.membersHead(chat.memberCount, channel)}</h3>
				{/* Kept while the list reloads, so it stays where focus returns from the dialog. */}
				{status !== "error" && (
					<button type="button" className="see-all" aria-label={copy.info.seeAllLabel(chat.memberCount, channel)} onClick={() => ui.dialog.set({ kind: "members", chatId: chat.id })}>
						{copy.info.seeAll}
					</button>
				)}
			</div>
			{status === "loading" && <p className="note">{copy.common.loading}</p>}
			{status === "error" && <p className="note">{copy.common.loadFailed}</p>}
			{shown.map((member) => {
				const self = member.person.id === store.selfId;
				return (
					<MemberLine
						key={member.person.id}
						userId={member.person.id}
						avatarName={member.person.name}
						name={self ? copy.common.you : member.person.name}
						isBot={member.person.isBot}
						role={member.role}
						channel={channel}
						presence={member.person.presence.kind === "online" || self}
					/>
				);
			})}
		</div>
	);
}

interface MemberLineProps {
	userId: number;
	/** The person's own name, for the initials ("Bạn" is shown as the label). */
	avatarName: string;
	name: string;
	isBot: boolean;
	role: string;
	/** Groups say "Trưởng nhóm / Phó nhóm", channels "Chủ kênh / Admin". */
	channel: boolean;
	presence: boolean;
}

function MemberLine({ userId, avatarName, name, isBot, role, channel, presence }: MemberLineProps) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { store } = useServices();
	const known = usePresence(isBot || userId === store.selfId ? 0 : userId);
	const text = usePresenceText(known, copy);
	const online = presence || known?.kind === "online";
	const label = isBot ? copy.info.bot : userId === store.selfId ? copy.info.online : text;
	return (
		<button type="button" className="row member-row" onClick={() => ui.dialog.set({ kind: "profile", userId })}>
			<ChatAvatar id={userId} name={avatarName} size="sm" bot={isBot} online={online && !isBot} />
			<span className="grow">
				{name}
				<small className={online && !isBot ? "on" : undefined}>{label}</small>
			</span>
			{role === "owner" && <span className="tag">{copy.info.owner(channel)}</span>}
			{role === "admin" && <span className="tag grey">{copy.info.admin(channel)}</span>}
		</button>
	);
}

/** Groups and channels, in the order people know from Zalo (#info-panels). */
function SharedRows({ chatId, onShared }: { chatId: number; onShared: (tab: SharedTab) => void }) {
	return (
		<Suspense fallback={null}>
			<SharedMediaSection chatId={chatId} onOpen={onShared} />
		</Suspense>
	);
}

function GroupInfo({ chat, onShared }: { chat: Chat; onShared: (tab: SharedTab) => void }) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { backend } = useServices();
	const channel = chat.type === "channel";
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const owner = chat.myRole === "owner";
	const canAdd = admin || (!channel && (chat.myPermissions & Permission.addMembers) !== 0);
	const online = useOnlineCount(channel || chat.left ? 0 : chat.id);
	const subtitle = channel
		? copy.info.channel(chat.memberCount)
		: online === null
			? copy.convo.members(chat.memberCount)
			: copy.convo.membersOnline(chat.memberCount, online);
	return (
		<aside className="info" aria-label={channel ? copy.info.channelTitle : copy.info.groupTitle}>
			<InfoHead title={channel ? copy.info.channelTitle : copy.info.groupTitle} />
			<div className="info-hero">
				<ChatAvatar id={chat.id} name={chat.title} size="lg" />
				<h2>{chat.title}</h2>
				<span className="muted">{subtitle}</span>
				{chat.about !== "" && <p>{chat.about}</p>}
			</div>
			{!chat.left && (
				<QuickActions chatId={chat.id} title={chat.title}>
					{canAdd && (
						<button type="button" onClick={() => ui.dialog.set({ kind: "addMembers", chatId: chat.id })}>
							<span className="qa-ico">
								<Icon name="user-plus" />
							</span>
							<span className="qa-label">{copy.info.addMembers(channel)}</span>
						</button>
					)}
				</QuickActions>
			)}
			{/* No longer a member: the server refuses the members and media of the chat. */}
			{(!channel || admin) && !chat.left && <GroupMembers chat={chat} />}
			{canAdd && !chat.left && (
				<div className="info-sec">
					<h3>{copy.info.inviteLink}</h3>
					<InviteRow chat={chat} />
				</div>
			)}
			{!chat.left && <SharedRows chatId={chat.id} onShared={onShared} />}
			{!chat.left && <PinnedBarRow chat={chat} />}
			{admin && (
				<div className="info-sec">
					<Link to={paths.chatAdmin(chat.id)} className="row link-row">
						<Icon name="settings" />
						<span className="grow">{copy.info.manage(channel)}</span>
						<Icon name="chevron-right" small />
					</Link>
					<Link to={paths.hooks(chat.id)} className="row link-row">
						<Icon name="webhook" />
						<span className="grow">{copy.info.hooks}</span>
						<Icon name="chevron-right" small />
					</Link>
				</div>
			)}
			<div className="info-sec">
				{!chat.left && (
					<button type="button" className="row link-row danger" onClick={() => ui.dialog.set({ kind: "leave", chatId: chat.id })}>
						<Icon name="logout" />
						<span className="grow">{channel ? copy.info.leaveChannel : copy.info.leaveGroup}</span>
					</button>
				)}
				{owner && !chat.left && (
					<button type="button" className="row link-row danger" onClick={() => ui.dialog.set({ kind: "deleteChat", chatId: chat.id })}>
						<Icon name="trash" />
						<span className="grow">{copy.info.deleteGroup(channel)}</span>
					</button>
				)}
				{backend.features.has("report") && (
					<button
						type="button"
						className="row link-row"
						onClick={() => ui.dialog.set({ kind: "report", target: { kind: "chat", chatId: chat.id }, name: chat.title, blockUserId: 0 })}
					>
						<Icon name="flag" />
						<span className="grow">{copy.info.reportChat(channel)}</span>
					</button>
				)}
			</div>
		</aside>
	);
}

/** "Cloud của tôi" (#first-run): your own notes, so no presence, contact, block or report rows. */
function SavedInfo({ chat, onShared }: { chat: Chat; onShared: (tab: SharedTab) => void }) {
	const copy = useScreensCopy();
	const ui = useUi();
	const name = copy.list.savedChat;
	return (
		<aside className="info" aria-label={name}>
			<InfoHead title={name} />
			<div className="info-hero">
				<ChatAvatar id={chat.id} name={name} size="lg" saved />
				<h2>{name}</h2>
				<span className="muted">{copy.convo.savedSubtitle}</span>
			</div>
			<QuickActions chatId={chat.id} title={name} mute={false} />
			<SharedRows chatId={chat.id} onShared={onShared} />
			<PinnedBarRow chat={chat} />
			<div className="info-sec">
				<button type="button" className="row link-row danger" onClick={() => ui.dialog.set({ kind: "deleteChat", chatId: chat.id })}>
					<Icon name="trash" />
					<span className="grow">{copy.deleteChat.clearSaved}</span>
				</button>
			</div>
		</aside>
	);
}

/** The other person of a private chat, or a bot (#info-panels). */
function UserInfo({ chat, peer, onShared }: { chat: Chat; peer: User | undefined; onShared: (tab: SharedTab) => void }) {
	const copy = useScreensCopy();
	const { remote, backend, toasts } = useServices();
	const ui = useUi();
	const bot = peer?.isBot === true;
	const presence = usePresence(bot ? 0 : chat.peerUserId);
	const presenceLabel = usePresenceText(presence, copy);
	const [blocked, setBlocked] = useState<boolean | null>(null);
	const isBlocked = blocked ?? peer?.isBlocked ?? false;
	const name = peer?.name ?? dialogTitle({ chat, peer: null }, copy);
	const online = presence?.kind === "online";
	const toggleBlock = () => {
		const next = !isBlocked;
		(next ? remote.block(chat.peerUserId) : remote.unblock(chat.peerUserId)).then(
			() => {
				setBlocked(next);
				toasts.show(next ? (bot ? copy.info.botStopped(name) : copy.info.blocked(name)) : copy.info.unblocked(name));
			},
			() => toasts.show(copy.common.failed),
		);
	};
	const title = bot ? copy.info.botTitle : copy.info.userTitle;
	return (
		<aside className="info" aria-label={title}>
			<InfoHead title={title} />
			<div className="info-hero">
				<ChatAvatar id={chat.id} name={name} size="lg" bot={bot} online={online} />
				<h2>{name}</h2>
				<span className={online ? "muted on" : "muted"}>{bot ? copy.info.botLine(peer?.username ?? "") : presenceLabel}</span>
				{peer !== undefined && peer.bio !== "" && <p>{peer.bio}</p>}
			</div>
			<QuickActions chatId={chat.id} title={name}>
				{!bot && peer !== undefined && (
					<button type="button" onClick={() => ui.dialog.set({ kind: "newGroup", withUserId: peer.id })}>
						<span className="qa-ico">
							<Icon name="users" />
						</span>
						<span className="qa-label">{copy.info.createGroup}</span>
					</button>
				)}
			</QuickActions>
			{!bot && (
				<div className="info-sec">
					{peer !== undefined && !peer.isSelf && <ContactRow userId={peer.id} name={name} />}
					{peer !== undefined && peer.username !== "" && (
						<div className="row">
							<Icon name="user" />
							<span className="grow">
								<MiddleTruncate text={`@${peer.username}`} tail={4} />
								<small>{copy.info.username}</small>
							</span>
							<CopyButton text={`@${peer.username}`} label={copy.info.copyUsername} copiedLabel={copy.info.copiedUsername(peer.username)} />
						</div>
					)}
				</div>
			)}
			<SharedRows chatId={chat.id} onShared={onShared} />
			{peer !== undefined && !peer.isSelf && <CommonChatsSection userId={peer.id} bot={bot} />}
			<PinnedBarRow chat={chat} />
			<div className="info-sec">
				<button type="button" className="row link-row danger" onClick={toggleBlock}>
					<Icon name="ban" />
					<span className="grow">{isBlocked ? copy.info.unblock : bot ? copy.info.stopBot : copy.info.block}</span>
				</button>
				{!bot && (
					<button type="button" className="row link-row danger" onClick={() => ui.dialog.set({ kind: "deleteChat", chatId: chat.id })}>
						<Icon name="trash" />
						<span className="grow">{copy.info.deleteChat}</span>
					</button>
				)}
				{backend.features.has("report") && (
					<button
						type="button"
						className="row link-row"
						onClick={() => ui.dialog.set({ kind: "report", target: { kind: "user", userId: chat.peerUserId }, name, blockUserId: chat.peerUserId })}
					>
						<Icon name="flag" />
						<span className="grow">{bot ? copy.info.reportBot : copy.info.report}</span>
					</button>
				)}
			</div>
		</aside>
	);
}

function TopicInfo({ chat, topic, groupTitle }: { chat: Chat; topic: Topic; groupTitle: string }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { store } = useServices();
	const creator = useUser(topic.createdBy === store.selfId ? 0 : topic.createdBy);
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	return (
		<aside className="info" aria-label={copy.info.topicTitle}>
			<InfoHead title={copy.info.topicTitle} />
			<div className="info-hero">
				<TopicIco topic={topic} size="lg" />
				<h2>{topic.title}</h2>
				<span className="muted">
					{copy.info.topicIn}{" "}
					<Link to={paths.chat(chat.id)} className="link">
						{groupTitle}
					</Link>
				</span>
			</div>
			<QuickActions chatId={chat.id} title={groupTitle}>
				{admin && (
					<Link to={paths.chatAdmin(chat.id)}>
						<span className="qa-ico">
							<Icon name="settings" />
						</span>
						<span className="qa-label">{copy.info.manageShort}</span>
					</Link>
				)}
			</QuickActions>
			{topic.link !== "" && (
				<div className="info-sec">
					<h3>{copy.info.topicLink}</h3>
					<div className="copy-field">
						<MiddleTruncate className="value" text={displayLink(topic.link)} />
						<CopyButton text={topic.link} label={copy.info.copyTopicLink} copiedLabel={copy.info.copiedTopicLink} />
					</div>
					<p className="note">
						<Icon name="lock" />
						<span>{copy.info.topicLinkNote(groupTitle)}</span>
					</p>
				</div>
			)}
			<div className="info-sec">
				<div className="row">
					<Icon name="user" />
					<span className="grow">
						{copy.info.topicCreated(userName(creator, store.selfId, copy, topic.createdBy), shortDate(topic.createdAt, locale))}
						<small>{copy.info.topicCreator}</small>
					</span>
				</div>
			</div>
		</aside>
	);
}

interface InfoPanelProps {
	chat: Chat;
	peer: User | undefined;
	topic: Topic | null;
	title: string;
}

export function InfoPanel({ chat, peer, topic, title }: InfoPanelProps) {
	useColumnBehaviour(useUi());
	const [shared, setShared] = useState<{ readonly chatId: number; readonly tab: SharedTab } | null>(null);
	const openShared = (tab: SharedTab) => setShared({ chatId: chat.id, tab });
	if (shared !== null && shared.chatId === chat.id) {
		const back = () => {
			setShared(null);
			requestAnimationFrame(() => document.querySelector<HTMLElement>("aside.info .media-rows button")?.focus());
		};
		return (
			<aside className="info sm-view" aria-label={title}>
				<Suspense fallback={null}>
					<SharedMediaView chatId={chat.id} tab={shared.tab} onBack={back} />
				</Suspense>
			</aside>
		);
	}
	if (topic !== null) return <TopicInfo chat={chat} topic={topic} groupTitle={title} />;
	if (chat.type === "group" || chat.type === "channel") return <GroupInfo chat={chat} onShared={openShared} />;
	if (isSavedChat(chat, peer ?? null)) return <SavedInfo chat={chat} onShared={openShared} />;
	return <UserInfo chat={chat} peer={peer} onShared={openShared} />;
}

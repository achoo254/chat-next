// The open chat or topic (mockups/chat.html#app, #channel, #topics,
// #topic-states, #connection-states).
import { Suspense, lazy, useEffect, useRef, useState, type DragEvent } from "react";
import type { Chat } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import type { MessagingCopy } from "../copy/vi.ts";
import { chatKind, dialogTitle, isSavedChat } from "../data/format.ts";
import type { Topic } from "../data/pending-backend.ts";
import { Permission } from "../data/remote.ts";
import { useChat, useConnection, useDialog, useListEntry, useMediaLimits, useServices, useTopics, useUser, useWindow } from "../data/services.tsx";
import { addAttachments, dragHasFiles, viewer } from "../media/media-state.ts";
import { sizeLimitLabel } from "./composer.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Composer } from "./composer.tsx";
import { useOnlineCount } from "./members.ts";
import { useIncomingSound } from "./incoming-sound.ts";
import { MessageList } from "./message-list.tsx";
import { ChatAvatar } from "./parts.tsx";
import { presenceText, usePresence } from "./presence.tsx";
import { TopicIco } from "./topic-ico.tsx";
import { useCell, useUi } from "./ui-context.tsx";

const MenuLayer = lazy(() => import("./message-menu.tsx"));
const MediaViewer = lazy(() => import("../media/viewer.tsx"));

/** The photo and video viewer of this chat (mockups/media.html#viewer), loaded when first opened. */
function ViewerLayer({ chatId }: { chatId: number }) {
	const target = useCell(viewer);
	if (target === null || target.chatId !== chatId) return null;
	return (
		<Suspense fallback={null}>
			<MediaViewer key={`${target.chatId}:${target.seq}`} chatId={target.chatId} seq={target.seq} onClose={() => viewer.set(null)} />
		</Suspense>
	);
}

/** Files dragged over the chat (#attach, right pane): what happens when they are dropped. */
function DropZone({ count, maxBytes }: { count: number; maxBytes: number }) {
	const copy = useCopy();
	const { locale } = useI18n();
	return (
		<div className="drop-zone" role="status">
			<Icon name="upload" />
			<strong>{copy.composer.dropTitle}</strong>
			<span>{copy.composer.dropBody(count, sizeLimitLabel(maxBytes, locale))}</span>
		</div>
	);
}

/** Whether the user may send media in the chat (groups: the SEND_MEDIA permission). */
function canSendMedia(chat: Chat): boolean {
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	if (chat.type === "group") return admin || (chat.myPermissions & Permission.sendMedia) !== 0;
	return true;
}

/** The message menu loads on first use. */
function MessageMenu({ chat, readOutboxMaxSeq }: { chat: Chat; readOutboxMaxSeq: number }) {
	const ui = useUi();
	const target = useCell(ui.menu);
	if (target === null) return null;
	return (
		<Suspense fallback={null}>
			<MenuLayer
				key={`${target.chatId}:${target.key}:${target.picker === true ? 1 : 0}`}
				chatId={target.chatId}
				itemKey={target.key}
				chat={chat}
				readOutboxMaxSeq={readOutboxMaxSeq}
				picker={target.picker === true}
			/>
		</Suspense>
	);
}

// The pinned bar loads with the first chat that has a pinned message.
const PinnedBar = lazy(() => import("./pinned-bar.tsx"));

function OfflineBanner({ chatId }: { chatId: number }) {
	const copy = useCopy();
	const connection = useConnection();
	const pending = useWindow(chatId)?.pendingCount ?? 0;
	if (connection !== "offline" && connection !== "waiting") return null;
	return (
		<div className="banner warn" role="status">
			<Icon name="wifi-off" small />
			{copy.convo.offlineBanner(pending)}
		</div>
	);
}

function Subtitle({ chat, topic, groupTitle }: { chat: Chat; topic: Topic | null; groupTitle: string }) {
	const copy = useCopy();
	const connection = useConnection();
	const peer = useUser(chat.type === "private" ? chat.peerUserId : 0);
	const saved = isSavedChat(chat, peer);
	const presence = usePresence(chat.type === "private" && peer?.isBot !== true && !saved ? chat.peerUserId : 0);
	const online = useOnlineCount(chat.type === "group" && !chat.left ? chat.id : 0);
	if (connection === "connecting") {
		return (
			<span className="status-line">
				<span className="spin" aria-hidden="true" />
				{copy.convo.connecting}
			</span>
		);
	}
	if (connection === "offline" || connection === "waiting") return <span>{copy.convo.waitingNetwork}</span>;
	if (saved) return <span>{copy.convo.savedSubtitle}</span>;
	if (topic !== null) {
		// The server does not count a topic's messages yet: show the count only when known.
		const parts = [
			topic.closed ? (topic.messageCount > 0 ? copy.topics.closedHead(topic.messageCount) : copy.topics.closedShort) : "",
			!topic.closed && topic.messageCount > 0 ? copy.topics.messageCount(topic.messageCount) : "",
			groupTitle,
		].filter((part) => part !== "");
		return <span>{parts.join(" · ")}</span>;
	}
	switch (chat.type) {
		case "channel":
			return (
				<span>
					{chat.myRole === "owner" ? copy.convo.channelOwner : chat.myRole === "admin" ? copy.convo.channelAdmin : copy.convo.subscribers(chat.memberCount)}
				</span>
			);
		case "group":
			return <span>{online === null ? copy.convo.members(chat.memberCount) : copy.convo.membersOnline(chat.memberCount, online)}</span>;
		default:
			if (peer?.isBot === true) return <span>{copy.info.bot}</span>;
			return <span>{presence === null ? "" : presenceText(presence, copy)}</span>;
	}
}

function canSend(chat: Chat): boolean {
	if (chat.left) return false;
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	if (chat.type === "channel") return admin;
	if (chat.type === "group") return admin || (chat.myPermissions & Permission.sendMessages) !== 0;
	return true;
}

/** Says where the message goes (#composer-states): a person, a group (with the @ hint) or a topic. */
function placeholderFor(chat: Chat, topic: Topic | null, title: string, copy: MessagingCopy): string {
	if (chat.type === "channel") return copy.composer.channelPlaceholder;
	if (topic !== null) return topic.closed ? copy.topics.closedPlaceholder : copy.composer.placeholderGroup(topic.title);
	if (chat.type === "group") return copy.composer.placeholderGroup(title);
	return copy.composer.placeholder(title);
}

/** Subscribers of a channel get a notifications switch in place of the composer. */
function ChannelBar({ chatId }: { chatId: number }) {
	const copy = useCopy();
	const { remote, toasts } = useServices();
	const muted = useListEntry(chatId)?.muted === true;
	return (
		<div className="sub-bar">
			<button
				type="button"
				className="btn"
				aria-pressed={muted}
				onClick={() => remote.setDialogMute(chatId, muted ? 0 : "forever").catch(() => toasts.show(copy.common.failed))}
			>
				<Icon name={muted ? "bell" : "bell-off"} />
				<span>{muted ? copy.convo.unmute : copy.convo.mute}</span>
			</button>
		</div>
	);
}

interface ConversationProps {
	chatId: number;
	topicId: number;
	infoOpen: boolean;
}

export function Conversation({ chatId, topicId, infoOpen }: ConversationProps) {
	const copy = useCopy();
	const ui = useUi();
	const { store, source } = useServices();
	const chat = useChat(chatId);
	const view = useDialog(chatId);
	const peer = useUser(chat?.type === "private" ? chat.peerUserId : 0);
	const topics = useTopics(chatId, chat?.forum === true);
	const topic = topics === null ? null : (topics.find((t) => t.id === topicId) ?? topics.find((t) => t.general) ?? topics[0] ?? null);
	const effectiveTopic = topic?.id ?? 0;
	const limits = useMediaLimits();
	const [dragging, setDragging] = useState<number | null>(null);
	const dragDepth = useRef(0);
	useIncomingSound(chatId);

	useEffect(() => {
		store.openWindow(chatId);
		// Opening a chat ends "marked as unread" (on every session). Marking the
		// open chat unread from the list keeps the mark until it is opened again.
		if (store.dialog(chatId)?.dialog.unreadMark === true) {
			source.setDialogUnreadMark(chatId, false).catch(() => undefined);
		}
	}, [store, source, chatId]);

	useEffect(() => {
		ui.menu.set(null);
	}, [ui, chatId, effectiveTopic]);

	if (chat === undefined) {
		return (
			<section className="convo" aria-busy="true">
				<div className="empty">
					<span className="spin" aria-hidden="true" />
				</div>
			</section>
		);
	}
	if (chat === null) {
		return (
			<section className="convo">
				<div className="empty">
					<Icon name="message" />
					<strong>{copy.convo.notFound}</strong>
					<span>{copy.convo.notFoundBody}</span>
				</div>
			</section>
		);
	}

	const title = dialogTitle({ chat, peer: view?.peer ?? peer ?? null }, copy);
	const kind = chatKind(chat, view?.peer ?? null, topics !== null);
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const closedForMe = topic !== null && topic.closed && !admin;
	const sendable = canSend(chat) && !closedForMe;
	const mediaAllowed = sendable && canSendMedia(chat) && limits !== null && limits.uploadSizeMax > 0;
	// Files dragged anywhere over the chat go to the composer's tray when dropped.
	const dragHandlers = mediaAllowed
		? {
				onDragEnter: (event: DragEvent<HTMLElement>) => {
					if (!dragHasFiles([...event.dataTransfer.types])) return;
					event.preventDefault();
					dragDepth.current++;
					setDragging(event.dataTransfer.items.length);
				},
				onDragOver: (event: DragEvent<HTMLElement>) => {
					if (!dragHasFiles([...event.dataTransfer.types])) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
				},
				onDragLeave: () => {
					dragDepth.current = Math.max(0, dragDepth.current - 1);
					if (dragDepth.current === 0) setDragging(null);
				},
				onDrop: (event: DragEvent<HTMLElement>) => {
					if (!dragHasFiles([...event.dataTransfer.types])) return;
					event.preventDefault();
					dragDepth.current = 0;
					setDragging(null);
					addAttachments(chatId, effectiveTopic, [...event.dataTransfer.files]);
					document.querySelector<HTMLTextAreaElement>(".convo .composer textarea")?.focus();
				},
			}
		: {};
	return (
		<section className="convo" aria-label={topic?.title ?? title} {...dragHandlers}>
			<header className="convo-head">
				<button type="button" className="icon-btn narrow-only" aria-label={copy.convo.backToList} onClick={() => navigate(paths.home)}>
					<Icon name="back" />
				</button>
				{topic !== null ? (
					<TopicIco topic={topic} size="sm" />
				) : (
					<ChatAvatar id={chatId} name={title} bot={kind === "bot"} saved={isSavedChat(chat, view?.peer ?? peer ?? null)} />
				)}
				<div className="title">
					<strong>{topic?.title ?? title}</strong>
					<Subtitle chat={chat} topic={topic} groupTitle={title} />
				</div>
				<button type="button" className="icon-btn" aria-label={topic !== null ? copy.topics.searchInTopic : copy.convo.searchInChat} onClick={ui.focusSearch}>
					<Icon name="search" />
				</button>
				<button
					type="button"
					className="icon-btn"
					data-info-toggle
					aria-pressed={infoOpen}
					aria-label={topic !== null ? copy.topics.info : copy.convo.info}
					onClick={() => ui.toggleInfo()}
				>
					<Icon name="info" />
				</button>
			</header>
			{(topics === null || topic !== null) && ((view?.dialog.pinnedMessageCount ?? 0) > 0 || chat.pinnedSeq !== 0) && (
				<Suspense fallback={null}>
					<PinnedBar key={effectiveTopic} chat={chat} topicId={effectiveTopic} />
				</Suspense>
			)}
			<OfflineBanner chatId={chatId} />
			<MessageList chatId={chatId} topicId={effectiveTopic} chat={chat} dialog={view} />
			{chat.left ? (
				<div className="closed-bar" role="status">
					{copy.convo.left}
				</div>
			) : topic !== null && topic.closed && !admin ? (
				<div className="closed-bar" role="status">
					<Icon name="lock" small />
					{copy.topics.closedBar}
				</div>
			) : chat.type === "channel" && !admin ? (
				<ChannelBar chatId={chatId} />
			) : sendable ? (
				<Composer
					key={`${chatId}:${effectiveTopic}`}
					chatId={chatId}
					topicId={effectiveTopic}
					channel={chat.type === "channel"}
					label={chat.type === "channel" ? copy.composer.channelLabel : copy.composer.label(topic?.title ?? title)}
					placeholder={placeholderFor(chat, topic, title, copy)}
					media={canSendMedia(chat)}
				/>
			) : (
				<div className="closed-bar" role="status">
					<Icon name="lock" small />
					{copy.convo.readOnly}
				</div>
			)}
			<MessageMenu chat={chat} readOutboxMaxSeq={view?.dialog.readOutboxMaxSeq ?? 0} />
			<ViewerLayer chatId={chatId} />
			{dragging !== null && limits !== null && <DropZone count={dragging} maxBytes={limits.uploadSizeMax} />}
		</section>
	);
}

export function EmptyConversation() {
	const copy = useCopy();
	return (
		<section className="convo">
			<div className="empty">
				<Icon name="message" />
				<strong>{copy.convo.pick}</strong>
				<span>{copy.convo.pickBody}</span>
			</div>
		</section>
	);
}

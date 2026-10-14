// The open chat or topic (mockups/chat.html#app, #channel, #topics,
// #topic-states, #connection-states).
import { Suspense, lazy, useEffect, useSyncExternalStore } from "react";
import type { Chat } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import type { MessagingCopy } from "../copy/vi.ts";
import { chatKind, dialogTitle, messagePreview, userName } from "../data/format.ts";
import type { Topic } from "../data/pending-backend.ts";
import { Permission } from "../data/remote.ts";
import { useChat, useConnection, useDialog, useMessage, useServices, useTopics, useUser, useWindow } from "../data/services.tsx";
import { Composer } from "./composer.tsx";
import { MessageList } from "./message-list.tsx";
import { ChatAvatar } from "./parts.tsx";
import { presenceText, usePresence } from "./presence.tsx";
import { TopicIco } from "./topic-ico.tsx";
import { useCell, useUi } from "./ui-context.tsx";

const MenuLayer = lazy(() => import("./message-menu.tsx"));

/** The message menu loads on first use. */
function MessageMenu({ chat, readOutboxMaxSeq }: { chat: Chat; readOutboxMaxSeq: number }) {
	const ui = useUi();
	const target = useCell(ui.menu);
	if (target === null) return null;
	return (
		<Suspense fallback={null}>
			<MenuLayer key={`${target.chatId}:${target.key}`} chatId={target.chatId} itemKey={target.key} chat={chat} readOutboxMaxSeq={readOutboxMaxSeq} />
		</Suspense>
	);
}

/** Pinned bars hidden on this device (the pin itself stays for everyone). */
export const hiddenPins = {
	key: (chatId: number) => `chat:pin-hidden:${chatId}`,
	listeners: new Set<() => void>(),
	get(chatId: number): number {
		try {
			return Number(window.localStorage.getItem(this.key(chatId)) ?? 0);
		} catch {
			return 0;
		}
	},
	set(chatId: number, seq: number): void {
		try {
			if (seq === 0) window.localStorage.removeItem(this.key(chatId));
			else window.localStorage.setItem(this.key(chatId), String(seq));
		} catch {
			// The bar comes back on the next visit when storage is blocked.
		}
		for (const listener of this.listeners) listener();
	},
	subscribe(listener: () => void): () => void {
		hiddenPins.listeners.add(listener);
		return () => hiddenPins.listeners.delete(listener);
	},
};

export function usePinHidden(chatId: number): number {
	return useSyncExternalStore(hiddenPins.subscribe, () => hiddenPins.get(chatId));
}

function PinnedBar({ chat }: { chat: Chat }) {
	const copy = useCopy();
	const { store, toasts } = useServices();
	const hidden = usePinHidden(chat.id);
	const message = useMessage(chat.id, chat.pinnedSeq);
	if (chat.pinnedSeq === 0 || hidden === chat.pinnedSeq) return null;
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	return (
		<div className="pinned closable">
			<button type="button" className="pin-jump" aria-label={copy.pinned.jump} onClick={() => store.openWindow(chat.id, chat.pinnedSeq)}>
				<Icon name="pin" small />
				<span className="txt">
					<b>{copy.pinned.label}</b>
					{message != null && ` · ${messagePreview(message, nameOf, copy)}`}
				</span>
			</button>
			<button
				type="button"
				className="icon-btn"
				aria-label={copy.pinned.hide}
				onClick={() => {
					hiddenPins.set(chat.id, chat.pinnedSeq);
					toasts.show(copy.pinned.hidden);
				}}
			>
				<Icon name="x" small />
			</button>
		</div>
	);
}

function OfflineBanner({ chatId }: { chatId: number }) {
	const copy = useCopy();
	const { store } = useServices();
	const connection = useConnection();
	useWindow(chatId);
	if (connection !== "offline" && connection !== "waiting") return null;
	const pending = store.items(chatId).filter((item) => item.kind === "pending").length;
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
	const presence = usePresence(chat.type === "private" && peer?.isBot !== true ? chat.peerUserId : 0);
	if (connection === "connecting") {
		return (
			<span className="status-line">
				<span className="spin" aria-hidden="true" />
				{copy.convo.connecting}
			</span>
		);
	}
	if (connection === "offline" || connection === "waiting") return <span>{copy.convo.waitingNetwork}</span>;
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
			return <span>{chat.myRole === "admin" || chat.myRole === "owner" ? copy.convo.channelAdmin : copy.convo.subscribers(chat.memberCount)}</span>;
		case "group":
			return <span>{copy.convo.members(chat.memberCount)}</span>;
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

function placeholderFor(chat: Chat, topic: Topic | null, copy: MessagingCopy): string {
	if (chat.type === "channel") return copy.composer.channelPlaceholder;
	if (topic !== null) return topic.closed ? copy.topics.closedPlaceholder : copy.composer.placeholderTopic(topic.title);
	return copy.composer.placeholder;
}

function ChannelBar({ chatId }: { chatId: number }) {
	const copy = useCopy();
	const { backend, toasts } = useServices();
	const supported = backend.features.has("mute");
	const muted = backend.isMuted(chatId);
	return (
		<div className="sub-bar">
			<button
				type="button"
				className="btn"
				aria-pressed={muted}
				disabled={!supported}
				aria-describedby={supported ? undefined : "mute-later"}
				onClick={() => backend.setMuted(chatId, !muted).catch(() => toasts.show(copy.common.failed))}
			>
				<Icon name={muted ? "bell" : "bell-off"} />
				<span>{muted ? copy.convo.unmute : copy.convo.mute}</span>
			</button>
			{!supported && (
				<span className="tag-neutral" id="mute-later">
					{copy.common.soon}
				</span>
			)}
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
	const { store } = useServices();
	const chat = useChat(chatId);
	const view = useDialog(chatId);
	const topics = useTopics(chatId, chat?.forum === true);
	const topic = topics === null ? null : (topics.find((t) => t.id === topicId) ?? topics.find((t) => t.general) ?? topics[0] ?? null);
	const effectiveTopic = topic?.id ?? 0;

	useEffect(() => {
		store.openWindow(chatId);
	}, [store, chatId]);

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

	const title = dialogTitle({ chat, peer: view?.peer ?? store.user(chat.peerUserId) ?? null }, copy);
	const kind = chatKind(chat, view?.peer ?? null, topics !== null);
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const closedForMe = topic !== null && topic.closed && !admin;
	const sendable = canSend(chat) && !closedForMe;
	return (
		<section className="convo" aria-label={topic?.title ?? title}>
			<header className="convo-head">
				<button type="button" className="icon-btn narrow-only" aria-label={copy.convo.backToList} onClick={() => navigate(paths.home)}>
					<Icon name="back" />
				</button>
				{topic !== null ? <TopicIco topic={topic} size="sm" /> : <ChatAvatar id={chatId} name={title} bot={kind === "bot"} />}
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
			{topic === null && <PinnedBar chat={chat} />}
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
					placeholder={placeholderFor(chat, topic, copy)}
				/>
			) : (
				<div className="closed-bar" role="status">
					<Icon name="lock" small />
					{copy.convo.readOnly}
				</div>
			)}
			<MessageMenu chat={chat} readOutboxMaxSeq={view?.dialog.readOutboxMaxSeq ?? 0} />
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

// The message list of a chat or topic. It holds a sliding window of at most
// ~120 messages (ChatStore): scrolling up prepends older pages, scrolling
// down after a jump appends newer ones. Browser scroll anchoring is off
// (overflow-anchor: none); the list restores the position of the first
// visible message itself after a prepend. Floating buttons go to the newest
// message and, while someone's mention of you is unread, to that message.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Chat, DialogView } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { countLabel, dayLabel, sameDay } from "../data/format.ts";
import { useBackendValue, useServices, useWindow } from "../data/services.tsx";
import type { ChatStore, WindowItem } from "../data/store.ts";
import { MessageItem } from "./message-item.tsx";
import { pendingTopics } from "../media/media-state.ts";
import { mentionsSelf } from "./rich-text.tsx";

const EDGE_PX = 240;
const BOTTOM_PX = 48;

interface MessageListProps {
	chatId: number;
	/** 0: the whole chat; otherwise only this topic's messages. */
	topicId: number;
	chat: Chat | null;
	dialog: DialogView | undefined;
}

/** What groups an item into an album: grouped_id of a message, the outbox entry of a pending album; "" for none. */
function albumOf(item: WindowItem | undefined): string {
	if (item === undefined) return "";
	if (item.kind === "pending") return item.pending.albumId === undefined ? "" : `p${item.pending.albumId}`;
	const message = item.message;
	if (message.groupedId === 0 || message.recalled || message.action !== null) return "";
	return `g${message.fromId}:${message.groupedId}`;
}

/** List rows: one per message, an album's consecutive messages in one row (keyed by its first). */
export function groupRows(keys: readonly string[], itemOf: (key: string) => WindowItem | undefined): { key: string; keys: string[] }[] {
	const rows: { key: string; keys: string[]; album: string }[] = [];
	for (const key of keys) {
		const album = albumOf(itemOf(key));
		const last = rows[rows.length - 1];
		if (album !== "" && last !== undefined && last.album === album) last.keys.push(key);
		else rows.push({ key, keys: [key], album });
	}
	return rows.map(({ key, keys: members }) => ({ key, keys: members }));
}

function itemDate(item: WindowItem | undefined): number {
	if (item === undefined) return 0;
	return item.kind === "message" ? item.message.date : item.pending.date;
}

/**
 * The first unread message in the window that mentions you or replies to
 * you; 0 when it is outside the window (the caller loads around the first
 * unread message, where the next press finds it).
 */
function firstMention(store: ChatStore, chatId: number, readInbox: number, self: { id: number; username: string }): number {
	const own = new Set<number>();
	for (const item of store.items(chatId)) {
		if (item.kind !== "message") continue;
		const message = item.message;
		if (message.fromId === store.selfId) {
			own.add(message.seq);
			continue;
		}
		if (message.seq <= readInbox) continue;
		if (mentionsSelf(message.text, message.entities, self.id, self.username) || own.has(message.replyToSeq)) return message.seq;
	}
	return 0;
}

export function MessageList({ chatId, topicId, chat, dialog }: MessageListProps) {
	const copy = useCopy();
	const { locale } = useI18n();
	const { store, source, backend, self } = useServices();
	const window_ = useWindow(chatId);
	// A message's topic is known once the forum's topics are loaded.
	const topicsLoaded = useBackendValue((pending) => pending.topics(chatId) !== null);
	const scroller = useRef<HTMLDivElement>(null);
	const anchor = useRef<{ key: string; offset: number } | null>(null);
	const stick = useRef(true);
	const positioned = useRef(0);
	const lastRead = useRef(0);
	const [atBottom, setAtBottom] = useState(true);
	const [focused, setFocused] = useState<string | null>(null);

	const allKeys = (window_?.keys ?? []).filter((key) => {
		if (topicId === 0 || !topicsLoaded) return topicId === 0;
		const item = store.item(chatId, key);
		// Media sends to a topic show there while they upload (text sends to topics are not queued).
		if (item?.kind === "pending") return pendingTopics.get(item.pending.randomId) === topicId;
		return item?.kind === "message" && backend.messageTopic(item.message) === topicId;
	});
	const groups = groupRows(allKeys, (key) => store.item(chatId, key));
	// One row per message or album: keyboard moves between rows.
	const keys = groups.map((group) => group.key);
	const lastKey = keys[keys.length - 1] ?? "";
	const unreadFrom = window_?.unreadFromSeq ?? 0;
	const readOutbox = dialog?.dialog.readOutboxMaxSeq ?? 0;
	const tabKey = focused !== null && keys.includes(focused) ? focused : lastKey;

	// Keep the view where the reader left it whenever the window changes.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element === null || window_ === undefined || window_.status !== "ready") return;
		if (positioned.current !== window_.focusToken + 1) {
			positioned.current = window_.focusToken + 1;
			const target =
				window_.focusSeq !== 0
					? element.querySelector<HTMLElement>(`[data-seq="${window_.focusSeq}"]`)
					: element.querySelector<HTMLElement>(".unread-div");
			if (target !== null) {
				element.scrollTop = Math.max(0, target.offsetTop - (window_.focusSeq !== 0 ? element.clientHeight / 3 : 8));
				if (window_.focusSeq !== 0) target.classList.add("flash");
			} else {
				element.scrollTop = element.scrollHeight;
			}
			// Whether the newest message is on screen decides marking as read.
			const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_PX;
			stick.current = bottom;
			setAtBottom(bottom && window_.live);
			return;
		}
		if (stick.current && window_.live) {
			element.scrollTop = element.scrollHeight;
			return;
		}
		const saved = anchor.current;
		if (saved === null) return;
		const node = element.querySelector<HTMLElement>(`[data-key="${saved.key}"]`);
		if (node !== null) element.scrollTop = node.offsetTop - saved.offset;
	}, [window_, keys.length, lastKey]);

	const onScroll = () => {
		const element = scroller.current;
		if (element === null || window_ === undefined) return;
		const fromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
		stick.current = fromBottom < BOTTOM_PX;
		setAtBottom(stick.current && window_.live);
		const first = [...element.querySelectorAll<HTMLElement>("[data-key]")].find(
			(node) => node.offsetTop + node.offsetHeight > element.scrollTop,
		);
		anchor.current = first === undefined ? null : { key: first.dataset.key ?? "", offset: first.offsetTop - element.scrollTop };
		if (element.scrollTop < EDGE_PX && window_.hasOlder) store.loadOlder(chatId);
		if (fromBottom < EDGE_PX && window_.hasNewer) store.loadNewer(chatId);
	};

	// Mark as read while the newest messages are on screen and the tab is visible.
	const topSeq = dialog?.dialog.topSeq ?? 0;
	const readInbox = dialog?.dialog.readInboxMaxSeq ?? 0;
	useEffect(() => {
		const mark = () => {
			if (document.visibilityState !== "visible" || !atBottom || window_?.live !== true) return;
			if (topSeq <= readInbox || topSeq <= lastRead.current) return;
			lastRead.current = topSeq;
			store.settleUnread(chatId);
			const done = topicId !== 0 ? backend.readTopic(chatId, topicId, topSeq) : source.markRead(chatId, topSeq);
			done.catch(() => {
				lastRead.current = 0;
			});
		};
		mark();
		document.addEventListener("visibilitychange", mark);
		return () => document.removeEventListener("visibilitychange", mark);
	}, [atBottom, window_?.live, topSeq, readInbox, chatId, topicId, source, backend, store]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		const current = (event.target as HTMLElement).closest<HTMLElement>("[data-key]");
		if (current === null || current !== event.target) return;
		const index = keys.indexOf(current.dataset.key ?? "");
		const next = keys[index + (event.key === "ArrowUp" ? -1 : 1)];
		if (next === undefined) return;
		event.preventDefault();
		setFocused(next);
		scroller.current?.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus();
	};

	if (window_ === undefined || (window_.status === "loading" && keys.length === 0)) {
		return (
			<div className="messages" aria-busy="true">
				<span className="system">
					<span className="spin" aria-hidden="true" /> {copy.common.loading}
				</span>
			</div>
		);
	}

	const now = new Date();
	const rows: ReactNode[] = [];
	let previousDate = 0;
	let dividerShown = false;
	for (const { key, keys: members } of groups) {
		const item = store.item(chatId, key);
		const date = itemDate(item);
		if (date !== 0 && (previousDate === 0 || !sameDay(previousDate, date))) {
			rows.push(
				<span className="day" key={`d${key}`}>
					{dayLabel(date, now, locale, copy)}
				</span>,
			);
		}
		previousDate = date || previousDate;
		if (
			!dividerShown &&
			unreadFrom !== 0 &&
			item?.kind === "message" &&
			item.message.seq >= unreadFrom &&
			item.message.fromId !== store.selfId
		) {
			dividerShown = true;
			rows.push(
				<div className="unread-div" role="separator" key="unread">
					{topicId !== 0 ? copy.convo.unreadDividerTopic : copy.convo.unreadDivider}
				</div>,
			);
		}
		rows.push(
			<MessageItem
				key={key}
				chatId={chatId}
				itemKey={key}
				albumKeys={members.length > 1 ? members.join(",") : ""}
				chat={chat}
				readOutboxMaxSeq={readOutbox}
				tabbable={key === tabKey}
			/>,
		);
	}

	const unread = dialog?.dialog.unreadCount ?? 0;
	const mentions = topicId === 0 ? (dialog?.dialog.unreadMentionsCount ?? 0) : 0;
	const toMention = () => {
		// Messages unread when the chat was opened count, even if reading it since moved the read mark.
		const from = unreadFrom !== 0 ? unreadFrom : readInbox + 1;
		const seq = firstMention(store, chatId, from - 1, self);
		stick.current = false;
		store.openWindow(chatId, seq !== 0 ? seq : from);
	};
	return (
		<div className="messages-wrap">
			<div
				className="messages"
				ref={scroller}
				onScroll={onScroll}
				onKeyDown={onKeyDown}
				onFocus={(event) => {
					const key = (event.target as HTMLElement).dataset.key;
					if (key !== undefined) setFocused(key);
				}}
				role="log"
				aria-label={copy.convo.messages}
				aria-live="polite"
				aria-relevant="additions"
			>
				{window_.loadingOlder && (
					<span className="system">
						<span className="spin" aria-hidden="true" />
					</span>
				)}
				{window_.failure !== null && keys.length === 0 ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.convo.loadFailed}</span>
						<button type="button" className="btn btn-sm" onClick={() => store.openWindow(chatId)}>
							{copy.common.retry}
						</button>
					</div>
				) : keys.length === 0 && topicId !== 0 ? (
					<span className="system">{copy.topics.empty}</span>
				) : (
					rows
				)}
			</div>
			<div className="jump-stack">
				{mentions > 0 && (
					<button type="button" className="to-bottom to-mention" aria-label={copy.convo.toMention(mentions)} onClick={toMention}>
						@<span className="badge">{countLabel(mentions)}</span>
					</button>
				)}
				{!atBottom && (
					<button
						type="button"
						className="to-bottom"
						aria-label={copy.convo.toBottom(unread)}
						onClick={() => {
							stick.current = true;
							setAtBottom(true);
							if (window_.live) {
								const element = scroller.current;
								if (element !== null) element.scrollTop = element.scrollHeight;
							} else store.jumpToNewest(chatId);
						}}
					>
						<Icon name="arrow-down" />
						{unread > 0 && <span className="badge">{countLabel(unread)}</span>}
					</button>
				)}
			</div>
		</div>
	);
}

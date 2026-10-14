// The message list of a chat or topic. It holds a sliding window of at most
// ~120 messages (ChatStore): scrolling up prepends older pages, scrolling
// down after a jump appends newer ones. Browser scroll anchoring is off
// (overflow-anchor: none); the list restores the position of the first
// visible message itself after a prepend.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Chat, DialogView } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { dayLabel, sameDay } from "../data/format.ts";
import { useBackendVersion, useServices, useWindow } from "../data/services.tsx";
import type { WindowItem } from "../data/store.ts";
import { MessageItem } from "./message-item.tsx";

const EDGE_PX = 240;
const BOTTOM_PX = 48;

interface MessageListProps {
	chatId: number;
	/** 0: the whole chat; otherwise only this topic's messages. */
	topicId: number;
	chat: Chat | null;
	dialog: DialogView | undefined;
}

function itemDate(item: WindowItem | undefined): number {
	if (item === undefined) return 0;
	return item.kind === "message" ? item.message.date : item.pending.date;
}

export function MessageList({ chatId, topicId, chat, dialog }: MessageListProps) {
	const copy = useCopy();
	const { locale } = useI18n();
	const { store, source, backend } = useServices();
	const window_ = useWindow(chatId);
	useBackendVersion();
	const scroller = useRef<HTMLDivElement>(null);
	const anchor = useRef<{ key: string; offset: number } | null>(null);
	const stick = useRef(true);
	const positioned = useRef(0);
	const lastRead = useRef(0);
	const [atBottom, setAtBottom] = useState(true);
	const [focused, setFocused] = useState<string | null>(null);

	const keys = (window_?.keys ?? []).filter((key) => {
		if (topicId === 0) return true;
		const item = store.item(chatId, key);
		return item?.kind === "message" && backend.messageTopic(item.message) === topicId;
	});
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
	for (const key of keys) {
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
				chat={chat}
				readOutboxMaxSeq={readOutbox}
				tabbable={key === tabKey}
			/>,
		);
	}

	const unread = dialog?.dialog.unreadCount ?? 0;
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
					{unread > 0 && <span className="badge">{unread}</span>}
				</button>
			)}
		</div>
	);
}

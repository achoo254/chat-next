// The pinned bar over the open chat (mockups/chat.html#app, #pin-message),
// loaded with the first chat that has a pinned message, and the bars hidden
// on this device (the info panel turns them back on).
import { useState, useSyncExternalStore } from "react";
import type { Chat } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { messagePreview, namedUserIds } from "../data/format.ts";
import { pinnedLists, usePinned } from "../data/pinned.ts";
import { useDialog, useMessage, useServices } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { useUi } from "./ui-context.tsx";

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

/**
 * The pinned bar (mockups/chat.html#app, #pin-message): "Tin ghim i/n" with
 * the pins numbered oldest first. It starts on the newest; a click jumps to
 * the shown pin and moves the bar to the next older one (after the oldest,
 * back to the newest). The chevron opens every pin; the X hides the bar on
 * this device until a newer pin. Forum groups show the pins of the topic.
 */
export default function PinnedBar({ chat, topicId }: { chat: Chat; topicId: number }) {
	const copy = useCopy();
	const { store, toasts } = useServices();
	const ui = useUi();
	const view = useDialog(chat.id);
	const dialogCount = view?.dialog.pinnedMessageCount ?? 0;
	const newestSeq = (view?.dialog.pinnedMessageSeq ?? 0) || chat.pinnedSeq;
	const list = usePinned(chat.id, topicId, dialogCount > 0 || chat.pinnedSeq !== 0);
	const ready = list?.status === "ready" ? list : null;
	// Until the list loads (or on a server without it) the dialog's newest pin
	// stands in; a forum topic's pins are known only from its list.
	const count = ready !== null ? ready.count : chat.forum ? 0 : Math.max(dialogCount, chat.pinnedSeq !== 0 ? 1 : 0);
	const listKey = ready === null ? "" : `${ready.messages[0]?.seq ?? 0}:${ready.count}`;
	const [cursor, setCursor] = useState({ key: "", index: 0 });
	const index = cursor.key === listKey && cursor.index < count ? cursor.index : 0;
	const fromList = ready?.messages[index];
	const seq = fromList?.seq ?? (ready === null && index === 0 ? newestSeq : 0);
	const looked = useMessage(chat.id, fromList === undefined ? seq : 0);
	const message = fromList ?? looked;
	const nameOf = useNameOf(message == null ? [] : namedUserIds(message));
	const hidden = usePinHidden(chat.id);
	const top = ready !== null ? (ready.messages[0]?.seq ?? 0) : newestSeq;
	if (count === 0 || top === 0 || hidden === top) return null;
	const position = count - index;
	const label = count > 1 ? copy.pinned.counter(position, count) : copy.pinned.label;
	const jump = () => {
		if (seq === 0) return;
		store.openWindow(chat.id, seq);
		const next = index + 1 >= count ? 0 : index + 1;
		if (ready !== null && next >= ready.messages.length && ready.hasMore) pinnedLists(store).loadMore(chat.id, topicId);
		setCursor({ key: listKey, index: ready !== null && next >= ready.messages.length && !ready.hasMore ? 0 : next });
	};
	return (
		<div className="pinned closable">
			<button type="button" className="pin-jump" aria-label={count > 1 ? copy.pinned.jumpTo(position, count) : copy.pinned.jump} onClick={jump}>
				<Icon name="pin" small />
				<span className="txt">
					<b>{label}</b>
					{message != null && ` · ${messagePreview(message, nameOf, copy, chat.type === "channel")}`}
				</span>
			</button>
			<button
				type="button"
				className="icon-btn"
				aria-label={copy.pinned.all(count)}
				aria-haspopup="dialog"
				onClick={() => ui.dialog.set({ kind: "pinnedList", chatId: chat.id, topicId })}
			>
				<Icon name="chevron-down" small />
			</button>
			<button
				type="button"
				className="icon-btn"
				aria-label={copy.pinned.hide}
				onClick={() => {
					hiddenPins.set(chat.id, top);
					toasts.show(copy.pinned.hidden);
				}}
			>
				<Icon name="x" small />
			</button>
		</div>
	);
}

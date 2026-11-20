// Reading a person's merged timeline (ADR 0025) reads each of their chats up
// to the newest message of that chat shown on the screen, never to the
// chat's newest message (setLiveRead): a chat whose newer messages are not
// shown yet keeps them unread, and its read receipt to Telegram or Zalo does
// not pass what was seen. Calls are throttled: at most one batch per interval.
import { useEffect, useRef } from "react";
import { useServices } from "../data/services.tsx";
import type { MergedItem, MergedTimeline } from "./merged-timeline.ts";

export const READ_INTERVAL_MS = 1000;

export type MarkRead = (chatId: number, maxSeq: number) => Promise<void>;

/** Sends `markRead` for the chats whose shown newest message grew, at most once per interval. */
export class MergedReadMarker {
	private readonly sent = new Map<number, number>();
	private wanted = new Map<number, number>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private last = Number.NEGATIVE_INFINITY;
	private disposed = false;

	constructor(
		private readonly markRead: MarkRead,
		private readonly onError: (error: unknown) => void,
		private readonly intervalMs = READ_INTERVAL_MS,
		private readonly now: () => number = Date.now,
	) {}

	/** The newest message shown of each chat (by chat id); only positive seqs above what was sent are marked. */
	note(shown: ReadonlyMap<number, number>): void {
		if (this.disposed) return;
		for (const [chatId, seq] of shown) {
			if (!Number.isSafeInteger(seq) || seq <= 0 || seq <= (this.sent.get(chatId) ?? 0)) continue;
			this.wanted.set(chatId, Math.max(seq, this.wanted.get(chatId) ?? 0));
		}
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.wanted.clear();
	}

	private schedule(): void {
		if (this.wanted.size === 0 || this.timer !== null) return;
		const wait = this.last + this.intervalMs - this.now();
		if (wait <= 0) {
			this.flush();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, wait);
	}

	private flush(): void {
		if (this.disposed || this.wanted.size === 0) return;
		this.last = this.now();
		const batch = this.wanted;
		this.wanted = new Map();
		for (const [chatId, seq] of batch) {
			const before = this.sent.get(chatId) ?? 0;
			this.sent.set(chatId, seq);
			this.markRead(chatId, seq).catch((error: unknown) => {
				// Failed: the next note tries again.
				if (this.sent.get(chatId) === seq) this.sent.set(chatId, before);
				this.onError(error);
			});
		}
	}
}

/**
 * While `active` (the screen visible, the list at its newest message), marks
 * each chat of the timeline read up to its newest message shown, skipping
 * chats already read that far.
 */
export function useMergedRead(timeline: MergedTimeline | null, items: readonly MergedItem[], active: boolean): void {
	const { source, store } = useServices();
	const marker = useRef<MergedReadMarker | null>(null);

	useEffect(() => {
		const created = new MergedReadMarker(
			(chatId, maxSeq) => source.markRead(chatId, maxSeq),
			(error) => store.reportError(error, "mark read"),
		);
		marker.current = created;
		return () => {
			created.dispose();
			marker.current = null;
		};
	}, [source, store]);

	useEffect(() => {
		if (!active || timeline === null) return;
		const shown = new Map<number, number>();
		for (const chatId of new Set(items.map((item) => item.chatId))) {
			const seq = timeline.shownMaxSeq(chatId);
			const readInbox = store.dialog(chatId)?.dialog.readInboxMaxSeq ?? 0;
			if (seq > readInbox) shown.set(chatId, seq);
		}
		marker.current?.note(shown);
	}, [active, timeline, items, store]);
}

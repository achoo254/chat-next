// Change notifications keyed by id (ADR 0007). Writers mark keys dirty; the
// bus delivers each dirty key once per frame, so a burst of updates in one
// frame causes one re-render per subscribed component. Payloads are not
// carried: subscribers re-read what they show.
import type { FrameScheduler, Unsubscribe } from "@app/platform";

/** Event keys. Chat and message keys carry ids so the UI subscribes narrowly. */
export const EventKeys = {
	/** Order or membership of the dialog list changed. */
	dialogs: "dialogs",
	dialog: (chatId: number): string => `dialog:${chatId}`,
	chat: (chatId: number): string => `chat:${chatId}`,
	user: (userId: number): string => `user:${userId}`,
	/** Messages of a chat were added, removed or reordered (pending included). */
	history: (chatId: number): string => `history:${chatId}`,
	/** One message changed in place (edit, reaction). */
	message: (chatId: number, seq: number): string => `message:${chatId}:${seq}`,
	/** Pinned messages of a chat changed (refetch GetPinnedMessages). */
	pins: (chatId: number): string => `pins:${chatId}`,
	/** The user's notification settings changed. */
	notificationSettings: "notification_settings",
	outbox: "outbox",
	connection: "connection",
	/** The session ended; local data is gone. */
	session: "session",
	/** A fresh cold-start snapshot is available. */
	snapshot: "snapshot",
	/** Progress or state of one upload changed (key: PendingMedia.uploadKey). */
	upload: (uploadKey: string): string => `upload:${uploadKey}`,
} as const;

export type KeyListener = () => void;
export type BatchListener = (keys: readonly string[]) => void;

export class EventBus {
	private readonly listeners = new Map<string, Set<KeyListener>>();
	private readonly batchListeners = new Set<BatchListener>();
	private dirty = new Set<string>();
	private scheduled = false;

	/**
	 * @param onListenerError receives what a subscriber threw; by default it
	 * is rethrown asynchronously so it still reaches global error reporting.
	 */
	constructor(
		private readonly frame: FrameScheduler,
		private readonly onListenerError: (error: unknown) => void = rethrowAsync,
	) {}

	/** Marks `key` changed; listeners run on the next frame. */
	emit(key: string): void {
		this.dirty.add(key);
		if (this.scheduled) return;
		this.scheduled = true;
		this.frame(() => this.flush());
	}

	emitAll(keys: Iterable<string>): void {
		for (const key of keys) this.emit(key);
	}

	subscribe(key: string, listener: KeyListener): Unsubscribe {
		let set = this.listeners.get(key);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(key, set);
		}
		set.add(listener);
		return () => {
			const current = this.listeners.get(key);
			current?.delete(listener);
			if (current?.size === 0) this.listeners.delete(key);
		};
	}

	/** Receives every flushed frame as one array of keys (bridges to another thread). */
	subscribeBatches(listener: BatchListener): Unsubscribe {
		this.batchListeners.add(listener);
		return () => this.batchListeners.delete(listener);
	}

	/** Delivers pending keys now. */
	flush(): void {
		this.scheduled = false;
		if (this.dirty.size === 0) return;
		const keys = [...this.dirty];
		this.dirty = new Set();
		for (const listener of this.batchListeners) {
			this.safely(() => listener(keys));
		}
		for (const key of keys) {
			const set = this.listeners.get(key);
			if (set === undefined) continue;
			for (const listener of [...set]) this.safely(listener);
		}
	}

	private safely(run: () => void): void {
		try {
			run();
		} catch (err) {
			// A broken subscriber must not stop delivery to the others.
			this.onListenerError(err);
		}
	}
}

function rethrowAsync(error: unknown): void {
	queueMicrotask(() => {
		throw error;
	});
}

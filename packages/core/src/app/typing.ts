// Who is typing where ("Minh đang gõ…" in the chat header and the dialog
// list). Each typing lasts TYPING_SHOWN_MS unless it comes again; it ends
// early when the server says so (cancel) or the person posts. Outgoing
// typing is throttled: senders repeat it every TYPING_REPEAT_MS while busy.
import type { Timers } from "@app/platform";
import type { ChatTyping, TypingAction } from "../model/types.ts";
import type { TypingChange } from "../protocol/map.ts";

/** How long a typing shows without a repeat (the gateway relays, clients expire). */
export const TYPING_SHOWN_MS = 6_000;
/** How often an ongoing action is sent again; below TYPING_SHOWN_MS so it never flickers. */
export const TYPING_REPEAT_MS = 4_000;
const REPEAT_SLACK_MS = 500;

export class TypingTracker {
	private readonly shown = new Map<string, { readonly typing: ChatTyping; readonly timer: unknown }>();
	private lastSent: { readonly chatId: number; readonly topicId: number; readonly action: TypingAction; readonly at: number } | null = null;

	constructor(
		private readonly timers: Timers,
		private readonly onChange: () => void,
		/** False when the frame could not go out (offline): it is sent again on the next keystroke. */
		private readonly send: (chatId: number, topicId: number, action: TypingAction | "cancel") => boolean,
	) {}

	/** Current typings, oldest first. */
	list(): ChatTyping[] {
		return [...this.shown.values()].map((entry) => entry.typing);
	}

	receive(change: TypingChange): void {
		if (change.action === null) {
			this.end(change.chatId, change.userId);
			return;
		}
		const typing: ChatTyping = { ...change, action: change.action };
		const key = `${typing.chatId}:${typing.userId}`;
		const previous = this.shown.get(key);
		if (previous !== undefined) this.timers.clearTimeout(previous.timer);
		const timer = this.timers.setTimeout(() => this.end(typing.chatId, typing.userId), TYPING_SHOWN_MS);
		this.shown.set(key, { typing, timer });
		if (previous === undefined || previous.typing.action !== typing.action || previous.typing.topicId !== typing.topicId) this.onChange();
	}

	/** Ends someone's typing in a chat (they posted, or it expired). */
	end(chatId: number, userId: number): void {
		const key = `${chatId}:${userId}`;
		const entry = this.shown.get(key);
		if (entry === undefined) return;
		this.timers.clearTimeout(entry.timer);
		this.shown.delete(key);
		this.onChange();
	}

	/** The user types (or records) in the open chat; repeats within TYPING_REPEAT_MS are dropped. */
	sendTyping(chatId: number, topicId: number, action: TypingAction | "cancel"): void {
		const last = this.lastSent;
		const same = last !== null && last.chatId === chatId && last.topicId === topicId;
		if (action === "cancel") {
			// Only a typing the others may still see needs ending.
			if (same) this.cancel();
			return;
		}
		const now = this.timers.now();
		// The slack absorbs timer jitter, so a repeat every TYPING_REPEAT_MS always goes out.
		if (same && last.action === action && now - last.at < TYPING_REPEAT_MS - REPEAT_SLACK_MS) return;
		if (this.send(chatId, topicId, action)) this.lastSent = { chatId, topicId, action, at: now };
	}

	/** The user posted in the chat: the others drop the typing then, so the next keystroke shows it again at once. */
	posted(chatId: number): void {
		if (this.lastSent?.chatId === chatId) this.lastSent = null;
	}

	/** Another chat opens: a typing still shown in the previous one ends now (send before the gateway hears the new chat). */
	opening(chatId: number): void {
		if (this.lastSent !== null && this.lastSent.chatId !== chatId) this.cancel();
	}

	private cancel(): void {
		const last = this.lastSent;
		if (last === null) return;
		this.lastSent = null;
		this.send(last.chatId, last.topicId, "cancel");
	}

	dispose(): void {
		for (const entry of this.shown.values()) this.timers.clearTimeout(entry.timer);
		this.shown.clear();
	}
}

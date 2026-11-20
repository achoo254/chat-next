// An in-memory history source for timeline tests: messages per chat, the
// page rules of the client core's history() (newest page from offset 0,
// strictly older pages below an offset, "around" lookups) and a real event
// bus flushed by hand. Never imported by production code.
import { EventBus, EventKeys, type ConnectionState, type HistoryRequest, type HistoryView, type PendingMessage, type StoredMessage } from "@achoo254/chat-core";
import type { TimelineSource } from "../../src/messaging/people/merged-timeline.ts";

export function storedMessage(chatId: number, seq: number, date: number, text = `${chatId}/${seq}`): StoredMessage {
	return {
		chatId,
		seq,
		fromId: 9,
		date,
		text,
		entities: [],
		mediaKind: null,
		replyToSeq: 0,
		forward: null,
		editDate: 0,
		editVersion: 0,
		randomId: 0,
		groupedId: 0,
		viaBotId: 0,
		reactions: [],
		integrationLabel: "",
		buttons: [],
		action: null,
		topicId: 0,
		linkPreview: null,
		recalled: false,
		silent: false,
		stale: false,
	};
}

export function pendingMessage(chatId: number, outboxId: number, date: number): PendingMessage {
	return { outboxId, chatId, randomId: 1000 + outboxId, text: "sending", entities: [], replyToSeq: 0, date, failure: null, localSeq: outboxId };
}

export class FakeHistorySource implements TimelineSource {
	readonly events = new EventBus(() => undefined);
	readonly messages = new Map<number, StoredMessage[]>();
	readonly pending = new Map<number, PendingMessage[]>();
	/** Chats whose history() throws. */
	readonly failing = new Set<number>();
	readonly calls: { chatId: number; request: HistoryRequest }[] = [];
	connection: ConnectionState = "connected";
	/** While set, every history() waits for it. */
	gate: Promise<void> | null = null;

	/** Adds messages `from`..`to` (inclusive seqs), the date of each from `dateOf`. */
	fill(chatId: number, from: number, to: number, dateOf: (seq: number) => number): void {
		const list = this.messages.get(chatId) ?? [];
		for (let seq = from; seq <= to; seq++) list.push(storedMessage(chatId, seq, dateOf(seq)));
		this.messages.set(chatId, list);
	}

	edit(chatId: number, seq: number, text: string): void {
		const list = this.messages.get(chatId) ?? [];
		this.messages.set(chatId, list.map((m) => (m.seq === seq ? { ...m, text, editVersion: m.editVersion + 1 } : m)));
	}

	remove(chatId: number, seq: number): void {
		this.messages.set(chatId, (this.messages.get(chatId) ?? []).filter((m) => m.seq !== seq));
	}

	/** Emits keys as the core does and delivers them now. */
	emit(...keys: string[]): void {
		this.events.emitAll(keys);
		this.events.flush();
	}

	emitHistory(chatId: number, ...seqs: number[]): void {
		this.emit(EventKeys.history(chatId), ...seqs.map((seq) => EventKeys.message(chatId, seq)));
	}

	connectionState = (): Promise<ConnectionState> => Promise.resolve(this.connection);

	history = async (chatId: number, request: HistoryRequest = {}): Promise<HistoryView> => {
		this.calls.push({ chatId, request });
		if (this.gate !== null) await this.gate;
		if (this.failing.has(chatId)) throw new Error(`history ${chatId} failed`);
		const all = [...(this.messages.get(chatId) ?? [])].sort((a, b) => a.seq - b.seq);
		const limit = request.limit ?? 50;
		const offset = request.offsetSeq ?? 0;
		if (request.direction === "around") {
			const at = all.filter((m) => m.seq <= offset).slice(-limit);
			return { messages: at, pending: [], hasOlder: true, hasNewer: true, failure: null };
		}
		const below = offset === 0 ? all : all.filter((m) => m.seq < offset);
		const page = below.slice(-limit);
		const newest = offset === 0;
		return {
			messages: page,
			pending: newest ? (this.pending.get(chatId) ?? []) : [],
			hasOlder: below.length > page.length,
			hasNewer: !newest,
			failure: null,
		};
	};

	/** How many pages of `chatId` were asked for below an offset (scrolling back). */
	olderLoads(chatId: number): number {
		return this.calls.filter((call) => call.chatId === chatId && call.request.direction === "older" && (call.request.offsetSeq ?? 0) > 0).length;
	}
}

/** Lets every queued promise of the timeline settle (the fake answers without timers). */
export function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

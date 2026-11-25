/**
 * The chat inbox: chats the user subscribed (from a device) have their new
 * messages written into the chat's AI session as a user turn. Nothing is
 * read while no subscription is on.
 *
 * Hearing: every 5 s one list_chats call (Chat's MCP, with the machine's
 * sign-in) tells which subscribed chats have a newer message than the one
 * seen last; get_messages reads only those. A chat not on the list's page is
 * asked for directly, at most once a minute, which also tells a chat the
 * user hid from AI (`chat_hidden_from_ai`): its subscription waits, and goes
 * on from its newest message once the chat is shown again. At most
 * CALLS_PER_TICK calls a tick, well under Chat's 120 calls a minute.
 *
 * Messages the user sent, service messages and recalled ones are skipped.
 * Those of one chat arriving within 5 s of each other (at most
 * 30 s from the first) make one turn; a subscription delivers at most
 * its `perHourLimit` turns an hour, and counts what it did not push. A turn
 * waits while the session runs or waits for the user, and never interrupts
 * it. A chat subscribed (or turned on again) starts after its newest
 * message: nothing older is pushed. What came while the service was off is
 * counted as missed, never pushed when it starts again.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ErrorCode, ErrorReason, ThreadKind, ThreadState, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { AgentError, type AgentCore } from "../core/agent-core.ts";
import { type InboxMessage, answerOf, historyOf, inboxTurn, isHiddenError, listedChatsOf, selfIdOf } from "./inbox-messages.ts";
import { DEFAULT_PER_HOUR_LIMIT, type InboxStore, type InboxSubscription, MAX_PER_HOUR_LIMIT } from "./inbox-store.ts";

/** How often Chat is read, how long a chat stays quiet before its messages go in, and the longest they wait. */
export type InboxTiming = { pollMs: number; quietMs: number; maxWaitMs: number };
export const INBOX_TIMING: Readonly<InboxTiming> = { pollMs: 5_000, quietMs: 5_000, maxWaitMs: 30_000 };
/**
 * A batch goes in this long after the quiet time: the read that ends the
 * quiet time (one poll after the last message) comes first, so a message
 * read then still joins the batch.
 */
const QUIET_SLACK_MS = 1_000;
const HOUR_MS = 60 * 60_000;
/** Calls to Chat a tick may make (12 ticks a minute: at most 108 of Chat's 120 a minute). */
const CALLS_PER_TICK = 9;
/** A chat missing from the list is asked for directly at most this often. */
const PROBE_MS = 60_000;
const PAGE_LIMIT = 50;
/** Messages one turn may wait with; older ones are counted as missed. */
const BATCH_MAX = 200;
export const MAX_SUBSCRIPTIONS = 50;
const TITLE_MAX = 200;
/** The device label of the turns the inbox writes (sessions and the consent log name it). */
const DEVICE = "chat inbox";

export type InboxState = "active" | "hidden" | "limited" | "error" | "signed-out";

/** A subscription as devices see it. */
export interface InboxItemView {
	chatId: string;
	title: string;
	app: string;
	enabled: boolean;
	perHourLimit: number;
	state: InboxState;
	deliveredLastHour: number;
	missed: number;
	/** Unix ms; 0 for none since the service started. */
	lastDeliveryAt: number;
}

/** What a device asks for (ChatInboxSet). */
export interface InboxSetInput {
	chatId: bigint;
	title: string;
	app: string;
	enabled: boolean;
	/** 0 keeps the current value (DEFAULT_PER_HOUR_LIMIT for a new one). */
	perHourLimit: number;
}

/** The sessions the turns go into: the core's own methods. */
export type InboxThreads = Pick<AgentCore, "list" | "send" | "create" | "onStatus">;

export interface ChatInboxOptions {
	store: InboxStore;
	/** Calls a tool of Chat's MCP with the machine's sign-in (never one an agent lists). */
	callChat: (tool: "get_me" | "list_chats" | "get_messages", args: Record<string, unknown>) => Promise<CallToolResult>;
	/** Who is signed in to Chat on the machine; "" for nobody. */
	account: () => string;
	threads: InboxThreads;
	/** The AI a chat's new session opens with: the machine's first signed-in one; "" for none. */
	provider: () => Promise<string>;
	log?: (line: string) => void;
	now?: () => number;
	/** INBOX_TIMING when unset (tests shorten it). */
	timing?: Partial<InboxTiming>;
}

/** What only the running service knows of a subscription. */
interface Live {
	state: InboxState;
	/** When each turn of the last hour went in. */
	delivered: number[];
	missed: number;
	lastDeliveryAt: number;
	/** Messages waiting for their turn, oldest first. */
	batch: InboxMessage[];
	batchStart: number;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** The batch is ready: it goes in as soon as the session is free. */
	due: boolean;
	delivering: boolean;
	probedAt: number;
	/** Kept from before the service started, not read since: what came meanwhile is counted, not pushed. */
	resumed: boolean;
}

function newLive(): Live {
	return { state: "active", delivered: [], missed: 0, lastDeliveryAt: 0, batch: [], batchStart: 0, flushTimer: undefined, due: false, delivering: false, probedAt: 0, resumed: false };
}

function invalid(message: string): AgentError {
	return new AgentError(ErrorCode.INVALID, message, { reason: ErrorReason.UNSPECIFIED });
}

export class ChatInbox {
	private readonly subs: InboxSubscription[];
	private readonly live = new Map<string, Live>();
	private readonly listeners = new Set<(items: InboxItemView[]) => void>();
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly timing: InboxTiming;
	private timer: ReturnType<typeof setInterval> | undefined;
	private started = false;
	private ticking = false;
	private lastTickAt = 0;
	private self: { account: string; id: number } | undefined;
	private lastEmitted = "";
	private unsubscribeStatus: (() => void) | undefined;

	constructor(private readonly opts: ChatInboxOptions) {
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => undefined);
		this.timing = { ...INBOX_TIMING, ...opts.timing };
		this.subs = opts.store.load();
		for (const sub of this.subs) this.live.set(sub.chatId, { ...newLive(), resumed: true });
		this.lastEmitted = JSON.stringify(this.list());
	}

	/** Starts listening when a subscription is on; a turn waiting for a busy session goes in once it is free. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribeStatus = this.opts.threads.onStatus((thread) => this.threadChanged(thread));
		this.syncTimer();
	}

	stop(): void {
		this.started = false;
		this.syncTimer();
		this.unsubscribeStatus?.();
		this.unsubscribeStatus = undefined;
		for (const live of this.live.values()) clearTimeout(live.flushTimer);
	}

	/** Whether the inbox reads Chat now (a subscription is on and the service started). */
	get polling(): boolean {
		return this.timer !== undefined;
	}

	/** Calls `fn` with every item each time a subscription, its state or its counters change; returns how to stop. */
	onChange(fn: (items: InboxItemView[]) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	list(): InboxItemView[] {
		const at = this.now();
		return this.subs.map((sub) => {
			const live = this.liveOf(sub);
			return {
				chatId: sub.chatId,
				title: sub.title,
				app: sub.app,
				enabled: sub.enabled,
				perHourLimit: sub.perHourLimit,
				state: sub.enabled ? live.state : "active",
				deliveredLastHour: live.delivered.filter((t) => at - t < HOUR_MS).length,
				missed: live.missed,
				lastDeliveryAt: live.lastDeliveryAt,
			};
		});
	}

	/** Subscribes a chat or changes its subscription (ChatInboxSet); every item after it. */
	set(input: InboxSetInput): InboxItemView[] {
		if (input.chatId <= 0n || input.chatId > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("chat id must be a positive integer");
		const limit = input.perHourLimit;
		if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PER_HOUR_LIMIT) throw invalid(`per_hour_limit must be 1 to ${MAX_PER_HOUR_LIMIT} (0 keeps it)`);
		const app = input.app.trim().toLowerCase();
		if (!/^[a-z0-9_-]{0,32}$/.test(app)) throw invalid("app must be a short lowercase name");
		// The title goes into the session's turns on one line.
		const title = input.title.replace(/\p{Cc}+/gu, " ").trim().slice(0, TITLE_MAX);
		const chatId = String(input.chatId);
		let sub = this.subs.find((s) => s.chatId === chatId);
		if (!sub) {
			if (this.subs.length >= MAX_SUBSCRIPTIONS) throw invalid(`at most ${MAX_SUBSCRIPTIONS} chats can be pushed into sessions`);
			sub = { chatId, title, app, enabled: input.enabled, perHourLimit: limit || DEFAULT_PER_HOUR_LIMIT, lastSeenSeq: null, createdAt: this.now() };
			this.subs.push(sub);
			this.live.set(chatId, newLive());
		} else {
			if (title) sub.title = title;
			sub.app = app;
			if (limit > 0) sub.perHourLimit = limit;
			if (sub.enabled !== input.enabled) {
				sub.enabled = input.enabled;
				// Paused or turned on again: what came meanwhile is not pushed.
				sub.lastSeenSeq = null;
				this.dropBatch(this.liveOf(sub));
				this.liveOf(sub).state = "active";
			}
		}
		// A device hears of a subscription only once it is on disk.
		this.opts.store.save(this.subs);
		this.log(`chat inbox: chat ${chatId} ${sub.enabled ? "on" : "off"} (${sub.perHourLimit} turns an hour)`);
		this.syncTimer();
		// A chat just turned on starts from its newest message now, not at the next tick.
		if (sub.enabled && sub.lastSeenSeq === null) this.kick();
		this.emit();
		return this.list();
	}

	/** Stops pushing a chat and forgets it (ChatInboxRemove); its session stays. */
	remove(chatId: bigint): InboxItemView[] {
		const id = String(chatId);
		const i = this.subs.findIndex((s) => s.chatId === id);
		if (i >= 0) {
			this.subs.splice(i, 1);
			const live = this.live.get(id);
			if (live) this.dropBatch(live);
			this.live.delete(id);
			this.opts.store.save(this.subs);
			this.log(`chat inbox: chat ${id} removed`);
			this.syncTimer();
			this.emit();
		}
		return this.list();
	}

	/** One look at Chat; ticks never overlap. Public for the timer and tests. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		this.lastTickAt = this.now();
		try {
			await this.look();
		} catch (err) {
			this.log(`chat inbox: ${(err as Error).message}`);
		} finally {
			this.ticking = false;
			this.emit();
		}
	}

	private async look(): Promise<void> {
		const enabled = this.subs.filter((s) => s.enabled);
		if (enabled.length === 0) return;
		const account = this.opts.account();
		if (account === "") {
			for (const sub of enabled) this.liveOf(sub).state = "signed-out";
			return;
		}
		let budget = CALLS_PER_TICK;
		if (this.self?.account !== account) {
			budget--;
			const me = answerOf(await this.opts.callChat("get_me", {}));
			const id = me.ok ? selfIdOf(me.value) : undefined;
			if (id === undefined) return this.failAll(enabled, me.ok ? "get_me named no user" : me.error);
			this.self = { account, id };
		}
		budget--;
		const listed = answerOf(await this.opts.callChat("list_chats", { limit: 100 }));
		if (!listed.ok) return this.failAll(enabled, listed.error);
		const tops = new Map(listedChatsOf(listed.value).chats.map((c) => [c.chatId, c.topSeq]));
		const missing: InboxSubscription[] = [];
		for (const sub of enabled) {
			const live = this.liveOf(sub);
			this.refreshLimit(sub, live);
			const top = tops.get(sub.chatId);
			if (top === undefined) {
				missing.push(sub);
				continue;
			}
			budget = await this.seen(sub, top, budget);
		}
		// Chats the list's page did not hold (older ones, or hidden from AI): asked for directly, now and then.
		for (const sub of missing) {
			const live = this.liveOf(sub);
			if (budget <= 0 || this.now() - live.probedAt < PROBE_MS) continue;
			live.probedAt = this.now();
			budget--;
			const probe = answerOf(await this.opts.callChat("get_messages", { chat_id: Number(sub.chatId), limit: 1 }));
			if (!probe.ok) {
				this.failed(sub, probe.error);
				continue;
			}
			const newest = historyOf(probe.value).messages.at(-1)?.seq ?? 0;
			budget = await this.seen(sub, newest, budget);
		}
		// Turns that waited for their session, or failed to go in: tried again.
		for (const sub of enabled) void this.deliver(sub);
	}

	/** The chat's newest message is `top`: starts it there, or reads what came since the last one seen. */
	private async seen(sub: InboxSubscription, top: number, budget: number): Promise<number> {
		const live = this.liveOf(sub);
		if (live.resumed) {
			live.resumed = false;
			// The service was off: what came meanwhile is only counted (seqs are the chat's, every sender's).
			if (sub.lastSeenSeq !== null && top > sub.lastSeenSeq && live.state !== "hidden") {
				live.missed += top - sub.lastSeenSeq;
				sub.lastSeenSeq = top;
				this.save();
				return budget;
			}
		}
		if (live.state === "hidden" || sub.lastSeenSeq === null) {
			// Shown again, or just subscribed: from its newest message on.
			sub.lastSeenSeq = top;
			live.state = "active";
			this.save();
			return budget;
		}
		// Read again: no longer failing (a turn that failed to go in stays "error" until it goes).
		if ((live.state === "error" && !live.due) || live.state === "signed-out") live.state = "active";
		if (top <= sub.lastSeenSeq) return budget;
		return this.fetch(sub, budget);
	}

	/** Reads the chat's messages newer than the last seen, a page a call, within `budget` calls; the calls left. */
	private async fetch(sub: InboxSubscription, budget: number): Promise<number> {
		const self = this.self?.id;
		while (budget > 0 && sub.lastSeenSeq !== null) {
			budget--;
			const page = answerOf(await this.opts.callChat("get_messages", { chat_id: Number(sub.chatId), offset_seq: sub.lastSeenSeq, direction: "newer", limit: PAGE_LIMIT }));
			if (!page.ok) {
				this.failed(sub, page.error);
				return budget;
			}
			const from = sub.lastSeenSeq;
			const { messages, hasNewer } = historyOf(page.value);
			const fresh = messages.filter((m) => m.seq > from);
			if (fresh.length === 0) return budget;
			sub.lastSeenSeq = fresh[fresh.length - 1]?.seq ?? from;
			this.save();
			this.intake(sub, fresh.filter((m) => !m.skip && m.fromId !== self));
			if (!hasNewer) return budget;
		}
		return budget;
	}

	/** New messages of others: into the batch, or counted as missed while the hour's turns are spent. */
	private intake(sub: InboxSubscription, messages: InboxMessage[]): void {
		if (messages.length === 0) return;
		const live = this.liveOf(sub);
		if (this.refreshLimit(sub, live)) {
			live.missed += messages.length;
			return;
		}
		if (live.batch.length === 0) live.batchStart = this.now();
		live.batch.push(...messages);
		const over = live.batch.length - BATCH_MAX;
		if (over > 0) {
			live.batch.splice(0, over);
			live.missed += over;
		}
		if (live.due) return; // a turn waits for its session already: these go with it
		clearTimeout(live.flushTimer);
		const at = this.now();
		const wait = Math.max(0, Math.min(at + this.timing.quietMs + QUIET_SLACK_MS, live.batchStart + this.timing.maxWaitMs) - at);
		live.flushTimer = setTimeout(() => {
			live.flushTimer = undefined;
			live.due = true;
			void this.deliver(sub);
		}, wait);
		live.flushTimer.unref?.();
	}

	/** Puts the ready batch into the chat's session, unless that session is busy (it goes once the session is free). */
	private async deliver(sub: InboxSubscription): Promise<void> {
		const live = this.liveOf(sub);
		if (!live.due || live.delivering || live.batch.length === 0 || !this.subs.includes(sub)) return;
		if (!sub.enabled) return this.dropBatch(live);
		if (this.refreshLimit(sub, live)) {
			live.missed += live.batch.length;
			this.dropBatch(live);
			return this.emit();
		}
		const thread = this.chatThread(sub.chatId);
		if (thread && thread.state !== ThreadState.IDLE) return;
		live.delivering = true;
		const messages = live.batch;
		live.batch = [];
		live.due = false;
		const text = inboxTurn(sub, messages);
		try {
			if (thread) await this.opts.threads.send(thread.id, text, "");
			else {
				const provider = await this.opts.provider();
				if (provider === "") throw new Error("no AI is signed in on this machine");
				await this.opts.threads.create({
					provider,
					model: "",
					dir: "",
					text,
					consent: { sensitive: false, projectSettings: false },
					device: DEVICE,
					chat: { chatId: BigInt(sub.chatId), title: sub.title, app: sub.app },
				});
			}
			const at = this.now();
			live.delivered.push(at);
			live.lastDeliveryAt = at;
			live.state = "active";
		} catch (err) {
			this.log(`chat inbox: chat ${sub.chatId}: turn not delivered (${(err as Error).message})`);
			// Tried again at the next tick, with what came meanwhile.
			live.batch = [...messages, ...live.batch];
			live.due = true;
			live.state = "error";
		} finally {
			live.delivering = false;
			this.emit();
		}
	}

	/** A session went idle: a turn waiting for it goes in. */
	private threadChanged(thread: ThreadSummary): void {
		if (thread.chatId === 0n || thread.state !== ThreadState.IDLE) return;
		const sub = this.subs.find((s) => s.chatId === String(thread.chatId));
		if (sub) void this.deliver(sub);
	}

	/** The live session of a chat: the same one ThreadCreate.chat opens. */
	private chatThread(chatId: string): ThreadSummary | undefined {
		const id = BigInt(chatId);
		return this.opts.threads.list().find((t) => t.chatId === id && !t.archived && t.kind !== ThreadKind.ADVISOR);
	}

	/** Drops turns older than an hour; true (state "limited") while the hour's turns are spent. */
	private refreshLimit(sub: InboxSubscription, live: Live): boolean {
		const at = this.now();
		live.delivered = live.delivered.filter((t) => at - t < HOUR_MS);
		const limited = live.delivered.length >= sub.perHourLimit;
		if (limited) live.state = "limited";
		else if (live.state === "limited") live.state = "active";
		return limited;
	}

	private failed(sub: InboxSubscription, error: string): void {
		const live = this.liveOf(sub);
		if (isHiddenError(error)) {
			// Nothing of a chat hidden from AI goes into a session, not even what waited.
			if (live.state !== "hidden") this.log(`chat inbox: chat ${sub.chatId} is hidden from AI, not pushed`);
			live.state = "hidden";
			this.dropBatch(live);
			return;
		}
		this.log(`chat inbox: chat ${sub.chatId} not read (${error.slice(0, 200)})`);
		live.state = "error";
	}

	private failAll(subs: readonly InboxSubscription[], error: string): void {
		this.log(`chat inbox: Chat not read (${error.slice(0, 200)})`);
		for (const sub of subs) {
			const live = this.liveOf(sub);
			if (live.state !== "hidden") live.state = "error";
		}
	}

	private dropBatch(live: Live): void {
		clearTimeout(live.flushTimer);
		live.flushTimer = undefined;
		live.batch = [];
		live.due = false;
	}

	private liveOf(sub: InboxSubscription): Live {
		let live = this.live.get(sub.chatId);
		if (!live) {
			live = newLive();
			this.live.set(sub.chatId, live);
		}
		return live;
	}

	/** Polls while the service runs and a subscription is on; stops otherwise. */
	private syncTimer(): void {
		const want = this.started && this.subs.some((s) => s.enabled);
		if (want && !this.timer) {
			this.timer = setInterval(() => void this.tick(), this.timing.pollMs);
			this.timer.unref?.();
		} else if (!want && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** A tick now, unless one ran a moment ago (a device switching quickly does not flood Chat). */
	private kick(): void {
		if (!this.timer || this.now() - this.lastTickAt < 1_000) return;
		void this.tick();
	}

	private save(): void {
		try {
			this.opts.store.save(this.subs);
		} catch (err) {
			this.log(`chat inbox: subscriptions not saved (${(err as Error).message})`);
		}
	}

	private emit(): void {
		const items = this.list();
		const key = JSON.stringify(items);
		if (key === this.lastEmitted) return;
		this.lastEmitted = key;
		for (const fn of this.listeners) fn(items);
	}
}

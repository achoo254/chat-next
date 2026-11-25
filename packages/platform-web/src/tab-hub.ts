// Routes ChatCore calls between tabs. Every tab's worker runs a hub; the
// hub holding the leader lock runs the real core and answers calls from
// the other tabs over a BroadcastChannel, and broadcasts change events to
// them. When the leader goes away, the next hub takes the lock, starts the
// core on the same database and every follower re-sends its unanswered
// calls (writes carry idempotency keys, see ChatCore.sendText).
//
// A tab left open across a deploy keeps the build it loaded, and as leader it
// would keep serving every newer tab with its older core and database schema.
// So each tab says which build it runs (at start and to each new leader); a
// leader that hears of a newer build closes its core, lets the lock go to the
// next tab in line and queues again behind it, carrying on as a follower.
//
// A tab that leads but finds the database files still held by another context (a tab
// of an older build that stepped down without letting them go, or one slow to end) asks
// the other tabs to let go ("release"), waits and tries again; a tab that is not leading
// then gives back what its worker holds (TabHubOptions.releaseStorage).
import type { SessionEndReason } from "@achoo254/chat-core";
import type { Unsubscribe } from "@achoo254/chat-platform";
import type { LeaderLock } from "./leader.ts";
import {
	deserializeError,
	isCoreMethod,
	serializeError,
	type CallResult,
	type CoreMethod,
	type HubMessage,
	type SerializedError,
} from "./protocol.ts";

/** The part of BroadcastChannel the hub uses. */
export interface ChannelLike {
	postMessage(message: HubMessage): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	close(): void;
}

/** The core as run by the leader. */
export interface LeaderCore {
	invoke(method: CoreMethod, args: unknown[]): Promise<unknown>;
	subscribe(listener: (keys: readonly string[]) => void): Unsubscribe;
	/** Closes the database so the next leader can open it. */
	close(): Promise<void>;
}

export interface TabHubOptions {
	readonly tabId: string;
	/** When this tab's build was made (WorkerConfig.build); 0 or absent: unknown, never yields for it. */
	readonly build?: number;
	readonly channel: ChannelLike;
	readonly lock: LeaderLock;
	/** Starts the core once this tab leads; throwing answers every call with that error. */
	readonly startLeader: () => Promise<LeaderCore>;
	/** Whether a start failed because another context holds the database files. */
	readonly storageBusy?: (error: unknown) => boolean;
	/** Gives back the database files this worker holds; asked of a tab that is not leading. */
	readonly releaseStorage?: () => Promise<void>;
	/** Waits between starts of a leader that found the files held; defaults to a timer. */
	readonly wait?: (ms: number) => Promise<void>;
	readonly onEvents: (keys: readonly string[]) => void;
	readonly onEnded: (reason: SessionEndReason) => void;
	readonly onRole: (role: "leader" | "follower") => void;
	readonly onUser: (userId: number) => void;
	/** Leader only: whether any tab is in the foreground. */
	readonly onForeground: (foreground: boolean) => void;
	/** Leader only: some tab saw the network come back. */
	readonly onOnline: () => void;
	readonly onError: (error: unknown, context: string) => void;
}

interface PendingCall {
	readonly method: CoreMethod;
	readonly args: unknown[];
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

const HANDLED_LIMIT = 500;

/** How many times a leader asks the other tabs to let go and tries again, and the first wait. */
const RELEASE_ATTEMPTS = 4;
const RELEASE_WAIT_MS = 400;

const UNSUPPORTED_METHOD: SerializedError = { name: "Error", message: "unsupported method" };

function isHubMessage(value: unknown): value is HubMessage {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export class TabHub {
	private role: "leader" | "follower" = "follower";
	private core: LeaderCore | null = null;
	private coreError: SerializedError | null = null;
	private ready = false;
	private nextCall = 0;
	private readonly pending = new Map<string, PendingCall>();
	/** Leader: results by call id, to answer a re-sent call without running it twice. */
	private readonly handled = new Map<string, CallResult>();
	/** Leader: calls from other tabs that arrived while the core was starting. */
	private waiting: { id: string; method: CoreMethod; args: unknown[] }[] = [];
	private readonly presence = new Map<string, boolean>();
	private foreground = true;
	private closed = false;
	/** The newest build another tab announced since this tab last led or yielded. */
	private newestBuild = 0;
	private yielding = false;

	constructor(private readonly options: TabHubOptions) {}

	get isLeader(): boolean {
		return this.role === "leader";
	}

	start(foreground: boolean): void {
		this.foreground = foreground;
		this.options.channel.addEventListener("message", (event) => {
			if (isHubMessage(event.data)) this.receive(event.data);
		});
		this.options.channel.postMessage({ type: "presence", tabId: this.options.tabId, foreground });
		this.announceBuild();
		this.options.lock
			.acquire(
				() => this.becomeLeader(),
				(err) => this.options.onError(err, "start leader"),
			)
			.catch((err: unknown) => this.options.onError(err, "leader lock"));
	}

	/** Runs a core method on the leader, wherever it is. */
	call(method: CoreMethod, args: unknown[]): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("tab hub is closed"));
		const id = `${this.options.tabId}:${++this.nextCall}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { method, args, resolve, reject });
			this.dispatch(id);
		});
	}

	setForeground(foreground: boolean): void {
		this.foreground = foreground;
		if (this.isLeader) this.options.onForeground(this.anyForeground());
		else this.options.channel.postMessage({ type: "presence", tabId: this.options.tabId, foreground });
	}

	reportOnline(): void {
		if (this.isLeader) this.options.onOnline();
		else this.options.channel.postMessage({ type: "online" });
	}

	/** Leader: tells every tab the session ended. */
	broadcastEnded(reason: SessionEndReason): void {
		this.options.channel.postMessage({ type: "ended", reason });
		this.options.onEnded(reason);
	}

	/** Leader: tells every tab who is signed in. */
	broadcastUser(userId: number): void {
		this.options.channel.postMessage({ type: "user", userId });
		this.options.onUser(userId);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.isLeader) {
			this.options.channel.postMessage({ type: "presence", tabId: this.options.tabId, foreground: false });
		}
		for (const call of this.pending.values()) call.reject(new Error("tab hub is closed"));
		this.pending.clear();
		const core = this.core;
		this.core = null;
		const closing = core === null ? Promise.resolve() : core.close();
		closing
			.catch((err: unknown) => this.options.onError(err, "close core"))
			.finally(() => {
				// Release only after the database is closed: the next leader opens it.
				this.options.lock.release();
				this.options.channel.close();
			});
	}

	private anyForeground(): boolean {
		return this.foreground || [...this.presence.values()].some(Boolean);
	}

	private dispatch(id: string): void {
		const call = this.pending.get(id);
		if (call === undefined) return;
		if (this.isLeader) {
			if (this.ready) void this.runOwn(id, call);
			return; // runs once the core is up (becomeLeader drains pending)
		}
		this.options.channel.postMessage({ type: "call", id, method: call.method, args: call.args });
	}

	private async runOwn(id: string, call: PendingCall): Promise<void> {
		const result = await this.execute(id, call.method, call.args);
		this.settle(id, result);
	}

	private settle(id: string, result: CallResult): void {
		const call = this.pending.get(id);
		if (call === undefined) return;
		this.pending.delete(id);
		if (result.ok) call.resolve(result.value);
		else call.reject(deserializeError(result.error));
	}

	private async execute(id: string, method: CoreMethod, args: unknown[]): Promise<CallResult> {
		const cached = this.handled.get(id);
		if (cached !== undefined) return cached;
		let result: CallResult;
		if (this.core === null) {
			result = { ok: false, error: this.coreError ?? { name: "Error", message: "core is not running" } };
		} else {
			try {
				result = { ok: true, value: await this.core.invoke(method, args) };
			} catch (err) {
				result = { ok: false, error: serializeError(err) };
			}
		}
		this.handled.set(id, result);
		if (this.handled.size > HANDLED_LIMIT) {
			const oldest = this.handled.keys().next().value;
			if (oldest !== undefined) this.handled.delete(oldest);
		}
		return result;
	}

	private async becomeLeader(): Promise<void> {
		if (this.closed) return;
		this.role = "leader";
		this.options.onRole("leader");
		try {
			let core: LeaderCore;
			try {
				core = await this.options.startLeader();
			} catch (err) {
				core = await this.startAgainAskingToRelease(err);
			}
			this.core = core;
			core.subscribe((keys) => {
				this.options.channel.postMessage({ type: "events", keys });
				this.options.onEvents(keys);
			});
		} catch (err) {
			this.coreError = serializeError(err);
			this.options.onError(err, "start core");
		}
		this.ready = true;
		this.options.onForeground(this.anyForeground());
		this.options.channel.postMessage({ type: "leader" });
		for (const [id, call] of this.pending) void this.runOwn(id, call);
		const waiting = this.waiting;
		this.waiting = [];
		for (const call of waiting) void this.answer(call.id, call.method, call.args);
		this.yieldIfOutdated();
	}

	/**
	 * The first start failed with `failure`. While that is the database files being held by
	 * another context, asks the other tabs to let go and tries again (a few times, waiting
	 * longer each time); any other failure, or the last one, is thrown.
	 */
	private async startAgainAskingToRelease(failure: unknown): Promise<LeaderCore> {
		const wait = this.options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		let error = failure;
		for (let attempt = 1; attempt < RELEASE_ATTEMPTS; attempt++) {
			if (this.closed || this.options.storageBusy?.(error) !== true) break;
			this.options.channel.postMessage({ type: "release", tabId: this.options.tabId });
			await wait(RELEASE_WAIT_MS * attempt);
			try {
				return await this.options.startLeader();
			} catch (err) {
				error = err;
			}
		}
		throw error;
	}

	private announceBuild(): void {
		const build = this.options.build ?? 0;
		if (build > 0) this.options.channel.postMessage({ type: "build", tabId: this.options.tabId, build });
	}

	/** Leader: lets a tab of a newer build lead. */
	private yieldIfOutdated(): void {
		const own = this.options.build ?? 0;
		if (!this.isLeader || !this.ready || this.yielding || this.closed || own <= 0 || this.newestBuild <= own) return;
		void this.yieldLead();
	}

	/**
	 * Closes the core (the next leader opens the database) and queues for the lock
	 * again behind the tabs waiting for it. Calls still pending here are sent again
	 * when the next leader announces itself, as after any change of leader.
	 */
	private async yieldLead(): Promise<void> {
		this.yielding = true;
		this.role = "follower";
		this.ready = false;
		this.options.onRole("follower");
		// Forgotten: the newer tab announces itself again to whoever leads next.
		this.newestBuild = 0;
		this.handled.clear();
		this.waiting = [];
		const core = this.core;
		this.core = null;
		this.coreError = null;
		try {
			await core?.close();
		} catch (err) {
			this.options.onError(err, "close core");
		}
		this.yielding = false;
		if (this.closed) return;
		this.options.lock
			.requeue(
				() => this.becomeLeader(),
				(err) => this.options.onError(err, "start leader"),
			)
			.catch((err: unknown) => this.options.onError(err, "leader lock"));
	}

	private async answer(id: string, method: CoreMethod, args: unknown[]): Promise<void> {
		const result = await this.execute(id, method, args);
		this.options.channel.postMessage({ type: "result", id, ...result });
	}

	private receive(message: HubMessage): void {
		switch (message.type) {
			case "call":
				if (!this.isLeader) return;
				if (!isCoreMethod(message.method) || !Array.isArray(message.args)) {
					// A tab of another build asks for a method this one lacks: answer
					// instead of dropping the call, so that tab does not wait forever.
					this.options.channel.postMessage({ type: "result", id: message.id, ok: false, error: UNSUPPORTED_METHOD });
					return;
				}
				if (this.ready) void this.answer(message.id, message.method, message.args);
				else this.waiting.push({ id: message.id, method: message.method, args: message.args });
				return;
			case "result":
				this.settle(message.id, message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error });
				return;
			case "events":
				if (!this.isLeader) this.options.onEvents(message.keys);
				return;
			case "leader":
				// A new leader is up: whatever it did not answer yet, ask again.
				if (this.isLeader) return;
				this.options.channel.postMessage({ type: "presence", tabId: this.options.tabId, foreground: this.foreground });
				this.announceBuild();
				for (const id of this.pending.keys()) this.dispatch(id);
				return;
			case "build":
				if (message.build > this.newestBuild) this.newestBuild = message.build;
				this.yieldIfOutdated();
				return;
			case "presence":
				this.presence.set(message.tabId, message.foreground);
				if (this.isLeader && this.ready) this.options.onForeground(this.anyForeground());
				return;
			case "online":
				if (this.isLeader) this.options.onOnline();
				return;
			case "ended":
				this.options.onEnded(message.reason);
				return;
			case "user":
				this.options.onUser(message.userId);
				return;
			case "release":
				// Only a tab that is not leading holds files it has no use for.
				if (this.isLeader || message.tabId === this.options.tabId) return;
				void this.options.releaseStorage?.().catch((err: unknown) => this.options.onError(err, "release storage"));
				return;
		}
	}
}

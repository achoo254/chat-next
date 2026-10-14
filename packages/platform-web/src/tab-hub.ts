// Routes ChatCore calls between tabs. Every tab's worker runs a hub; the
// hub holding the leader lock runs the real core and answers calls from
// the other tabs over a BroadcastChannel, and broadcasts change events to
// them. When the leader goes away, the next hub takes the lock, starts the
// core on the same database and every follower re-sends its unanswered
// calls (writes carry idempotency keys, see ChatCore.sendText).
import type { SessionEndReason } from "@app/core";
import type { Unsubscribe } from "@app/platform";
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
	readonly channel: ChannelLike;
	readonly lock: LeaderLock;
	/** Starts the core once this tab leads; throwing answers every call with that error. */
	readonly startLeader: () => Promise<LeaderCore>;
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
			const core = await this.options.startLeader();
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
	}

	private async answer(id: string, method: CoreMethod, args: unknown[]): Promise<void> {
		const result = await this.execute(id, method, args);
		this.options.channel.postMessage({ type: "result", id, ...result });
	}

	private receive(message: HubMessage): void {
		switch (message.type) {
			case "call":
				if (!this.isLeader || !isCoreMethod(message.method) || !Array.isArray(message.args)) return;
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
				for (const id of this.pending.keys()) this.dispatch(id);
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
		}
	}
}

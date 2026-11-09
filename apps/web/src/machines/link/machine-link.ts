// One end-to-end encrypted link to one machine (ADR 0013), shared by every
// thread of that machine: one WebSocket, the handshake with the pinned
// machine key, sealed frames handled strictly one at a time (the frame
// counters must stay in order), requests matched by id, a ping every 10 s
// while the user looks at the machine, and reconnection with backoff. Every
// few failures it asks the directory again for the tunnel address (it changes
// when the agent reconnects). After reconnecting it resubscribes each watched
// thread from its cursor; a ThreadReset drops the thread's items and the
// snapshot that follows fills them again. A thread's ThreadInfo (what the
// user's terminal statusline shows) is kept apart from its journal.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { backoffDelay } from "@achoo254/chat-core";
import {
	ErrorCode,
	ErrorReason,
	FrameSchema,
	HandshakeErrorCode,
	ThreadState,
	type Frame,
	type Item,
	type MachineInfo,
	type MachineProfile,
	type ThreadInfo,
	type ThreadSummary,
} from "@achoo254/chat-proto/remote/remote";
import { HandshakeFailure, startHandshake, type KeyPair, type Session } from "@achoo254/chat-remote-protocol";
import { applyItems, EMPTY_JOURNAL, resetJournal, type Journal } from "../transcript/reducer.ts";
import type { PendingSend, ShownAttachment } from "../transcript/tool-fold.ts";
import { allowedTunnel, frameBytes, type SocketFactory, type SocketLike } from "./socket.ts";

export const PING_MS = 10_000;
/** No frame for this long while pinging: the link is dead. */
const SILENCE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF = { baseMs: 1_000, maxMs: 30_000 };
/** After this many failed attempts in a row, ask the directory for a new address. */
const REFRESH_AFTER = 3;

export type LinkFailure =
	/** No machine key is pinned on this device: pair first. */
	| "unpaired"
	/** The machine does not know or no longer accepts this device. */
	| "refused"
	| "revoked"
	/** The machine answered with another key than the pinned one. */
	| "key-changed"
	| "version";

export type LinkStatus =
	| { readonly kind: "idle" }
	| { readonly kind: "connecting"; readonly attempt: number }
	| { readonly kind: "open" }
	| { readonly kind: "offline"; readonly attempt: number }
	| { readonly kind: "failed"; readonly reason: LinkFailure };

export interface LinkState {
	readonly status: LinkStatus;
	readonly info: MachineInfo | null;
	/** Newest first, as the machine lists them. */
	readonly threads: readonly ThreadSummary[];
	/** The thread list arrived at least once on this link. */
	readonly listed: boolean;
	readonly openSessions: number;
	readonly maxSessions: number;
	readonly journals: ReadonlyMap<string, Journal>;
	/** Items fetched in full (long diffs and outputs), by item id. */
	readonly full: ReadonlyMap<string, Item>;
	readonly pending: ReadonlyMap<string, readonly PendingSend[]>;
	/** Each watched thread's statusline data (ThreadInfo), by thread id. */
	readonly threadInfo: ReadonlyMap<string, ThreadInfo>;
	/**
	 * The machine's Claude profile, its profiles and the profile each session
	 * runs with, as the machine last announced them (whole, unasked); null
	 * until it does (tunelo before 2.0.2 never does).
	 */
	readonly machineProfile: MachineProfile | null;
}

/**
 * The machine refused a request. `message` is the machine's English; `reason`
 * and `subject` say what went wrong for wording it in the user's language
 * (UNSPECIFIED from machines older than tunelo 2.0.1).
 */
export class RemoteError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly reason: ErrorReason = ErrorReason.UNSPECIFIED,
		readonly subject = "",
	) {
		super(message);
	}
}

/** The link is not open (or closed before the answer came). */
export class OfflineError extends Error {
	constructor() {
		super("the machine is not connected");
	}
}

export interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
	now(): number;
}

const systemTimers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	now: () => Date.now(),
};

export interface LinkDeps {
	readonly device: () => Promise<KeyPair>;
	readonly deviceName: string;
	readonly pinned: () => Promise<Uint8Array | null>;
	/** The tunnel address as the directory knows it now ("" when down). */
	readonly tunnelUrl: () => string;
	/** Asks the directory again; resolves with the new address. */
	readonly refreshTunnel: () => Promise<string>;
	readonly socket: SocketFactory;
	readonly timers?: Timers;
	readonly random?: () => number;
	readonly newId?: () => string;
}

type FrameBody = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

interface Waiter {
	resolve(frame: Frame): void;
	reject(err: Error): void;
	timer: unknown;
}

const INITIAL: LinkState = {
	status: { kind: "idle" },
	info: null,
	threads: [],
	listed: false,
	openSessions: 0,
	maxSessions: 0,
	journals: new Map(),
	full: new Map(),
	pending: new Map(),
	threadInfo: new Map(),
	machineProfile: null,
};

export class MachineLink {
	private current: LinkState = INITIAL;
	private readonly listeners = new Set<() => void>();
	private readonly timers: Timers;
	private readonly random: () => number;
	private readonly newId: () => string;
	private socket: SocketLike | null = null;
	private session: Session | null = null;
	/** Messages of the current socket, handled one at a time. */
	private queue: Promise<void> = Promise.resolve();
	private readonly waiters = new Map<string, Waiter>();
	private readonly watched = new Map<string, number>();
	private attempt = 0;
	private retryTimer: unknown = null;
	private pingTimer: unknown = null;
	private lastHeard = 0;
	private active = false;
	private stopped = true;
	private serial = 0;

	constructor(private readonly deps: LinkDeps) {
		this.timers = deps.timers ?? systemTimers;
		this.random = deps.random ?? Math.random;
		this.newId = deps.newId ?? (() => crypto.randomUUID());
	}

	// --- state for React -----------------------------------------------------

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly snapshot = (): LinkState => this.current;

	private set(change: Partial<LinkState>): void {
		this.current = { ...this.current, ...change };
		for (const listener of this.listeners) listener();
	}

	journal(threadId: string): Journal {
		return this.current.journals.get(threadId) ?? EMPTY_JOURNAL;
	}

	// --- lifecycle -----------------------------------------------------------

	/** Connects (once a key is pinned) and keeps reconnecting until stop(). */
	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.attempt = 0;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.timers.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.dropSocket();
		this.set({ status: { kind: "idle" } });
	}

	/** Reconnect now instead of waiting for the backoff (app back in the foreground, network back). */
	wake(): void {
		if (this.stopped) return;
		const kind = this.current.status.kind;
		if (kind === "offline" || kind === "idle") {
			this.timers.clearTimeout(this.retryTimer);
			this.retryTimer = null;
			void this.connect();
		}
	}

	/**
	 * The user is looking at this machine: ping every 10 s so the machine
	 * holds back Web Pushes. Off while the app is hidden or elsewhere.
	 */
	setActive(active: boolean): void {
		if (this.active === active) return;
		this.active = active;
		if (active && this.current.status.kind === "open") this.ping();
	}

	/** Shows a thread: subscribed now and after every reconnect, until the returned function runs. */
	watch(threadId: string): () => void {
		const count = this.watched.get(threadId) ?? 0;
		this.watched.set(threadId, count + 1);
		if (count === 0 && this.current.status.kind === "open") this.subscribeThread(threadId);
		return () => {
			const left = (this.watched.get(threadId) ?? 1) - 1;
			if (left <= 0) this.watched.delete(threadId);
			else this.watched.set(threadId, left);
		};
	}

	// --- requests ------------------------------------------------------------

	/** Sends a request; resolves with the machine's answer, rejects with RemoteError or OfflineError. */
	request(body: FrameBody): Promise<Frame> {
		const session = this.session;
		const socket = this.socket;
		if (session === null || socket === null || this.current.status.kind !== "open") return Promise.reject(new OfflineError());
		const id = `${++this.serial}`;
		return new Promise<Frame>((resolve, reject) => {
			const timer = this.timers.setTimeout(() => {
				this.waiters.delete(id);
				reject(new OfflineError());
			}, REQUEST_TIMEOUT_MS);
			this.waiters.set(id, { resolve, reject, timer });
			try {
				socket.send(new Uint8Array(session.seal(create(FrameSchema, { id, body }))));
			} catch (err) {
				this.timers.clearTimeout(timer);
				this.waiters.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/**
	 * Sends a message, with files uploaded for it before (their upload ids);
	 * it shows at once and stays until the machine echoes it.
	 */
	async send(threadId: string, text: string, attachments: readonly ShownAttachment[] = []): Promise<void> {
		const clientMsgId = this.newId();
		const list = this.current.pending.get(threadId) ?? [];
		this.setPending(threadId, [...list, { clientMsgId, text, ...(attachments.length > 0 ? { attachments } : {}) }]);
		try {
			await this.request({ case: "threadSend", value: { threadId, text, clientMsgId, attachmentIds: attachments.map((a) => a.id) } });
		} catch (err) {
			this.setPending(
				threadId,
				(this.current.pending.get(threadId) ?? []).filter((p) => p.clientMsgId !== clientMsgId),
			);
			throw err;
		}
	}

	private setPending(threadId: string, list: readonly PendingSend[]): void {
		const pending = new Map(this.current.pending);
		if (list.length === 0) pending.delete(threadId);
		else pending.set(threadId, list);
		this.set({ pending });
	}

	// --- connection ----------------------------------------------------------

	private async connect(): Promise<void> {
		if (this.stopped) return;
		this.dropSocket();
		this.attempt += 1;
		this.set({ status: { kind: "connecting", attempt: this.attempt } });
		let pinned: Uint8Array | null;
		let device: KeyPair;
		try {
			[pinned, device] = await Promise.all([this.deps.pinned(), this.deps.device()]);
		} catch {
			return this.retry();
		}
		if (this.stopped) return;
		if (pinned === null) return this.fail("unpaired");
		let url = this.deps.tunnelUrl();
		// The first attempt without an address (a page opened straight from a
		// link, before the directory loaded) asks the directory at once.
		if ((this.attempt === 1 && url === "") || (this.attempt > 1 && (this.attempt - 1) % REFRESH_AFTER === 0)) {
			url = await this.deps.refreshTunnel().catch(() => url);
			if (this.stopped) return;
		}
		// No address (the machine is off or its agent is reconnecting the
		// tunnel): try again later, asking the directory every few attempts.
		if (url === "" || !allowedTunnel(url)) return this.retry();
		let socket: SocketLike;
		try {
			socket = this.deps.socket(url);
		} catch {
			return this.retry();
		}
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		this.queue = Promise.resolve();
		const mine = () => this.socket === socket;
		let handshake: Awaited<ReturnType<typeof startHandshake>> | null = null;
		socket.onopen = () => {
			if (!mine()) return;
			void startHandshake({ device, deviceName: this.deps.deviceName, trust: { kind: "pinned", machineKey: pinned } }).then(
				(started) => {
					if (!mine()) return;
					handshake = started;
					socket.send(new Uint8Array(started.hello));
				},
				() => this.lost(socket),
			);
		};
		socket.onmessage = (event) => {
			const bytes = frameBytes(event.data);
			if (bytes === null || !mine()) return;
			this.queue = this.queue
				.then(async () => {
					if (!mine()) return;
					this.lastHeard = this.timers.now();
					if (this.session === null) {
						if (handshake === null) throw new Error("message before the handshake started");
						const { session } = await handshake.finish(bytes);
						if (!mine()) return;
						this.session = session;
						this.opened();
						return;
					}
					this.dispatch(this.session.open(bytes));
				})
				.catch((err: unknown) => this.broken(socket, err));
		};
		// After the messages before it: a refusal arrives just before the close.
		socket.onclose = () => {
			this.queue = this.queue.then(() => this.lost(socket));
		};
		socket.onerror = () => undefined;
	}

	private opened(): void {
		this.attempt = 0;
		this.set({ status: { kind: "open" } });
		this.timers.clearInterval(this.pingTimer);
		this.pingTimer = this.timers.setInterval(() => this.tick(), PING_MS);
		this.request({ case: "machineInfoRequest", value: {} }).catch(() => undefined);
		this.request({ case: "threadList", value: {} }).catch(() => undefined);
		for (const threadId of this.watched.keys()) this.subscribeThread(threadId);
		if (this.active) this.ping();
	}

	private subscribeThread(threadId: string): void {
		const cursor = this.current.journals.get(threadId)?.cursor ?? { epoch: 0n, seq: 0n };
		this.request({ case: "threadSubscribe", value: { threadId, cursor } }).catch(() => undefined);
	}

	private ping(): void {
		this.request({ case: "ping", value: {} }).catch(() => undefined);
	}

	private tick(): void {
		if (this.current.status.kind !== "open" || !this.active) return;
		if (this.timers.now() - this.lastHeard > SILENCE_MS) {
			const socket = this.socket;
			if (socket !== null) this.lost(socket);
			return;
		}
		this.ping();
	}

	/** A frame could not be opened or the handshake failed. */
	private broken(socket: SocketLike, err: unknown): void {
		if (this.socket !== socket) return;
		if (err instanceof HandshakeFailure) {
			switch (err.code) {
				case HandshakeErrorCode.UNKNOWN_DEVICE:
					return this.fail("refused");
				case HandshakeErrorCode.REVOKED:
					return this.fail("revoked");
				case HandshakeErrorCode.VERSION_UNSUPPORTED:
					return this.fail("version");
				case HandshakeErrorCode.BAD_PROOF:
					return this.fail("key-changed");
				default:
					break;
			}
		}
		// A FrameError (replayed, forged or malformed frame) or anything unexpected: start over.
		this.lost(socket);
	}

	/** The socket closed or went silent: reconnect after the backoff. */
	private lost(socket: SocketLike): void {
		if (this.socket !== socket) return;
		this.dropSocket();
		if (this.stopped || this.current.status.kind === "failed") return;
		this.retry();
	}

	private retry(): void {
		if (this.stopped) return;
		this.set({ status: { kind: "offline", attempt: this.attempt } });
		this.timers.clearTimeout(this.retryTimer);
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, backoffDelay(this.attempt - 1, BACKOFF, this.random));
	}

	private fail(reason: LinkFailure): void {
		this.dropSocket();
		this.set({ status: { kind: "failed", reason } });
	}

	private dropSocket(): void {
		this.timers.clearInterval(this.pingTimer);
		this.pingTimer = null;
		const socket = this.socket;
		this.socket = null;
		this.session = null;
		if (socket !== null) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onclose = null;
			try {
				socket.close(1000);
			} catch {
				// already closed
			}
		}
		for (const waiter of this.waiters.values()) {
			this.timers.clearTimeout(waiter.timer);
			waiter.reject(new OfflineError());
		}
		this.waiters.clear();
	}

	// --- frames from the machine ----------------------------------------------

	private dispatch(frame: Frame): void {
		const b = frame.body;
		switch (b.case) {
			case "threadItems": {
				const journals = new Map(this.current.journals);
				journals.set(b.value.threadId, applyItems(this.journal(b.value.threadId), b.value.items, b.value.cursor));
				const echoed = new Set(b.value.items.flatMap((i) => (i.body.case === "text" && i.body.value.clientMsgId !== "" ? [i.body.value.clientMsgId] : [])));
				const pending = this.current.pending.get(b.value.threadId);
				if (pending !== undefined && echoed.size > 0) {
					const left = pending.filter((p) => !echoed.has(p.clientMsgId));
					const map = new Map(this.current.pending);
					if (left.length === 0) map.delete(b.value.threadId);
					else map.set(b.value.threadId, left);
					this.set({ journals, pending: map });
				} else this.set({ journals });
				break;
			}
			case "threadReset": {
				// ThreadInfo is not journal data: it stays until the next one replaces it.
				const journals = new Map(this.current.journals);
				journals.set(b.value.threadId, resetJournal());
				this.set({ journals });
				// The snapshot that follows answers the request.
				return;
			}
			case "threadStatus":
			case "threadCreated":
				if (b.value.thread !== undefined) this.putThread(b.value.thread);
				break;
			case "threadListResult":
				this.set({ threads: b.value.threads, listed: true, openSessions: b.value.openSessions, maxSessions: b.value.maxSessions });
				break;
			case "machineInfo":
				this.set({ info: b.value, openSessions: b.value.openSessions, maxSessions: b.value.maxSessions });
				break;
			case "threadInfo": {
				const threadInfo = new Map(this.current.threadInfo);
				threadInfo.set(b.value.threadId, mergeThreadInfo(this.current.threadInfo.get(b.value.threadId), b.value));
				this.set({ threadInfo });
				break;
			}
			case "machineProfile":
				this.set({ machineProfile: b.value });
				break;
			case "fullItem":
				if (b.value.item !== undefined) {
					const full = new Map(this.current.full);
					full.set(b.value.item.id, b.value.item);
					this.set({ full });
				}
				break;
			default:
				break;
		}
		if (frame.id === "") return;
		const waiter = this.waiters.get(frame.id);
		if (waiter === undefined) return;
		this.waiters.delete(frame.id);
		this.timers.clearTimeout(waiter.timer);
		if (b.case === "error") {
			// The machine just found out it lacks Full Disk Access: its info says so now.
			if (b.value.reason === ErrorReason.FULL_DISK_ACCESS_NEEDED && this.current.info?.needsFullDiskAccess !== true) {
				this.request({ case: "machineInfoRequest", value: {} }).catch(() => undefined);
			}
			waiter.reject(new RemoteError(b.value.code, b.value.message, b.value.reason, b.value.subject));
		}
		else waiter.resolve(frame);
	}

	private putThread(thread: ThreadSummary): void {
		const others = this.current.threads.filter((t) => t.id !== thread.id);
		const threads = [thread, ...others].sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt > b.updatedAt ? -1 : 1));
		const open = threads.filter((t) => t.open).length;
		this.set({ threads, openSessions: Math.max(open, 0) });
	}
}

/**
 * A newer ThreadInfo replaces the older one, except for what it does not
 * know: unset rate limits (the AI reports them only now and then) keep the
 * previous ones while the session stays on the same Claude profile, and an
 * empty command list (not listed yet) keeps the previous one.
 */
export function mergeThreadInfo(previous: ThreadInfo | undefined, next: ThreadInfo): ThreadInfo {
	if (previous === undefined) return next;
	const rateLimits = next.rateLimits ?? (previous.profileId === next.profileId ? previous.rateLimits : undefined);
	const commands = next.commands.length > 0 ? next.commands : previous.commands;
	if (rateLimits === next.rateLimits && commands === next.commands) return next;
	return { ...next, rateLimits, commands };
}

/** Threads that need the user first, then running ones, then the rest by last change. */
export function sortForList(threads: readonly ThreadSummary[]): ThreadSummary[] {
	const rank = (t: ThreadSummary) => (t.state === ThreadState.WAITING ? 0 : t.state === ThreadState.RUNNING || t.state === ThreadState.QUEUED ? 1 : 2);
	return [...threads].sort((a, b) => rank(a) - rank(b) || (a.updatedAt === b.updatedAt ? 0 : a.updatedAt > b.updatedAt ? -1 : 1));
}

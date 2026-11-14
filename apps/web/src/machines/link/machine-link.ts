// One end-to-end encrypted link to one machine (ADR 0013), shared by every
// thread of that machine: one WebSocket, the handshake with the machine key
// the account lists (and the one seen last time, if any: a change is refused
// until the user refreshes the machine), sealed frames handled strictly one at a time (the frame
// counters must stay in order), requests matched by id, a ping every 10 s
// while the user looks at the machine, and reconnection with backoff. Every
// few failures it asks the directory again for the tunnel address (it changes
// when the agent reconnects). After reconnecting it resubscribes each watched
// thread from its cursor; a ThreadReset drops the thread's items and the
// snapshot that follows fills them again. A thread's ThreadInfo (what the
// user's terminal statusline shows) is kept apart from its journal.
// Frames the machine sends unasked that the state does not keep (pictures
// and tab lists of the machine's browser, the bytes of its screen sharing)
// go to their own listeners, never into the state: they come many times a
// second and only an open view wants them.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { backoffDelay } from "@achoo254/chat-core";
import {
	ErrorCode,
	ErrorReason,
	FrameSchema,
	HandshakeErrorCode,
	type BrowserTakeover,
	type Frame,
	type Item,
	type MachineInfo,
	type MachineAccounts,
	type PasskeyNotice,
	type AgentUpdateProgress,
	type ProjectCloneProgress,
	type ProjectListResult,
	type SecretPrompt,
	type ThreadActivity,
	type ThreadInfo,
	type ThreadSummary,
} from "@achoo254/chat-proto/remote/remote";
import { HandshakeFailure, equal, startHandshake, type KeyPair, type Session } from "@achoo254/chat-remote-protocol";
import { applyItems, EMPTY_JOURNAL, resetJournal, type Journal } from "../transcript/reducer.ts";
import type { PendingSend, ShownAttachment } from "../transcript/tool-fold.ts";
import { DeviceRegistrationRefused } from "./device-registration.ts";
import { allowedTunnel, frameBytes, type SocketFactory, type SocketLike } from "./socket.ts";

export const PING_MS = 10_000;
/** No frame for this long while pinging: the link is dead. */
const SILENCE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Back in the foreground: an open link that does not answer a ping this fast died meanwhile. */
export const WAKE_PROBE_MS = 3_000;
const BACKOFF = { baseMs: 1_000, maxMs: 30_000 };
/** After this many failed attempts in a row, ask the directory for a new address. */
const REFRESH_AFTER = 3;
/**
 * A machine that does not know this device yet may still be fetching the
 * account's device list: ask again after these waits (about 15 s in all)
 * before saying it refused.
 */
export const UNKNOWN_DEVICE_WAITS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
/** How long a link waits before asking a machine that could not reach the chat again. */
export const UNSYNCED_RETRY_MS = 60_000;

export type LinkFailure =
	/** The machine still does not know this device after waiting for it to sync. */
	| "refused"
	/** The account revoked this device. */
	| "revoked"
	/** The machine's key is not the one the account lists, or not the one seen last time. */
	| "key-changed"
	| "version"
	/** A device of this session was revoked: sign in again. */
	| "session-revoked"
	/** The account holds as many devices as it may. */
	| "too-many-devices"
	/**
	 * The machine has not reached the chat for too long (or never since it
	 * started), so it takes no new device: the link tries again now and then.
	 */
	| "machine-unsynced";

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
	 * Every AI's accounts on the machine, the pick of each and the account
	 * each session runs with, as the machine last announced them (whole,
	 * unasked); null until it does.
	 */
	readonly machineAccounts: MachineAccounts | null;
	/** The machine's projects as it last sent them (tunelo 2.0.7+); null until it does. */
	readonly projects: ProjectListResult | null;
	/** Clones this device started, by clone id, as their progress last said. */
	readonly clones: ReadonlyMap<string, ProjectCloneProgress>;
	/** The newest step of an update of tunelo the machine reported (tunelo 2.3.0+); null before any. */
	readonly agentUpdate: AgentUpdateProgress | null;
	/**
	 * Sign-in secrets the AI waits for (tunelo 2.0.8+), by request id. They are
	 * no thread items: never in a journal, and dropped when answered anywhere.
	 */
	readonly secretPrompts: ReadonlyMap<string, SecretPrompt>;
	/**
	 * Takeovers of the machine's browser open now (tunelo 2.0.12+), by id: the
	 * AI waits for the user on a page, or a device opened the browser itself.
	 */
	readonly takeovers: ReadonlyMap<string, BrowserTakeover>;
	/** Pages of the machine's browser that asked for a passkey nobody at the machine can give, newest last. */
	readonly passkeyNotices: readonly PasskeyNotice[];
}

/** Passkey notices kept for showing. */
const MAX_PASSKEY_NOTICES = 5;

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
	/** This device's key, registered with the account. */
	readonly device: () => Promise<KeyPair>;
	/** The machine's key as the directory lists it now; null while unknown. */
	readonly expectedKey: () => Uint8Array | null;
	/** The key the machine answered with when a link last opened; null before (or not kept). */
	readonly seenKey?: () => Promise<Uint8Array | null>;
	/** Keeps the key of a link that opened. */
	readonly rememberKey?: (key: Uint8Array) => Promise<void>;
	/** The tunnel address as the directory knows it now ("" when down). */
	readonly tunnelUrl: () => string;
	/** Asks the directory again; resolves with the new address. */
	readonly refreshTunnel: () => Promise<string>;
	readonly socket: SocketFactory;
	readonly timers?: Timers;
	readonly random?: () => number;
	readonly newId?: () => string;
	/**
	 * "terminal": a second connection to the machine that carries only the
	 * terminal's signaling and relay frames (its own frame counter and queue,
	 * so a slow chat request never holds a keystroke back). It asks for no
	 * machine info or threads and pings every 10 s whether or not the user
	 * looks at the machines screen (the machine closes silent connections).
	 */
	readonly purpose?: "chat" | "terminal";
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
	machineAccounts: null,
	projects: null,
	clones: new Map(),
	agentUpdate: null,
	secretPrompts: new Map(),
	takeovers: new Map(),
	passkeyNotices: [],
};

export class MachineLink {
	private current: LinkState = INITIAL;
	private readonly listeners = new Set<() => void>();
	private readonly listenersOfViews = new Set<(body: Frame["body"]) => void>();
	private readonly timers: Timers;
	private readonly random: () => number;
	private readonly newId: () => string;
	private socket: SocketLike | null = null;
	private session: Session | null = null;
	/** Messages of the current socket, handled one at a time. */
	private queue: Promise<void> = Promise.resolve();
	private readonly waiters = new Map<string, Waiter>();
	private readonly watched = new Map<string, number>();
	/**
	 * The latest activity of each running turn (ThreadActivity), kept out of
	 * LinkState: it changes every second, and only the activity line reads it,
	 * so the lists never render again for it.
	 */
	private activities = new Map<string, ThreadActivity>();
	private readonly activityListeners = new Set<() => void>();
	private attempt = 0;
	/** UNKNOWN_DEVICE answers in a row (the machine may still be syncing the account's devices). */
	private unknownDevice = 0;
	/** The machine key the current socket expects. */
	private expected: Uint8Array | null = null;
	private retryTimer: unknown = null;
	private pingTimer: unknown = null;
	/** The ping asked on wake() waits for its answer. */
	private probeTimer: unknown = null;
	private lastHeard = 0;
	/** Frames heard so far: the probe tells whether any came after its ping. */
	private heard = 0;
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

	/** Every frame the state does not keep (browser pictures, screen sharing bytes), for an open view; returns the unsubscribe. */
	onFrame(listener: (body: Frame["body"]) => void): () => void {
		this.listenersOfViews.add(listener);
		return () => this.listenersOfViews.delete(listener);
	}

	private set(change: Partial<LinkState>): void {
		this.current = { ...this.current, ...change };
		for (const listener of this.listeners) listener();
	}

	/** For useSyncExternalStore: called whenever any thread's activity changes. */
	readonly onActivity = (listener: () => void): (() => void) => {
		this.activityListeners.add(listener);
		return () => this.activityListeners.delete(listener);
	};

	/** The latest activity the machine sent for the thread; undefined before any (or from a tunelo before 2.5.0). */
	activity(threadId: string): ThreadActivity | undefined {
		return this.activities.get(threadId);
	}

	private setActivity(threadId: string, activity: ThreadActivity | undefined): void {
		if (activity === undefined && !this.activities.has(threadId)) return;
		const next = new Map(this.activities);
		if (activity === undefined) next.delete(threadId);
		else next.set(threadId, activity);
		this.activities = next;
		for (const listener of this.activityListeners) listener();
	}

	journal(threadId: string): Journal {
		return this.current.journals.get(threadId) ?? EMPTY_JOURNAL;
	}

	// --- lifecycle -----------------------------------------------------------

	/** start() ran and stop() did not since. */
	get started(): boolean {
		return !this.stopped;
	}

	/** Connects and keeps reconnecting until stop(). */
	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.attempt = 0;
		this.unknownDevice = 0;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.timers.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.dropSocket();
		this.set({ status: { kind: "idle" } });
	}

	/**
	 * Reconnect now instead of waiting for the backoff (app back in the
	 * foreground, network back). A link that still says it is open may have
	 * died while the app was in the background (iOS drops sockets without
	 * telling the page): it is asked with a ping, and connects again at once
	 * if nothing answers within WAKE_PROBE_MS, instead of waiting out the
	 * silence the ticks watch for.
	 */
	wake(): void {
		if (this.stopped) return;
		const kind = this.current.status.kind;
		if (kind === "offline" || kind === "idle") {
			this.timers.clearTimeout(this.retryTimer);
			this.retryTimer = null;
			void this.connect();
		} else if (kind === "open") this.probe();
	}

	private probe(): void {
		const socket = this.socket;
		if (socket === null || this.probeTimer !== null) return;
		const before = this.heard;
		this.ping();
		this.probeTimer = this.timers.setTimeout(() => {
			this.probeTimer = null;
			if (this.socket !== socket || this.stopped || this.heard > before) return;
			void this.connect();
		}, WAKE_PROBE_MS);
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

	/** Pings and watches for silence: while the user looks, and always on a terminal connection. */
	private get pinging(): boolean {
		return this.active || this.deps.purpose === "terminal";
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

	/**
	 * Closes a thread's AI session on the machine and keeps its history: the
	 * next message opens it again. The machine stops following the thread for
	 * this device on close, so a thread still shown here is followed again.
	 */
	async closeThread(threadId: string): Promise<void> {
		try {
			await this.request({ case: "threadClose", value: { threadId } });
		} finally {
			// Also when the answer is late or refused: following twice does no harm, not following leaves the view stale.
			if (this.watched.has(threadId)) this.subscribeThread(threadId);
		}
	}

	/** Sends a request; resolves with the machine's answer, rejects with RemoteError or OfflineError (also after `timeoutMs` without one). */
	request(body: FrameBody, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Frame> {
		const session = this.session;
		const socket = this.socket;
		if (session === null || socket === null || this.current.status.kind !== "open") return Promise.reject(new OfflineError());
		const id = `${++this.serial}`;
		return new Promise<Frame>((resolve, reject) => {
			const timer = this.timers.setTimeout(() => {
				this.waiters.delete(id);
				reject(new OfflineError());
			}, timeoutMs);
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
	 * Sends a frame nobody answers (a terminal frame on the relay path) at
	 * once, in call order with requests; false when the link is not open or
	 * the socket refused it.
	 */
	post(body: FrameBody): boolean {
		const session = this.session;
		const socket = this.socket;
		if (session === null || socket === null || this.current.status.kind !== "open") return false;
		try {
			socket.send(new Uint8Array(session.seal(create(FrameSchema, { id: "", body }))));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Sends a message, with files uploaded for it before (their upload ids);
	 * it shows at once and stays until the machine echoes it.
	 */
	async send(threadId: string, text: string, attachments: readonly ShownAttachment[] = []): Promise<ThreadSummary | undefined> {
		const clientMsgId = this.newId();
		const list = this.current.pending.get(threadId) ?? [];
		this.setPending(threadId, [...list, { clientMsgId, text, ...(attachments.length > 0 ? { attachments } : {}) }]);
		const settle = () =>
			this.setPending(
				threadId,
				(this.current.pending.get(threadId) ?? []).filter((p) => p.clientMsgId !== clientMsgId),
			);
		try {
			const frame = await this.request({ case: "threadSend", value: { threadId, text, clientMsgId, attachmentIds: attachments.map((a) => a.id) } });
			// `/clear` is answered with the thread that replaces this one: nothing was typed here.
			if (frame.body.case !== "threadCreated") return undefined;
			settle();
			return frame.body.value.thread;
		} catch (err) {
			settle();
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
		let seen: Uint8Array | null;
		let device: KeyPair;
		try {
			[seen, device] = await Promise.all([this.deps.seenKey?.() ?? Promise.resolve(null), this.deps.device()]);
		} catch (err) {
			if (err instanceof DeviceRegistrationRefused) return this.fail(err.reason);
			return this.retry();
		}
		if (this.stopped) return;
		let url = this.deps.tunnelUrl();
		// The first attempt without an address or key (a page opened straight
		// from a link, before the directory loaded) asks the directory at once.
		const unknown = url === "" || this.deps.expectedKey() === null;
		if ((this.attempt === 1 && unknown) || (this.attempt > 1 && (this.attempt - 1) % REFRESH_AFTER === 0)) {
			url = await this.deps.refreshTunnel().catch(() => url);
			if (this.stopped) return;
		}
		// No address (the machine is off or its agent is reconnecting the
		// tunnel) or no key yet: try again later, asking the directory every few attempts.
		const expected = this.deps.expectedKey();
		if (url === "" || !allowedTunnel(url) || expected === null || expected.length !== 32) return this.retry();
		if (seen !== null && !equal(seen, expected)) {
			console.warn("machines: the account lists another key for this machine than the one it answered with before");
			return this.fail("key-changed");
		}
		this.expected = expected;
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
			void startHandshake({ device, expectedMachineKey: expected }).then(
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
					this.heard += 1;
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
		this.unknownDevice = 0;
		const key = this.expected;
		if (key !== null) this.deps.rememberKey?.(key).catch(() => undefined);
		// The machine sends every prompt and takeover still open again on this connection.
		this.set({ status: { kind: "open" }, secretPrompts: new Map(), takeovers: new Map() });
		this.timers.clearInterval(this.pingTimer);
		this.pingTimer = this.timers.setInterval(() => this.tick(), PING_MS);
		if (this.deps.purpose === "terminal") return;
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
		if (this.current.status.kind !== "open" || !this.pinging) return;
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
					return this.notKnownYet();
				case HandshakeErrorCode.REVOKED:
					return this.fail("revoked");
				case HandshakeErrorCode.VERSION_UNSUPPORTED:
					return this.fail("version");
				case HandshakeErrorCode.BUSY:
					return this.unsynced();
				case HandshakeErrorCode.MACHINE_KEY_CHANGED:
				case HandshakeErrorCode.BAD_PROOF:
					console.warn("machines: the machine answered with another key than the account lists");
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

	/**
	 * The machine does not know this device: it may not have fetched the
	 * account's devices since this one registered. Ask again a few times,
	 * waiting longer each time, then give up.
	 */
	private notKnownYet(): void {
		const wait = UNKNOWN_DEVICE_WAITS_MS[this.unknownDevice];
		if (wait === undefined) return this.fail("refused");
		this.unknownDevice += 1;
		this.dropSocket();
		if (this.stopped) return;
		// Waiting for the machine's sync is no failed attempt: the page keeps saying "connecting".
		this.attempt = Math.max(0, this.attempt - 1);
		this.set({ status: { kind: "connecting", attempt: Math.max(1, this.attempt) } });
		this.timers.clearTimeout(this.retryTimer);
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, wait);
	}

	/** The machine cannot check this device now: say so, and ask again only after a long wait. */
	private unsynced(): void {
		this.fail("machine-unsynced");
		if (this.stopped) return;
		this.timers.clearTimeout(this.retryTimer);
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, UNSYNCED_RETRY_MS);
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
		this.timers.clearTimeout(this.probeTimer);
		this.probeTimer = null;
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
				this.set({ threads: keepOrder(this.current.threads, b.value.threads), listed: true, openSessions: b.value.openSessions, maxSessions: b.value.maxSessions });
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
			case "machineAccounts":
				this.set({ machineAccounts: b.value });
				break;
			case "projectListResult":
				this.set({ projects: b.value });
				break;
			case "projectCloneProgress": {
				const clones = new Map(this.current.clones);
				clones.set(b.value.cloneId, b.value);
				this.set({ clones });
				break;
			}
			case "agentUpdateProgress":
				this.set({ agentUpdate: b.value });
				break;
			case "threadDeleted":
				this.dropThread(b.value.threadId);
				break;
			case "secretPrompt": {
				const secretPrompts = new Map(this.current.secretPrompts);
				secretPrompts.set(b.value.requestId, b.value);
				this.set({ secretPrompts });
				break;
			}
			case "secretPromptEnded":
				this.dropSecretPrompt(b.value.requestId);
				break;
			case "browserTakeover": {
				const takeovers = new Map(this.current.takeovers);
				takeovers.set(b.value.takeoverId, b.value);
				this.set({ takeovers });
				break;
			}
			case "browserTakeoverEnded":
				this.dropTakeover(b.value.takeoverId);
				break;
			case "passkeyNotice":
				this.set({ passkeyNotices: [...this.current.passkeyNotices, b.value].slice(-MAX_PASSKEY_NOTICES) });
				break;
			case "threadActivity":
				this.setActivity(b.value.threadId, b.value);
				break;
			case "fullItem":
				if (b.value.item !== undefined) {
					const full = new Map(this.current.full);
					full.set(b.value.item.id, b.value.item);
					this.set({ full });
				}
				break;
			default:
				for (const listener of this.listenersOfViews) listener(b);
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

	/** A prompt this device answered or the machine closed. */
	dropSecretPrompt(requestId: string): void {
		if (!this.current.secretPrompts.has(requestId)) return;
		const secretPrompts = new Map(this.current.secretPrompts);
		secretPrompts.delete(requestId);
		this.set({ secretPrompts });
	}

	/** A takeover this device gave back, or the machine ended. */
	dropTakeover(takeoverId: string): void {
		if (!this.current.takeovers.has(takeoverId)) return;
		const takeovers = new Map(this.current.takeovers);
		takeovers.delete(takeoverId);
		this.set({ takeovers });
	}

	/** The user read a passkey notice. */
	dismissPasskey(notice: PasskeyNotice): void {
		this.set({ passkeyNotices: this.current.passkeyNotices.filter((n) => n !== notice) });
	}

	/** A thread deleted on the machine leaves every list and cache here. */
	private dropThread(threadId: string): void {
		const without = <V>(map: ReadonlyMap<string, V>) => {
			const next = new Map(map);
			next.delete(threadId);
			return next;
		};
		const threads = this.current.threads.filter((t) => t.id !== threadId);
		this.setActivity(threadId, undefined);
		this.set({
			threads,
			openSessions: threads.filter((t) => t.open).length,
			journals: without(this.current.journals),
			pending: without(this.current.pending),
			threadInfo: without(this.current.threadInfo),
		});
	}

	private putThread(thread: ThreadSummary): void {
		// A known session keeps its place however its state or time changed; a new one comes first.
		const known = this.current.threads.some((t) => t.id === thread.id);
		const threads = known ? this.current.threads.map((t) => (t.id === thread.id ? thread : t)) : [thread, ...this.current.threads];
		const open = threads.filter((t) => t.open).length;
		this.set({ threads, openSessions: Math.max(open, 0) });
	}
}

/**
 * A newer ThreadInfo replaces the older one, except for what it does not
 * know: unset rate limits (the AI reports them only now and then) keep the
 * previous ones while the session stays on the same account, and an
 * empty command list (not listed yet) keeps the previous one.
 */
export function mergeThreadInfo(previous: ThreadInfo | undefined, next: ThreadInfo): ThreadInfo {
	if (previous === undefined) return next;
	const rateLimits = next.rateLimits ?? (previous.accountId === next.accountId ? previous.rateLimits : undefined);
	const commands = next.commands.length > 0 ? next.commands : previous.commands;
	if (rateLimits === next.rateLimits && commands === next.commands) return next;
	return { ...next, rateLimits, commands };
}

/**
 * The machine's fresh list in the order the device already shows: a session
 * keeps its place while it runs, waits or finishes; the new ones come first
 * (in the machine's order); the gone ones drop out.
 */
export function keepOrder(shown: readonly ThreadSummary[], fresh: readonly ThreadSummary[]): ThreadSummary[] {
	const byId = new Map(fresh.map((t) => [t.id, t]));
	const kept = shown.flatMap((t) => byId.get(t.id) ?? []);
	const keptIds = new Set(kept.map((t) => t.id));
	return [...fresh.filter((t) => !keptIds.has(t.id)), ...kept];
}

/** The list as the device holds it: no state or time moves a session; the user places it (drag and drop). */
export function sortForList(threads: readonly ThreadSummary[]): ThreadSummary[] {
	return [...threads];
}

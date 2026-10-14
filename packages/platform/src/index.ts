// Platform seam of the client (ADR 0007). @app/core never touches a platform
// API directly: each platform package (web now; Capacitor and Tauri later)
// implements these interfaces and hands them to startApp. Interfaces only the
// native apps need (Push, Badge, Files, SecureStore, AuthBrowser) are added
// with those apps.

/** Values that cross the SQL boundary. Integers stay below 2^53 (ADR 0001). */
export type SqlValue = string | number | null | Uint8Array;

export type SqlParams = readonly SqlValue[];

export interface SqlStatement {
	readonly sql: string;
	readonly params?: SqlParams;
}

export type SqlRow = Readonly<Record<string, SqlValue>>;

/**
 * One local SQLite database. Every write goes through `batch`, which is a
 * single atomic transaction and, on native, a single bridge call (ADR 0007).
 */
export interface SqlDriver {
	/** Runs one read-only statement and returns its rows. */
	query(sql: string, params?: SqlParams): Promise<SqlRow[]>;
	/** Runs the statements in one transaction: all of them apply or none. */
	batch(statements: readonly SqlStatement[]): Promise<void>;
	close(): Promise<void>;
	/** Closes the database and deletes its files (sign-out, revoked session, reset). */
	destroy(): Promise<void>;
}

/**
 * Opens local databases. `name` already encodes the (tenant, user) pair, so
 * two accounts never share a file (ADR 0009).
 */
export interface SqlDriverFactory {
	open(name: string): Promise<SqlDriver>;
}

export type Unsubscribe = () => void;

/** App and network lifecycle as seen by the core. */
export interface Lifecycle {
	/** True while the app is visible to the user (tab or window in the foreground). */
	isForeground(): boolean;
	onForegroundChange(listener: (foreground: boolean) => void): Unsubscribe;
	/** The OS reports network connectivity back; reconnect without waiting for backoff. */
	onOnline(listener: () => void): Unsubscribe;
}

export interface NotificationRequest {
	readonly title: string;
	readonly body: string;
	/** Replaces an earlier notification with the same tag (one per chat). */
	readonly tag: string;
	readonly chatId: number;
}

/** User-visible notifications while the app runs. */
export interface Notify {
	show(request: NotificationRequest): void;
	/** Removes the notification with this tag, e.g. after the chat was read. */
	clear(tag: string): void;
}

/** Opens a URL outside the app; callers validate the scheme first (ADR 0004). */
export interface OpenExternal {
	open(url: string): void;
}

/** A WebSocket as the core uses it; binary frames only. */
export interface Socket {
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
}

export interface SocketHandlers {
	onOpen(): void;
	onMessage(data: Uint8Array): void;
	/** Fires once per socket, after an error too. */
	onClose(code: number, reason: string): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => Socket;

export interface Timers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

/** Runs `callback` before the next frame is drawn (or soon, off the main thread). */
export type FrameScheduler = (callback: () => void) => void;

/** Everything the core needs from the platform it runs on. */
export interface Platform {
	readonly sql: SqlDriverFactory;
	readonly lifecycle: Lifecycle;
	readonly notify: Notify;
	readonly socket: SocketFactory;
	readonly timers: Timers;
	readonly frame: FrameScheduler;
	/** Cryptographically strong random integer in [0, 2^53) for random_id. */
	readonly randomId: () => number;
}

/** Timers backed by the global clock. */
export const systemTimers: Timers = {
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => {
		globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
	},
	now: () => Date.now(),
};

/** random_id from crypto.getRandomValues: 53 random bits, never 0. */
export function cryptoRandomId(): number {
	const words = new Uint32Array(2);
	for (;;) {
		globalThis.crypto.getRandomValues(words);
		const high = (words[0] ?? 0) & 0x1fffff; // 21 bits
		const low = words[1] ?? 0; // 32 bits
		const id = high * 2 ** 32 + low;
		if (id !== 0) return id;
	}
}

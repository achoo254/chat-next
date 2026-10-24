// Platform seam of the client (ADR 0007). @achoo254/chat-core never touches a platform
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
	/**
	 * No window of the app was visible when the message arrived (what the
	 * server sees as not foreground): a device with background push lets the
	 * push show it instead.
	 */
	readonly background?: boolean;
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

/** Result of an HTTP PUT of an upload part. */
export interface HttpPutResult {
	readonly status: number;
	/** The ETag response header ("" when absent or not exposed by CORS). */
	readonly etag: string;
}

/** Result of an HTTP GET; body is set for 2xx answers only. */
export interface HttpGetResult {
	readonly status: number;
	readonly body: Blob | null;
}

/**
 * Plain HTTP for media: upload parts go straight to presigned storage URLs
 * and downloads come from the media host. No cookies are sent; the URLs
 * carry their own credentials. Network failures reject; HTTP errors resolve
 * with their status.
 */
export interface Http {
	put(url: string, body: Blob, signal?: AbortSignal): Promise<HttpPutResult>;
	get(url: string, signal?: AbortSignal): Promise<HttpGetResult>;
}

/** Durable key -> Blob storage (pending uploads, media cache). */
export interface BlobStore {
	get(key: string): Promise<Blob | null>;
	put(key: string, blob: Blob): Promise<void>;
	delete(key: string): Promise<void>;
	/** Deletes every blob of this store (sign-out, revoked session). */
	destroy(): Promise<void>;
}

/** Opens blob stores; `name` encodes the (tenant, user) pair like the database name (ADR 0009). */
export interface BlobStoreFactory {
	open(name: string): Promise<BlobStore>;
}

/** Layout data of an image measured on the device before upload. */
export interface ImageInfo {
	readonly width: number;
	readonly height: number;
	/** Tiny JPEG (longest side <= 40 px, a few hundred bytes) shown before download; null when it could not be made. */
	readonly thumb: Uint8Array | null;
}

/** Measures images on the device (decoding happens off the UI thread where possible). */
export interface ImageProbe {
	/** null when the blob is not an image this platform can decode. */
	probe(blob: Blob): Promise<ImageInfo | null>;
}

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
	/** Media upload and download; without it (or blobs) sending and fetching media is unavailable. */
	readonly http?: Http;
	/** Pending upload files and the media cache. */
	readonly blobs?: BlobStoreFactory;
	/** Image dimensions and inline thumbnails for photos the caller did not measure. */
	readonly imageProbe?: ImageProbe;
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

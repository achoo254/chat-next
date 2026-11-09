/**
 * One WebSocket to a browser's (or a page's) DevTools endpoint, carrying
 * Chrome DevTools Protocol commands and events. Commands may name a
 * `sessionId` (a target attached with `flatten: true`), so one connection to
 * the browser drives every tab. Every command answers or fails within a
 * timeout; when the socket closes, every command still waiting fails.
 */
import WebSocket from "ws";

const OPEN_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 10_000;

export interface CdpEvent {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

interface Waiting {
	resolve(v: unknown): void;
	reject(e: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export class CdpConnection {
	private readonly waiting = new Map<number, Waiting>();
	private readonly listeners = new Set<(event: CdpEvent) => void>();
	private readonly closeListeners = new Set<() => void>();
	private next = 0;
	private closed = false;

	private constructor(private readonly ws: WebSocket) {
		ws.on("message", (data) => this.message(String(data)));
		ws.on("close", () => this.gone(new Error("the browser closed the connection")));
		ws.on("error", (err) => this.gone(err));
	}

	/** Opens the connection; rejects when the endpoint does not answer in time. */
	static open(wsUrl: string): Promise<CdpConnection> {
		return new Promise((resolve, reject) => {
			// CDP messages carry screenshots: no size limit of ws's own beyond 64 MB.
			const ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: OPEN_TIMEOUT_MS, maxPayload: 64 * 1024 * 1024 });
			const failed = (err: Error) => reject(err);
			ws.once("error", failed);
			ws.once("open", () => {
				ws.off("error", failed);
				resolve(new CdpConnection(ws));
			});
		});
	}

	get isOpen(): boolean {
		return !this.closed;
	}

	/** Every event of the connection (all sessions); returns the unsubscribe. */
	onEvent(listener: (event: CdpEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	send<T = unknown>(method: string, params: object = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
		if (this.closed) return Promise.reject(new Error("the browser closed the connection"));
		const id = ++this.next;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`the browser did not answer ${method} in time`));
			}, timeoutMs);
			timer.unref?.();
			this.waiting.set(id, { resolve: (v) => resolve(v as T), reject, timer });
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (err) => {
				if (!err) return;
				const w = this.waiting.get(id);
				if (!w) return;
				this.waiting.delete(id);
				clearTimeout(w.timer);
				reject(err);
			});
		});
	}

	close(): void {
		if (this.closed) return;
		this.ws.close();
		this.gone(new Error("closed"));
	}

	private message(text: string): void {
		let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
		try {
			msg = JSON.parse(text) as typeof msg;
		} catch {
			return;
		}
		if (typeof msg.id === "number") {
			const w = this.waiting.get(msg.id);
			if (!w) return;
			this.waiting.delete(msg.id);
			clearTimeout(w.timer);
			if (msg.error) w.reject(new Error(msg.error.message ?? "the browser refused"));
			else w.resolve(msg.result ?? {});
			return;
		}
		if (typeof msg.method !== "string") return;
		const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) };
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// one listener's failure does not stop the others
			}
		}
	}

	private gone(err: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const w of this.waiting.values()) {
			clearTimeout(w.timer);
			w.reject(err);
		}
		this.waiting.clear();
		for (const listener of this.closeListeners) listener();
	}
}

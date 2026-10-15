// Connection state the screens show (mockups/chat.html#connection-states):
// the realtime socket's state from the core, corrected by what the device
// reports about the network.
//
// - The device is offline (navigator.onLine, online/offline events):
//   "offline" at once. A socket can outlive a lost network until its
//   heartbeat times out, so the core alone would still say "connected".
// - The socket is down while the device is online: "connecting" ("Đang kết
//   nối…") while the core reconnects, then "waiting" ("Chờ mạng") once it
//   has been down for OFFLINE_AFTER_MS. Without the grace period the header
//   would flip between the two on every retry of the backoff.
import type { ConnectionState } from "@app/core";

/** How long the socket may stay down, with the device online, before the screens treat it as no network. */
export const OFFLINE_AFTER_MS = 10_000;

/** What the device reports about its network. */
export interface NetworkStatus {
	online(): boolean;
	/** Calls listener when the device goes online or offline. */
	subscribe(listener: () => void): () => void;
}

/** The browser's view: navigator.onLine and the window's online/offline events. */
export const browserNetwork: NetworkStatus = {
	online: () => typeof navigator === "undefined" || navigator.onLine !== false,
	subscribe(listener) {
		if (typeof window === "undefined") return () => {};
		window.addEventListener("online", listener);
		window.addEventListener("offline", listener);
		return () => {
			window.removeEventListener("online", listener);
			window.removeEventListener("offline", listener);
		};
	},
};

export class ConnectionStatus {
	private core: ConnectionState = "connecting";
	/** When the socket was last seen going down (or when tracking started). */
	private downSince: number;
	private shown: ConnectionState;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly network: NetworkStatus,
		private readonly onChange: () => void,
		private readonly now: () => number = Date.now,
	) {
		this.downSince = now();
		this.shown = this.compute();
		this.unsubscribe = network.subscribe(() => this.update());
		this.schedule();
	}

	/** The state to show. */
	get(): ConnectionState {
		return this.shown;
	}

	/** The core's socket state changed. */
	setCore(state: ConnectionState): void {
		if (state === this.core) return;
		if (this.core === "connected") this.downSince = this.now();
		this.core = state;
		this.update();
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.unsubscribe();
	}

	private compute(): ConnectionState {
		if (!this.network.online()) return "offline";
		if (this.core === "connected" || this.core === "offline") return this.core;
		return this.now() - this.downSince >= OFFLINE_AFTER_MS ? "waiting" : "connecting";
	}

	private update(): void {
		const next = this.compute();
		const changed = next !== this.shown;
		this.shown = next;
		this.schedule();
		if (changed) this.onChange();
	}

	/** While "connecting", wakes up when the grace period ends. */
	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.shown !== "connecting") return;
		const left = this.downSince + OFFLINE_AFTER_MS - this.now();
		this.timer = setTimeout(() => this.update(), Math.max(0, left));
	}
}

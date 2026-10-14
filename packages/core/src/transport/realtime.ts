// WebSocket transport (realtime.proto): one protobuf frame per binary
// message, heartbeat-based dead detection and reconnect with jittered
// backoff. The sync engine owns what happens after a (re)connect: the
// ADR 0002 order (subscribe, buffer, GetDifference, merge) starts on onHello.
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import type { Socket, SocketFactory, Timers } from "@app/platform";
import { ClientPlatform } from "@app/proto-ts/auth";
import {
	ClientFrameSchema,
	FrameErrorCode,
	ServerFrameSchema,
	type ServerFrame,
} from "@app/proto-ts/realtime";
import type { Hello, SessionRevokeReason, UpdateBatch } from "../model/types.ts";
import { toHello, toRevokeReason, toUpdateBatch, toWireId } from "../protocol/map.ts";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from "./backoff.ts";

type ClientFrameInit = MessageInitShape<typeof ClientFrameSchema>;

export type ConnectionState = "offline" | "connecting" | "connected" | "waiting";

export interface RealtimeHandlers {
	onHello(hello: Hello): void;
	onUpdates(batch: UpdateBatch): void;
	/** The server ended the session (SessionRevokedFrame or an unauthenticated error). */
	onSessionEnded(reason: SessionRevokeReason): void;
	/** A socket closed before the server accepted the session. */
	onHandshakeFailed(): void;
	onStateChange(state: ConnectionState): void;
}

export interface RealtimeOptions {
	readonly url: string;
	readonly socket: SocketFactory;
	readonly timers: Timers;
	readonly platform: ClientPlatform;
	readonly appVersion: string;
	readonly random?: () => number;
	readonly backoff?: BackoffPolicy;
	/** Wait for HelloFrame before giving up on a fresh socket. */
	readonly handshakeTimeoutMs?: number;
	/** Used until the server announces its heartbeat interval. */
	readonly defaultHeartbeatMs?: number;
}

/** Path of the realtime gateway on the tenant's own origin (same site as /rpc). */
export const REALTIME_PATH = "/ws";

/**
 * WebSocket URL of the gateway for an app origin such as
 * https://chat.hoandat.com: wss://chat.hoandat.com/ws (ws:// for http).
 */
export function realtimeUrlFor(origin: string): string {
	const url = new URL(REALTIME_PATH, origin);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return url.toString();
}

/** Extra wait past the heartbeat interval before a silent socket is declared dead. */
export function deadAfterMs(heartbeatMs: number): number {
	return heartbeatMs + Math.max(5_000, Math.round(heartbeatMs / 2));
}

export class RealtimeConnection {
	private socket: Socket | null = null;
	private generation = 0;
	private state: ConnectionState = "offline";
	private running = false;
	private attempt = 0;
	private hello: Hello | null = null;
	private heartbeatMs: number;
	private nextRequestId = 1;
	private reconnectTimer: unknown = null;
	private pingTimer: unknown = null;
	private deadTimer: unknown = null;
	private openChat: { chatId: number; visible: readonly number[] } = { chatId: 0, visible: [] };
	private foreground = true;
	private readonly random: () => number;
	private readonly backoff: BackoffPolicy;

	constructor(
		private readonly options: RealtimeOptions,
		private readonly handlers: RealtimeHandlers,
	) {
		this.random = options.random ?? Math.random;
		this.backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.heartbeatMs = options.defaultHeartbeatMs ?? 25_000;
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	get session(): Hello | null {
		return this.hello;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.attempt = 0;
		this.open();
	}

	stop(): void {
		this.running = false;
		this.teardown();
		this.setState("offline");
	}

	/** Drops the current socket (if any) and connects again without waiting. */
	reconnectNow(): void {
		if (!this.running) return;
		this.attempt = 0;
		this.teardown();
		this.open();
	}

	/** Tells the gateway which chat is open and which large chats are visible. */
	setOpenChat(chatId: number, visibleChatIds: readonly number[]): void {
		this.openChat = { chatId, visible: [...visibleChatIds] };
		if (this.state === "connected") this.sendOpenChat();
	}

	setForeground(foreground: boolean): void {
		this.foreground = foreground;
		if (this.state === "connected") {
			this.send({ case: "presence", value: { foreground } });
		}
	}

	private open(): void {
		const generation = ++this.generation;
		this.setState("connecting");
		this.hello = null;
		const current = (): boolean => generation === this.generation;
		try {
			this.socket = this.options.socket(this.options.url, {
				onOpen: () => {
					if (!current()) return;
					this.send({
						case: "hello",
						value: { sessionToken: "", platform: this.options.platform, appVersion: this.options.appVersion },
					});
				},
				onMessage: (data) => {
					if (current()) this.receive(data);
				},
				onClose: () => {
					if (current()) this.closed();
				},
			});
		} catch {
			// The platform refused to create the socket (e.g. invalid URL while
			// offline); treat it like a failed handshake and retry with backoff.
			this.closed();
			return;
		}
		this.armDeadTimer(this.options.handshakeTimeoutMs ?? 10_000);
	}

	private receive(data: Uint8Array): void {
		let frame: ServerFrame;
		try {
			frame = fromBinary(ServerFrameSchema, data);
		} catch {
			// A frame we cannot decode means the stream is unusable; start over.
			this.dropSocket();
			return;
		}
		if (this.hello !== null) this.armDeadTimer(deadAfterMs(this.heartbeatMs));
		const f = frame.frame;
		switch (f.case) {
			case "hello": {
				let hello: Hello;
				try {
					hello = toHello(f.value);
				} catch {
					this.dropSocket();
					return;
				}
				this.hello = hello;
				this.attempt = 0;
				if (hello.heartbeatIntervalMs > 0) this.heartbeatMs = hello.heartbeatIntervalMs;
				this.armDeadTimer(deadAfterMs(this.heartbeatMs));
				this.schedulePing();
				this.setState("connected");
				this.sendOpenChat();
				if (!this.foreground) this.send({ case: "presence", value: { foreground: false } });
				this.handlers.onHello(hello);
				return;
			}
			case "update": {
				let batch: UpdateBatch;
				try {
					batch = toUpdateBatch(f.value);
				} catch {
					// An id outside the safe range violates ADR 0001; resync instead
					// of applying a partial frame.
					this.dropSocket();
					return;
				}
				this.handlers.onUpdates(batch);
				return;
			}
			case "sessionRevoked":
				this.handlers.onSessionEnded(toRevokeReason(f.value.reason));
				return;
			case "resync":
				// The server stops realtime delivery for this socket; reconnecting
				// runs GetDifference, which recovers everything that was skipped.
				this.dropSocket();
				return;
			case "error":
				if (f.value.code === FrameErrorCode.UNAUTHENTICATED) this.handlers.onSessionEnded("unknown");
				return;
			case "pong":
			case "typing":
			case "presence":
			case undefined:
				// Typing and presence are rendered by the UI layer (phase 6);
				// receiving them already proved the socket alive above.
				return;
		}
	}

	private sendOpenChat(): void {
		this.send({
			case: "openChat",
			value: {
				chatId: toWireId(this.openChat.chatId),
				visibleChatIds: this.openChat.visible.map(toWireId),
			},
		});
	}

	private send(frame: NonNullable<ClientFrameInit["frame"]>, requestId = 0): void {
		if (this.socket === null) return;
		const message = create(ClientFrameSchema, { requestId: BigInt(requestId), frame });
		try {
			this.socket.send(toBinary(ClientFrameSchema, message));
		} catch {
			this.dropSocket();
		}
	}

	private schedulePing(): void {
		this.clearTimer("pingTimer");
		this.pingTimer = this.options.timers.setTimeout(() => {
			this.pingTimer = null;
			if (this.state !== "connected") return;
			this.send({ case: "ping", value: {} }, this.nextRequestId++);
			this.schedulePing();
		}, this.heartbeatMs);
	}

	private armDeadTimer(ms: number): void {
		this.clearTimer("deadTimer");
		this.deadTimer = this.options.timers.setTimeout(() => {
			this.deadTimer = null;
			// Nothing arrived in time: the socket is dead even if the OS has
			// not noticed yet. Do not wait for the TCP timeout.
			this.dropSocket();
		}, ms);
	}

	/** Closes the socket and handles it as closed right away. */
	private dropSocket(): void {
		const socket = this.socket;
		this.generation++;
		this.socket = null;
		try {
			socket?.close(4000, "client reconnect");
		} catch {
			// Closing an already broken socket may throw; it is gone either way.
		}
		this.closed();
	}

	private closed(): void {
		const hadSession = this.hello !== null;
		this.teardown();
		if (!this.running) return;
		if (!hadSession) this.handlers.onHandshakeFailed();
		if (!this.running) return;
		// attempt is 0 after a working session, so the first retry comes within
		// one base delay; repeated failures back off exponentially.
		const delay = backoffDelay(this.attempt, this.backoff, this.random);
		this.attempt++;
		this.setState("waiting");
		this.reconnectTimer = this.options.timers.setTimeout(() => {
			this.reconnectTimer = null;
			if (this.running) this.open();
		}, delay);
	}

	private teardown(): void {
		this.clearTimer("pingTimer");
		this.clearTimer("deadTimer");
		this.clearTimer("reconnectTimer");
		const socket = this.socket;
		this.socket = null;
		this.generation++;
		this.hello = null;
		if (socket !== null) {
			try {
				socket.close(1000, "client closing");
			} catch {
				// Already closed.
			}
		}
	}

	private clearTimer(name: "pingTimer" | "deadTimer" | "reconnectTimer"): void {
		const handle = this[name];
		if (handle !== null) this.options.timers.clearTimeout(handle);
		this[name] = null;
	}

	private setState(state: ConnectionState): void {
		if (this.state === state) return;
		this.state = state;
		this.handlers.onStateChange(state);
	}
}

// The machine's terminal for tests and the visual harness: what the agent
// and the terminal process do with the Term* frames of a FakeMachine's
// connections (docs/terminal-wire.md sections 3 to 8), with fake WebRTC peers
// the test opens and drops. Sessions keep their whole output, so an Attach
// with an offset replays from there and any other gets a snapshot. Typed bytes
// echo back as output (like a shell with echo) unless `echo` is off, and every
// keystroke is recorded with the path it came on, in the order it "reached
// the shell". Test-only: never part of the production build.
import { ErrorCode, ErrorReason, TermPath, TermSignalKind, type Frame } from "@achoo254/chat-proto/remote/remote";
import type { PeerChannel, PeerConnection, PeerFactory } from "../../src/terminal/terminal-link.ts";
import type { Body, FakeMachine, FakeSocket } from "./fake-machine.ts";

// --- frames the terminal process sends, and what a client sends, decoded ----------

const enc = new TextEncoder();

function header(type: number, session: number, size: number): { b: Uint8Array<ArrayBuffer>; v: DataView } {
	const b = new Uint8Array(5 + size);
	const v = new DataView(b.buffer);
	v.setUint8(0, type);
	v.setUint32(1, session);
	return { b, v };
}

function u64(v: DataView, at: number, n: number): void {
	v.setBigUint64(at, BigInt(n));
}

export const serverFrames = {
	hello(version = 1, maxFrame = 65_536): Uint8Array<ArrayBuffer> {
		const { b, v } = header(0x81, 0, 5);
		v.setUint8(5, version);
		v.setUint32(6, maxFrame);
		return b;
	},
	output(session: number, offset: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
		const { b, v } = header(0x90, session, 8 + data.length);
		u64(v, 5, offset);
		b.set(data, 13);
		return b;
	},
	snapshot(session: number, offset: number, cols: number, rows: number, altScreen: boolean, vt: Uint8Array): Uint8Array<ArrayBuffer> {
		const { b, v } = header(0x91, session, 13 + vt.length);
		u64(v, 5, offset);
		v.setUint16(13, cols);
		v.setUint16(15, rows);
		v.setUint8(17, altScreen ? 1 : 0);
		b.set(vt, 18);
		return b;
	},
	exit(session: number, code: number, signal: number): Uint8Array<ArrayBuffer> {
		const { b, v } = header(0x92, session, 5);
		v.setInt32(5, code);
		v.setUint8(9, signal);
		return b;
	},
	pong(micros: number): Uint8Array<ArrayBuffer> {
		const { b, v } = header(0x95, 0, 8);
		u64(v, 5, micros);
		return b;
	},
	error(session: number, code: number, message: string): Uint8Array<ArrayBuffer> {
		const text = enc.encode(message);
		const { b, v } = header(0x9f, session, 2 + text.length);
		v.setUint16(5, code);
		b.set(text, 7);
		return b;
	},
};

export type ClientFrame =
	| { type: "hello"; version: number; caps: number }
	| { type: "input"; session: number; data: Uint8Array }
	| { type: "resize"; session: number; cols: number; rows: number }
	| { type: "attach"; session: number; lastOffset: number }
	| { type: "detach"; session: number }
	| { type: "ack"; session: number; offset: number }
	| { type: "ping"; micros: number };

/** A client frame as the terminal process reads it; null when malformed. */
export function decodeClientFrame(buf: Uint8Array): ClientFrame | null {
	if (buf.length < 5) return null;
	const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const session = v.getUint32(1);
	const size = buf.length - 5;
	switch (v.getUint8(0)) {
		case 0x01:
			return size === 2 && session === 0 ? { type: "hello", version: v.getUint8(5), caps: v.getUint8(6) } : null;
		case 0x10:
			return session !== 0 && size <= 8192 ? { type: "input", session, data: buf.slice(5) } : null;
		case 0x11:
			return size === 4 && session !== 0 ? { type: "resize", session, cols: v.getUint16(5), rows: v.getUint16(7) } : null;
		case 0x12:
			return size === 8 && session !== 0 ? { type: "attach", session, lastOffset: Number(v.getBigUint64(5)) } : null;
		case 0x13:
			return size === 0 && session !== 0 ? { type: "detach", session } : null;
		case 0x14:
			return size === 8 && session !== 0 ? { type: "ack", session, offset: Number(v.getBigUint64(5)) } : null;
		case 0x15:
			return size === 8 && session === 0 ? { type: "ping", micros: Number(v.getBigUint64(5)) } : null;
		default:
			return null;
	}
}

// --- fake WebRTC ------------------------------------------------------------------------

export class FakeChannel implements PeerChannel {
	binaryType: BinaryType = "blob";
	readyState = "connecting";
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((event: { readonly data: unknown }) => void) | null = null;
	/** Where sent frames go (the terminal process), set when the peer connects. */
	deliverTo: ((frame: Uint8Array) => void) | null = null;

	constructor(readonly label: string) {}

	send(data: Uint8Array<ArrayBuffer>): void {
		if (this.readyState !== "open") throw new Error("channel not open");
		const copy = data.slice();
		const target = this.deliverTo;
		queueMicrotask(() => target?.(copy));
	}

	close(): void {
		this.readyState = "closed";
	}

	/** The far end sends one message (in order, after what was queued before). */
	receive(frame: Uint8Array): void {
		const copy = frame.slice();
		queueMicrotask(() => {
			if (this.readyState === "open") this.onmessage?.({ data: copy.buffer });
		});
	}
}

export class FakePeer implements PeerConnection {
	connectionState = "new";
	onicecandidate: ((event: { readonly candidate: { readonly candidate: string } | null }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	readonly channels: FakeChannel[] = [];
	localSdp = "";
	remoteSdp = "";
	readonly remoteCandidates: string[] = [];
	closed = false;

	constructor(readonly id: number) {}

	createDataChannel(label: string): PeerChannel {
		const channel = new FakeChannel(label);
		this.channels.push(channel);
		return channel;
	}

	channel(label: "term-in" | "term-out"): FakeChannel {
		const found = this.channels.find((c) => c.label === label);
		if (found === undefined) throw new Error(`no ${label} channel`);
		return found;
	}

	createOffer(): Promise<{ type: string; sdp: string }> {
		return Promise.resolve({ type: "offer", sdp: `v=0\r\nfake-offer ${this.id}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n` });
	}

	setLocalDescription(description: { type: "offer"; sdp: string }): Promise<void> {
		this.localSdp = description.sdp;
		queueMicrotask(() => this.onicecandidate?.({ candidate: { candidate: `candidate:1 1 udp 2122260223 fake${this.id}.local 5000 typ host` } }));
		return Promise.resolve();
	}

	setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void> {
		this.remoteSdp = description.sdp;
		return Promise.resolve();
	}

	addIceCandidate(candidate: { candidate: string; sdpMLineIndex: number }): Promise<void> {
		this.remoteCandidates.push(candidate.candidate);
		return Promise.resolve();
	}

	close(): void {
		this.closed = true;
		this.connectionState = "closed";
		for (const c of this.channels) c.readyState = "closed";
	}
}

/** Makes fake peers and keeps them for the test (the newest last). */
export class FakePeers {
	readonly made: FakePeer[] = [];
	readonly factory: PeerFactory = () => {
		const peer = new FakePeer(this.made.length + 1);
		this.made.push(peer);
		return peer;
	};

	get last(): FakePeer {
		const peer = this.made.at(-1);
		if (peer === undefined) throw new Error("no peer yet");
		return peer;
	}
}

// --- the machine's terminal ----------------------------------------------------------------

interface Session {
	readonly id: number;
	readonly log: number[];
	cols: number;
	rows: number;
	title: string;
	exited: { code: number; signal: number } | null;
}

interface Conn {
	readonly socket: FakeSocket;
	readonly link: number;
	hello: boolean;
	relay: boolean;
	direct: FakePeer | null;
	readonly attached: Map<number, { sent: number }>;
	closed: boolean;
}

export type KeystrokeRecord = { readonly session: number; readonly text: string; readonly path: "direct" | "relay" };

const dec = new TextDecoder();
/** Largest Output payload the fake sends in one frame. */
const CHUNK = 60_000;
const FINGERPRINT_SDP = "v=0\r\na=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

export class FakeTerminalHost {
	readonly sessions = new Map<number, Session>();
	/** Sessions running a thread's AI (TermOpen.ai_session), by session. */
	readonly aiThreads = new Map<number, string>();
	readonly keystrokes: KeystrokeRecord[] = [];
	readonly acks: { session: number; offset: number; path: "direct" | "relay" }[] = [];
	readonly resizes: { session: number; cols: number; rows: number }[] = [];
	readonly frames: { frame: ClientFrame; path: "direct" | "relay" }[] = [];
	/** Typed bytes come back as output. */
	echo = true;
	/** Printed by every new session (a prompt). */
	greeting = "";
	/** Grants refused: an offer is answered with ACCESS_DENIED, relay data with CLOSED(revoked). */
	refuse = false;
	/** Offers are answered with END(reason) instead of an answer; "" answers. */
	endOffersWith = "";
	/** Offers get no answer at all (the test sends its own). */
	silentOffers = false;
	/** Relay frames from devices wait in `heldRelay` until releaseRelay(). */
	holdRelay = false;
	private heldRelay: (() => void)[] = [];
	private readonly conns = new Map<string, Conn>();
	private nextSession = 1;
	maxSessions = 20;
	/** Threads whose turn runs in chat: opening their AI in a terminal is refused (THREAD_RUNNING), as the agent does. */
	readonly runningTurns = new Set<string>();

	constructor(
		private readonly machine: FakeMachine,
		private readonly peers: FakePeers | null = null,
	) {}

	/** The answer to a Term* frame of a device (plug into FakeMachine.handler); undefined for other frames. */
	handle(frame: Frame, socket: FakeSocket): Body[] | undefined {
		const b = frame.body;
		switch (b.case) {
			case "termListRequest":
				return [
					{
						case: "termListResult",
						value: {
							sessions: [...this.sessions.values()].map((s) => ({
								session: s.id,
								title: s.title,
								cols: s.cols,
								rows: s.rows,
								createdAt: 0n,
								attached: [...this.conns.values()].some((c) => c.attached.has(s.id)),
								exited: s.exited !== null,
								exitCode: s.exited?.code ?? 0,
								exitSignal: s.exited?.signal ?? 0,
								threadId: this.aiThreads.get(s.id) ?? "",
							})),
							maxSessions: this.maxSessions,
						},
					},
				];
			case "termOpen": {
				// A thread's AI already running in a terminal: that session again, as the agent does.
				const threadId = b.value.aiSession?.threadId ?? "";
				const running = [...this.aiThreads].find(([, t]) => t === threadId)?.[0];
				if (threadId !== "" && running !== undefined && this.sessions.get(running)?.exited === null) return [{ case: "termOpened", value: { session: running } }];
				if (this.runningTurns.has(threadId)) return [{ case: "error", value: { code: ErrorCode.INVALID, message: "a turn runs", reason: ErrorReason.THREAD_RUNNING } }];
				if (this.sessions.size >= this.maxSessions) return [{ case: "error", value: { code: ErrorCode.INVALID, message: "limit", reason: ErrorReason.TERMINAL_SESSION_LIMIT } }];
				const session = this.open(b.value.cols, b.value.rows);
				if (threadId !== "") this.aiThreads.set(session, threadId);
				return [{ case: "termOpened", value: { session } }];
			}
			case "termClose":
				if (!this.sessions.delete(b.value.session)) return [{ case: "error", value: { code: ErrorCode.NOT_FOUND, message: "gone", reason: ErrorReason.TERMINAL_SESSION_NOT_FOUND } }];
				return [{ case: "termClosed", value: { session: b.value.session } }];
			case "termResize":
				return [{ case: "ack", value: {} }];
			case "termSignal":
				return this.signal(socket, b.value.link, b.value.kind, b.value.sdp);
			case "termData":
				this.relayFrame(socket, b.value.link, b.value.data);
				return [];
			default:
				return undefined;
		}
	}

	/** A new session with an empty screen; returns its id. */
	open(cols = 80, rows = 24): number {
		const id = this.nextSession++;
		this.sessions.set(id, { id, log: [...enc.encode(this.greeting)], cols, rows, title: "", exited: null });
		return id;
	}

	/** Everything `session` printed so far, as text. */
	text(session: number): string {
		return dec.decode(new Uint8Array(this.sessions.get(session)?.log ?? []));
	}

	/** The program in `session` prints `text`: every attached connection gets it on its path in use. */
	print(session: number, text: string | Uint8Array): void {
		const s = this.sessions.get(session);
		if (s === undefined) return;
		const bytes = typeof text === "string" ? enc.encode(text) : text;
		const from = s.log.length;
		for (const byte of bytes) s.log.push(byte);
		for (const conn of this.conns.values()) {
			const at = conn.attached.get(session);
			if (at === undefined || conn.closed) continue;
			this.sendOutput(conn, s, from);
			at.sent = s.log.length;
		}
	}

	exit(session: number, code: number): void {
		const s = this.sessions.get(session);
		if (s === undefined) return;
		s.exited = { code, signal: 0 };
		for (const conn of this.conns.values()) if (conn.attached.has(session)) this.sendFrame(conn, serverFrames.exit(session, code, 0));
	}

	/** Sends the terminal process's frame to every connection of the device (an Error 6 on revocation, say). */
	broadcast(frame: Uint8Array): void {
		for (const conn of this.conns.values()) if (!conn.closed) this.sendFrame(conn, frame);
	}

	releaseRelay(): void {
		const held = this.heldRelay;
		this.heldRelay = [];
		for (const run of held) run();
	}

	/** The test opens the direct path of the newest offer: channels open, the machine says DIRECT. */
	connectDirect(peer: FakePeer): void {
		const conn = [...this.conns.values()].find((c) => c.direct === peer);
		if (conn === undefined) throw new Error("the peer made no offer");
		peer.connectionState = "connected";
		const tin = peer.channel("term-in");
		const tout = peer.channel("term-out");
		tin.deliverTo = (frame) => this.process(conn, frame, "direct");
		for (const c of [tin, tout]) c.readyState = "open";
		tin.onopen?.();
		tout.onopen?.();
		this.status(conn, TermPath.DIRECT, 0, "");
	}

	/** The machine reports the ICE round trip (the second DIRECT). */
	directRtt(peer: FakePeer, rttMs: number): void {
		const conn = [...this.conns.values()].find((c) => c.direct === peer);
		if (conn !== undefined) this.status(conn, TermPath.DIRECT, rttMs, "");
	}

	/** The direct path dies (ICE lost): the machine ends the peer and falls back to the relay, or closes the link. */
	dropDirect(peer: FakePeer, reason = "ice_disconnected"): void {
		const conn = [...this.conns.values()].find((c) => c.direct === peer);
		peer.connectionState = "failed";
		for (const c of peer.channels) c.readyState = "closed";
		if (conn === undefined) return;
		conn.direct = null;
		this.machine.send(conn.socket, { case: "termSignal", value: { link: conn.link, kind: TermSignalKind.END, reason } });
		if (conn.relay) this.status(conn, TermPath.RELAY, 0, "");
		else this.closeConn(conn, "transport_closed");
	}

	/** The machine closes the device's link (revoked, expired...). */
	closeLink(reason: string): void {
		for (const conn of this.conns.values()) if (!conn.closed) this.closeConn(conn, reason);
	}

	private closeConn(conn: Conn, reason: string): void {
		conn.closed = true;
		this.conns.delete(`${this.machine.sockets.indexOf(conn.socket)}:${conn.link}`);
		this.status(conn, TermPath.CLOSED, 0, reason);
	}

	private conn(socket: FakeSocket, link: number): Conn {
		const key = `${this.machine.sockets.indexOf(socket)}:${link}`;
		let conn = this.conns.get(key);
		if (conn === undefined) {
			conn = { socket, link, hello: false, relay: false, direct: null, attached: new Map(), closed: false };
			this.conns.set(key, conn);
		}
		return conn;
	}

	private signal(socket: FakeSocket, link: number, kind: TermSignalKind, sdp: string): Body[] {
		if (kind === TermSignalKind.OFFER) {
			if (this.refuse) return [{ case: "error", value: { code: ErrorCode.INVALID, message: "not paired", reason: ErrorReason.ACCESS_DENIED } }];
			const conn = this.conn(socket, link);
			const id = /fake-offer (\d+)/.exec(sdp)?.[1];
			const peer = id === undefined ? undefined : this.peers?.made.find((p) => p.id === Number(id));
			setTimeout(() => {
				this.status(conn, TermPath.CONNECTING, 0, "");
				if (this.silentOffers) return;
				if (peer === undefined || this.endOffersWith !== "") {
					// A browser's real offer (the visual harness) or a test asking for it: no direct path.
					this.machine.send(socket, { case: "termSignal", value: { link, kind: TermSignalKind.END, reason: this.endOffersWith || "no_address" } });
					return;
				}
				conn.direct = peer;
				this.machine.send(socket, { case: "termSignal", value: { link, kind: TermSignalKind.ANSWER, sdp: FINGERPRINT_SDP } });
				this.machine.send(socket, { case: "termSignal", value: { link, kind: TermSignalKind.CANDIDATE, candidate: "candidate:2 1 udp 1686052607 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0" } });
			}, 0);
			return [{ case: "ack", value: {} }];
		}
		const conn = this.conns.get(`${this.machine.sockets.indexOf(socket)}:${link}`);
		if (conn === undefined) return [{ case: "error", value: { code: ErrorCode.NOT_FOUND, message: "no such link" } }];
		if (kind === TermSignalKind.END && conn.direct !== null) {
			const had = conn.direct.connectionState === "connected";
			conn.direct = null;
			if (conn.relay && had) setTimeout(() => this.status(conn, TermPath.RELAY, 0, ""), 0);
		}
		return [{ case: "ack", value: {} }];
	}

	private relayFrame(socket: FakeSocket, link: number, data: Uint8Array): void {
		const run = () => {
			if (this.refuse) {
				this.machine.send(socket, { case: "termStatus", value: { link, path: TermPath.CLOSED, reason: "revoked" } });
				return;
			}
			const conn = this.conn(socket, link);
			if (!conn.relay) {
				conn.relay = true;
				this.status(conn, conn.direct?.connectionState === "connected" ? TermPath.DIRECT : TermPath.RELAY, 0, "");
			}
			this.process(conn, data.slice(), "relay");
		};
		if (this.holdRelay) this.heldRelay.push(run);
		else run();
	}

	/** One terminal frame from the device, in arrival order. */
	private process(conn: Conn, bytes: Uint8Array, path: "direct" | "relay"): void {
		if (conn.closed) return;
		const frame = decodeClientFrame(bytes);
		if (frame === null) return this.sendFrame(conn, serverFrames.error(0, 3, "malformed frame"));
		this.frames.push({ frame, path });
		if (frame.type === "hello") {
			conn.hello = true;
			return this.sendFrame(conn, serverFrames.hello());
		}
		if (!conn.hello) return this.sendFrame(conn, serverFrames.error(0, 3, "hello first"));
		switch (frame.type) {
			case "ping":
				return this.sendFrame(conn, serverFrames.pong(frame.micros));
			case "attach": {
				const s = this.sessions.get(frame.session);
				if (s === undefined) return this.sendFrame(conn, serverFrames.error(frame.session, 1, "no such session"));
				if (frame.lastOffset > 0 && frame.lastOffset <= s.log.length) {
					this.sendOutput(conn, s, frame.lastOffset);
				} else {
					const vt = enc.encode(`\x1bc${dec.decode(new Uint8Array(s.log))}`);
					this.sendFrame(conn, serverFrames.snapshot(s.id, s.log.length, s.cols, s.rows, false, vt));
				}
				conn.attached.set(s.id, { sent: s.log.length });
				return;
			}
			case "detach":
				conn.attached.delete(frame.session);
				return;
			case "input": {
				if (!conn.attached.has(frame.session)) return this.sendFrame(conn, serverFrames.error(frame.session, 5, "not attached"));
				const text = dec.decode(frame.data);
				this.keystrokes.push({ session: frame.session, text, path });
				if (this.echo) this.print(frame.session, frame.data);
				return;
			}
			case "resize": {
				const s = this.sessions.get(frame.session);
				if (s !== undefined) {
					s.cols = frame.cols;
					s.rows = frame.rows;
				}
				this.resizes.push({ session: frame.session, cols: frame.cols, rows: frame.rows });
				return;
			}
			case "ack": {
				const at = conn.attached.get(frame.session);
				if (at === undefined) return this.sendFrame(conn, serverFrames.error(frame.session, 5, "not attached"));
				if (frame.offset > at.sent) return this.sendFrame(conn, serverFrames.error(frame.session, 3, "ack beyond sent output"));
				this.acks.push({ session: frame.session, offset: frame.offset, path });
				return;
			}
		}
	}

	private sendOutput(conn: Conn, s: Session, from: number): void {
		for (let at = from; at < s.log.length; at += CHUNK) {
			const data = new Uint8Array(s.log.slice(at, Math.min(at + CHUNK, s.log.length)));
			this.sendFrame(conn, serverFrames.output(s.id, at, data));
		}
	}

	/** On the direct path when it is open, else the relay. */
	sendFrame(conn: Conn, frame: Uint8Array): void {
		const direct = conn.direct;
		if (direct !== null && direct.connectionState === "connected") {
			direct.channel("term-out").receive(frame);
			return;
		}
		if (!conn.relay) return;
		this.machine.send(conn.socket, { case: "termData", value: { link: conn.link, data: frame } });
	}

	private status(conn: Conn, path: TermPath, rttMs: number, reason: string): void {
		this.machine.send(conn.socket, { case: "termStatus", value: { link: conn.link, path, rttMs, reason } });
	}
}

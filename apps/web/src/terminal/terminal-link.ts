// One terminal client of this page to one machine (a "link" of
// docs/terminal-wire.md section 8), shared by every terminal tab of the
// machine. Terminal frames go straight to the machine's terminal process over
// WebRTC (two data channels, term-in and term-out) when a direct path opens
// within 5 s; otherwise, and whenever that path drops, they go as TermData
// over a second end-to-end connection that carries nothing but the terminal
// (the carrier). The carrier also carries the WebRTC signaling, so the DTLS
// fingerprints in the SDP are the ones the paired machine sent.
//
// Output is applied strictly by offset: a frame past what is applied is a gap
// (dropped, then asked again with Attach), bytes before it are duplicates
// (cut). After any change of path every attached session is attached again
// with the offset applied, so nothing is lost or shown twice. Going from a
// live relay to the direct path waits for the Pong of a Ping sent on the
// relay before anything goes direct, so keystrokes keep their order. Output
// is acknowledged once the screen wrote it (16 KiB at a time, or 50 ms after
// the first byte not acknowledged), which is what paces the machine.
//
// Bytes are handed to the screen as they come; only the status (path, round
// trip) is state for React, and it changes at most once a second while
// steady.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ErrorReason, TermPath, TermSignalKind, type Frame, type FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { RemoteError, type LinkStatus, type Timers } from "../machines/link/machine-link.ts";
import { frameBytes } from "../machines/link/socket.ts";
import {
	MAX_INPUT,
	TermErrorCode,
	WIRE_VERSION,
	decodeServerFrame,
	encodeAck,
	encodeAttach,
	encodeDetach,
	encodeHello,
	encodeInput,
	encodePing,
	encodeResize,
	validDim,
} from "./terminal-wire.ts";

type FrameBody = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

/** How long a new link waits for the direct path before it uses the relay. */
export const DIRECT_WAIT_MS = 5_000;
/** Acknowledge once this much output was written... */
export const ACK_BYTES = 16 * 1024;
/** ...or this long after the first byte not acknowledged. */
export const ACK_MS = 50;
export const PING_MS = 500;
/** The barrier's Pong never came (the relay died meanwhile): go direct anyway. */
export const BARRIER_MS = 2_000;
/** A gap asks again at most this often per session. */
const RESYNC_MS = 250;
/** "disconnected" this long counts as a dropped direct path (the relay is ready). */
const DISCONNECTED_MS = 3_000;
/** Attempts at the direct path again while on the relay. */
const DIRECT_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** New links after the machine closed one. */
const RELINK_MS = [500, 2_000, 5_000, 10_000] as const;
/** Keystrokes typed while no path is up, kept until one is (bytes). */
const MAX_PENDING_INPUT = 64 * 1024;
/** The page left: the link and its connection close after this long unused. */
const IDLE_MS = 60_000;
/** The round trip shown changes at most this often. */
const RTT_EMIT_MS = 1_000;

/** The default STUN server: the relay's host (docs/terminal-wire.md, "Đường thẳng"). */
export function defaultIceServers(domain: string): { urls: string }[] {
	return [{ urls: `stun:tunnel.${domain}:3478` }];
}

// --- what the link needs of the world ----------------------------------------

/** The terminal's own end-to-end connection (a MachineLink of purpose "terminal"). */
export interface TerminalCarrier {
	request(body: FrameBody): Promise<Frame>;
	post(body: FrameBody): boolean;
	onFrame(listener: (body: Frame["body"]) => void): () => void;
	subscribe(listener: () => void): () => void;
	snapshot(): { readonly status: LinkStatus };
	start(): void;
	stop(): void;
}

export interface PeerChannel {
	binaryType: BinaryType;
	readonly readyState: string;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
}

/** The part of RTCPeerConnection the link uses; tests pass a fake (jsdom has no WebRTC). */
export interface PeerConnection {
	readonly connectionState: string;
	onicecandidate: ((event: { readonly candidate: { readonly candidate: string } | null }) => void) | null;
	onconnectionstatechange: (() => void) | null;
	createDataChannel(label: string, init: { ordered: boolean }): PeerChannel;
	createOffer(): Promise<{ readonly type: string; readonly sdp?: string }>;
	setLocalDescription(description: { type: "offer"; sdp: string }): Promise<void>;
	setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
	addIceCandidate(candidate: { candidate: string; sdpMLineIndex: number }): Promise<void>;
	close(): void;
}

export type PeerFactory = (config: { readonly iceServers: readonly { readonly urls: string }[] }) => PeerConnection;

/** The browser's WebRTC; null where there is none (the link then uses the relay only). */
export function browserPeers(): PeerFactory | null {
	if (typeof RTCPeerConnection !== "function") return null;
	// A fresh RTCPeerConnection makes a fresh DTLS certificate: one per connection.
	return (config) => new RTCPeerConnection({ iceServers: config.iceServers.map((s) => ({ urls: s.urls })) }) as unknown as PeerConnection;
}

/** What a session's screen does with the bytes; `done` runs once they are written. */
export interface TerminalSink {
	snapshot(snapshot: { readonly cols: number; readonly rows: number; readonly altScreen: boolean; readonly vt: Uint8Array }): void;
	output(data: Uint8Array, done: () => void): void;
	exit(code: number, signal: number): void;
	/** The machine has no such session any more. */
	gone(): void;
}

export interface TerminalLinkDeps {
	readonly carrier: TerminalCarrier;
	/** null: relay only. */
	readonly peers: PeerFactory | null;
	readonly iceServers: readonly { readonly urls: string }[];
	readonly timers?: Timers;
	/** Milliseconds with sub-millisecond precision, for round trips (performance.now). */
	readonly clock?: () => number;
	readonly random?: () => number;
}

export type TerminalFailure =
	/** The machine does not let this device open terminals (not paired, or revoked before). */
	| "refused"
	/** The device was revoked while its terminal was open. */
	| "revoked"
	/** The machine's terminal process is missing or does not start. */
	| "unavailable"
	/** The terminal process speaks another version of the terminal frames. */
	| "unsupported";

export type TerminalStatus =
	| { readonly kind: "idle" }
	| { readonly kind: "connecting" }
	/** `directIssue`: why the direct path is not in use while on the relay ("" when it was never tried). */
	| { readonly kind: "open"; readonly path: "direct" | "relay"; readonly rttMs: number | null; readonly directIssue: string }
	| { readonly kind: "reconnecting"; readonly attempt: number }
	| { readonly kind: "failed"; readonly reason: TerminalFailure };

// --- internal state -------------------------------------------------------------

type Path = "direct" | "relay";

interface SessionState {
	readonly id: number;
	readonly sink: TerminalSink;
	/** Output handed to the screen. */
	applied: number;
	/** Output the screen finished writing. */
	written: number;
	acked: number;
	ackTimer: unknown;
	/** Bumped by a snapshot: writes finishing from before it no longer count. */
	epoch: number;
	/** A gap was seen and not asked again yet. */
	gap: boolean;
	resyncAt: number;
	resyncTimer: unknown;
	size: { cols: number; rows: number } | null;
}

interface DirectAttempt {
	readonly pc: PeerConnection;
	readonly tin: PeerChannel;
	readonly tout: PeerChannel;
	open: boolean;
	/** The offer went out (candidates may follow it). */
	offered: boolean;
	answered: boolean;
	/** The machine reported this peer's path open. */
	machineDirect: boolean;
	readonly localCandidates: string[];
	readonly remoteCandidates: string[];
	disconnectTimer: unknown;
}

interface Barrier {
	readonly token: number;
	readonly held: Uint8Array<ArrayBuffer>[];
	readonly timer: unknown;
}

interface Generation {
	readonly linkId: number;
	sendPath: Path | null;
	/** A frame went on the relay: the machine holds the relay of this link open. */
	relayOpen: boolean;
	helloAnswered: boolean;
	/** The Ping that opened the relay behind the direct path: its Pong mixes both paths, no round trip. */
	standbyPing: number;
	direct: DirectAttempt | null;
	barrier: Barrier | null;
	fallbackTimer: unknown;
	retryTimer: unknown;
	retries: number;
	directIssue: string;
}

const systemTimers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	now: () => Date.now(),
};

/** An `a=fingerprint:` line: the DTLS certificate the answer pins. */
const FINGERPRINT = /^a=fingerprint:\S+ [0-9A-Fa-f:]+\s*$/m;

export class TerminalLink {
	private readonly timers: Timers;
	private readonly clock: () => number;
	private readonly random: () => number;
	private readonly listeners = new Set<() => void>();
	private readonly sessions = new Map<number, SessionState>();
	private current: TerminalStatus = { kind: "idle" };
	private gen: Generation | null = null;
	private failure: TerminalFailure | null = null;
	private started = false;
	private relinks = 0;
	private relinkTimer: unknown = null;
	private idleTimer: unknown = null;
	private pingTimer: unknown = null;
	private pendingInput: Uint8Array<ArrayBuffer>[] = [];
	private pendingBytes = 0;
	private lastPing = 0;
	private readonly rtts: number[] = [];
	private rttShown: number | null = null;
	private rttShownAt = 0;
	private offCarrier: (() => void)[] = [];

	constructor(private readonly deps: TerminalLinkDeps) {
		this.timers = deps.timers ?? systemTimers;
		this.clock = deps.clock ?? (() => performance.now());
		this.random = deps.random ?? Math.random;
	}

	// --- state for React ---------------------------------------------------------

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly status = (): TerminalStatus => this.current;

	// --- lifecycle -----------------------------------------------------------------

	/** A view needs the terminal: connect (again), and stay until release(). */
	start(): void {
		this.timers.clearTimeout(this.idleTimer);
		this.idleTimer = null;
		if (this.started) return;
		this.started = true;
		this.failure = null;
		this.relinks = 0;
		const carrier = this.deps.carrier;
		this.offCarrier = [carrier.subscribe(() => this.carrierChanged()), carrier.onFrame((body) => this.carrierFrame(body))];
		carrier.start();
		this.carrierChanged();
	}

	/** The views left: close the link and its connection if nothing starts it again within a minute. */
	release(): void {
		if (!this.started) return;
		this.timers.clearTimeout(this.idleTimer);
		this.idleTimer = this.timers.setTimeout(() => {
			this.idleTimer = null;
			this.stop();
		}, IDLE_MS);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.timers.clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.timers.clearTimeout(this.relinkTimer);
		this.relinkTimer = null;
		this.endGeneration(true);
		for (const off of this.offCarrier) off();
		this.offCarrier = [];
		this.deps.carrier.stop();
		this.pendingInput = [];
		this.pendingBytes = 0;
		this.update();
	}

	/** After a failure the user asked to try again. */
	retry(): void {
		if (this.failure === null) return;
		this.failure = null;
		this.relinks = 0;
		this.carrierChanged();
	}

	// --- sessions --------------------------------------------------------------------

	/**
	 * Shows `session` in `sink`: the machine sends a snapshot of its screen,
	 * then live output. Returns the function that stops it (the session runs on).
	 */
	attach(session: number, sink: TerminalSink): () => void {
		this.dropSession(session, true);
		const s: SessionState = {
			id: session,
			sink,
			applied: 0,
			written: 0,
			acked: 0,
			ackTimer: null,
			epoch: 0,
			gap: false,
			resyncAt: 0,
			resyncTimer: null,
			size: null,
		};
		this.sessions.set(session, s);
		const gen = this.gen;
		if (gen?.sendPath != null) this.sendAttach(gen, s);
		else this.carrierChanged();
		return () => {
			if (this.sessions.get(session) === s) this.dropSession(session, true);
		};
	}

	/** Keystrokes for `session`, sent at once (longer pastes in several frames). */
	input(session: number, data: Uint8Array): void {
		if (!this.sessions.has(session) || data.length === 0) return;
		for (let at = 0; at < data.length; at += MAX_INPUT) {
			const frame = encodeInput(session, data.subarray(at, at + MAX_INPUT));
			const gen = this.gen;
			if (gen?.sendPath != null) this.send(gen, frame);
			else if (this.pendingBytes + frame.length <= MAX_PENDING_INPUT) {
				this.pendingInput.push(frame);
				this.pendingBytes += frame.length;
			}
		}
	}

	resize(session: number, cols: number, rows: number): void {
		const s = this.sessions.get(session);
		if (s === undefined || !validDim(cols) || !validDim(rows)) return;
		if (s.size?.cols === cols && s.size.rows === rows) return;
		s.size = { cols, rows };
		const gen = this.gen;
		if (gen?.sendPath != null) this.send(gen, encodeResize(session, cols, rows));
	}

	private dropSession(session: number, detach: boolean): void {
		const s = this.sessions.get(session);
		if (s === undefined) return;
		this.timers.clearTimeout(s.ackTimer);
		this.timers.clearTimeout(s.resyncTimer);
		this.sessions.delete(session);
		const gen = this.gen;
		if (detach && gen?.sendPath != null) this.send(gen, encodeDetach(session));
	}

	// --- the carrier -------------------------------------------------------------------

	private carrierChanged(): void {
		if (!this.started) return;
		const open = this.deps.carrier.snapshot().status.kind === "open";
		if (!open) {
			// The machine ends every link of a connection that closed: start over when it is back.
			if (this.gen !== null) {
				this.endGeneration(false);
				this.relinks += 1;
			}
		} else if (this.gen === null && this.failure === null && this.relinkTimer === null && this.sessions.size > 0) {
			this.beginGeneration();
		}
		this.update();
	}

	private carrierFrame(body: Frame["body"]): void {
		const gen = this.gen;
		if (gen === null) return;
		switch (body.case) {
			case "termData":
				if (body.value.link === gen.linkId) this.receive(gen, body.value.data);
				return;
			case "termSignal":
				if (body.value.link === gen.linkId) this.signalFromMachine(gen, body.value.kind, body.value.sdp, body.value.candidate, body.value.reason);
				return;
			case "termStatus":
				if (body.value.link === gen.linkId) this.statusFromMachine(gen, body.value.path, body.value.rttMs, body.value.reason);
				return;
			default:
				return;
		}
	}

	// --- generations: one link id each, from Hello to its end ---------------------------------

	private beginGeneration(): void {
		const gen: Generation = {
			linkId: 1 + Math.floor(this.random() * 0xfffffffe),
			sendPath: null,
			relayOpen: false,
			helloAnswered: false,
			standbyPing: 0,
			direct: null,
			barrier: null,
			fallbackTimer: null,
			retryTimer: null,
			retries: 0,
			directIssue: "",
		};
		this.gen = gen;
		if (this.deps.peers === null) {
			this.startPath(gen, "relay");
			return;
		}
		this.startDirect(gen);
		gen.fallbackTimer = this.timers.setTimeout(() => this.giveUpDirect(gen, "timeout"), DIRECT_WAIT_MS);
	}

	/** The first path of a generation: Hello, every session attached with what it applied, its size, then held keystrokes. */
	private startPath(gen: Generation, path: Path): void {
		gen.sendPath = path;
		this.relinks = 0;
		this.transmit(gen, path, encodeHello());
		for (const s of this.sessions.values()) {
			this.sendAttach(gen, s);
		}
		const held = this.pendingInput;
		this.pendingInput = [];
		this.pendingBytes = 0;
		for (const frame of held) this.transmit(gen, path, frame);
		this.timers.clearInterval(this.pingTimer);
		this.pingTimer = this.timers.setInterval(() => this.tick(), PING_MS);
		this.update();
	}

	private sendAttach(gen: Generation, s: SessionState): void {
		s.gap = false;
		s.resyncAt = this.timers.now();
		this.send(gen, encodeAttach(s.id, s.applied));
		if (s.size !== null) this.send(gen, encodeResize(s.id, s.size.cols, s.size.rows));
	}

	private endGeneration(tellMachine: boolean): void {
		const gen = this.gen;
		if (gen === null) return;
		this.gen = null;
		this.closeDirect(gen, tellMachine);
		this.timers.clearTimeout(gen.fallbackTimer);
		this.timers.clearTimeout(gen.retryTimer);
		if (gen.barrier !== null) this.timers.clearTimeout(gen.barrier.timer);
		gen.barrier = null;
		this.timers.clearInterval(this.pingTimer);
		this.pingTimer = null;
		this.rtts.length = 0;
		this.rttShown = null;
	}

	/** The machine closed the link: a new one (with Attach at the applied offsets), unless it is for good. */
	private generationClosed(gen: Generation, reason: string): void {
		if (this.gen !== gen) return;
		this.endGeneration(false);
		if (reason === "revoked") return this.fail("revoked");
		if (reason === "unavailable") return this.fail("unavailable");
		this.relinks += 1;
		const delay = RELINK_MS[Math.min(this.relinks - 1, RELINK_MS.length - 1)] ?? 10_000;
		this.timers.clearTimeout(this.relinkTimer);
		this.relinkTimer = this.timers.setTimeout(() => {
			this.relinkTimer = null;
			this.carrierChanged();
		}, delay);
		this.update();
	}

	private fail(reason: TerminalFailure): void {
		this.endGeneration(false);
		this.failure = reason;
		this.update();
	}

	// --- the direct path -------------------------------------------------------------------

	private startDirect(gen: Generation): void {
		const peers = this.deps.peers;
		if (peers === null) return;
		let pc: PeerConnection;
		let tin: PeerChannel;
		let tout: PeerChannel;
		try {
			pc = peers({ iceServers: this.deps.iceServers });
			// Both before the offer, so the SDP has its m=application section (ordered, reliable).
			tin = pc.createDataChannel("term-in", { ordered: true });
			tout = pc.createDataChannel("term-out", { ordered: true });
		} catch {
			this.giveUpDirect(gen, "unsupported");
			return;
		}
		tin.binaryType = "arraybuffer";
		tout.binaryType = "arraybuffer";
		const attempt: DirectAttempt = {
			pc,
			tin,
			tout,
			open: false,
			offered: false,
			answered: false,
			machineDirect: false,
			localCandidates: [],
			remoteCandidates: [],
			disconnectTimer: null,
		};
		gen.direct = attempt;
		const mine = () => this.gen === gen && gen.direct === attempt;
		const opened = () => {
			if (mine() && !attempt.open && tin.readyState === "open" && tout.readyState === "open") this.directOpened(gen, attempt);
		};
		tin.onopen = opened;
		tout.onopen = opened;
		const closed = () => {
			if (mine()) this.directEnded(gen, "channel_closed", true);
		};
		tin.onclose = closed;
		tout.onclose = closed;
		tout.onmessage = (event) => {
			if (!mine()) return;
			const bytes = frameBytes(event.data);
			if (bytes !== null) this.receive(gen, bytes);
		};
		pc.onicecandidate = (event) => {
			const line = event.candidate?.candidate ?? "";
			if (!mine() || line === "") return;
			if (attempt.offered) this.signal(gen, TermSignalKind.CANDIDATE, { candidate: line });
			else attempt.localCandidates.push(line);
		};
		pc.onconnectionstatechange = () => {
			if (!mine()) return;
			const state = pc.connectionState;
			if (state === "failed" || state === "closed") return this.directEnded(gen, state === "failed" ? "ice_failed" : "closed", true);
			if (state === "disconnected") {
				if (attempt.disconnectTimer === null) {
					attempt.disconnectTimer = this.timers.setTimeout(() => {
						attempt.disconnectTimer = null;
						if (mine() && pc.connectionState === "disconnected") this.directEnded(gen, "ice_disconnected", true);
					}, DISCONNECTED_MS);
				}
				return;
			}
			this.timers.clearTimeout(attempt.disconnectTimer);
			attempt.disconnectTimer = null;
		};
		void this.offer(gen, attempt, mine);
	}

	private async offer(gen: Generation, attempt: DirectAttempt, mine: () => boolean): Promise<void> {
		let answered: Promise<Frame>;
		try {
			const offer = await attempt.pc.createOffer();
			if (!mine()) return;
			const sdp = offer.sdp ?? "";
			await attempt.pc.setLocalDescription({ type: "offer", sdp });
			if (!mine()) return;
			answered = this.deps.carrier.request({ case: "termSignal", value: { link: gen.linkId, kind: TermSignalKind.OFFER, sdp } });
		} catch {
			if (mine()) this.directEnded(gen, "offer_failed", false);
			return;
		}
		// Candidates found while the offer was made follow it on the same connection, in order.
		attempt.offered = true;
		for (const line of attempt.localCandidates.splice(0)) this.signal(gen, TermSignalKind.CANDIDATE, { candidate: line });
		try {
			await answered;
		} catch (err) {
			if (!mine()) return;
			if (err instanceof RemoteError && err.reason === ErrorReason.ACCESS_DENIED) return this.fail("refused");
			if (err instanceof RemoteError && err.reason === ErrorReason.TERMINAL_UNAVAILABLE) return this.fail("unavailable");
			this.directEnded(gen, "offer_refused", false);
		}
	}

	private signal(gen: Generation, kind: TermSignalKind, fields: { candidate?: string }): void {
		this.deps.carrier.request({ case: "termSignal", value: { link: gen.linkId, kind, ...fields } }).catch(() => undefined);
	}

	private directOpened(gen: Generation, attempt: DirectAttempt): void {
		attempt.open = true;
		this.timers.clearTimeout(gen.fallbackTimer);
		gen.fallbackTimer = null;
		this.timers.clearTimeout(gen.retryTimer);
		gen.retryTimer = null;
		gen.retries = 0;
		gen.directIssue = "";
		if (gen.sendPath === null) {
			this.startPath(gen, "direct");
			return;
		}
		if (gen.sendPath === "relay") this.beginBarrier(gen);
	}

	/**
	 * Leaving a live relay: a Ping goes on the relay after its last frame and
	 * nothing goes direct until its Pong is back (the machine handles relay
	 * frames in order, so every keystroke before it reached the shell).
	 */
	private beginBarrier(gen: Generation): void {
		const token = this.nextPing();
		const timer = this.timers.setTimeout(() => this.finishBarrier(gen), BARRIER_MS);
		gen.barrier = { token, held: [], timer };
		if (!this.transmit(gen, "relay", encodePing(token))) this.finishBarrier(gen);
		this.update();
	}

	private finishBarrier(gen: Generation): void {
		const barrier = gen.barrier;
		if (barrier === null || this.gen !== gen) return;
		gen.barrier = null;
		this.timers.clearTimeout(barrier.timer);
		if (gen.direct?.open !== true) {
			// The direct path died while waiting: everything stays on the relay.
			for (const frame of barrier.held) this.transmit(gen, "relay", frame);
			this.update();
			return;
		}
		gen.sendPath = "direct";
		for (const s of this.sessions.values()) this.sendAttach(gen, s);
		for (const frame of barrier.held) this.transmit(gen, "direct", frame);
		this.update();
	}

	/** No direct path in time: the relay carries the link; try again later. */
	private giveUpDirect(gen: Generation, issue: string): void {
		if (this.gen !== gen) return;
		this.timers.clearTimeout(gen.fallbackTimer);
		gen.fallbackTimer = null;
		if (gen.direct?.open === true) return;
		this.closeDirect(gen, true);
		gen.directIssue = issue;
		this.useRelay(gen);
		this.scheduleDirectRetry(gen);
	}

	/** The direct path ended (or never opened): the relay takes over with Attach at the applied offsets. */
	private directEnded(gen: Generation, issue: string, tellMachine: boolean): void {
		if (this.gen !== gen || gen.direct === null) return;
		this.timers.clearTimeout(gen.fallbackTimer);
		gen.fallbackTimer = null;
		this.closeDirect(gen, tellMachine);
		gen.directIssue = issue;
		const barrier = gen.barrier;
		if (barrier !== null) {
			gen.barrier = null;
			this.timers.clearTimeout(barrier.timer);
			for (const frame of barrier.held) this.transmit(gen, "relay", frame);
		}
		this.useRelay(gen);
		this.scheduleDirectRetry(gen);
	}

	private useRelay(gen: Generation): void {
		if (gen.sendPath === null) return this.startPath(gen, "relay");
		if (gen.sendPath === "relay") return this.update();
		gen.sendPath = "relay";
		// Keystrokes in flight on the dead path may be lost; they are not sent again.
		for (const s of this.sessions.values()) this.sendAttach(gen, s);
		this.update();
	}

	private scheduleDirectRetry(gen: Generation): void {
		if (this.deps.peers === null || gen.retryTimer !== null) return;
		const delay = DIRECT_RETRY_MS[Math.min(gen.retries, DIRECT_RETRY_MS.length - 1)] ?? 300_000;
		gen.retries += 1;
		gen.retryTimer = this.timers.setTimeout(() => {
			gen.retryTimer = null;
			if (this.gen !== gen || gen.direct !== null || gen.sendPath !== "relay") return;
			this.startDirect(gen);
			if (this.gen === gen && gen.direct !== null) {
				gen.fallbackTimer = this.timers.setTimeout(() => this.giveUpDirect(gen, gen.directIssue || "timeout"), DIRECT_WAIT_MS);
			}
		}, delay);
	}

	private closeDirect(gen: Generation, tellMachine: boolean): void {
		const attempt = gen.direct;
		if (attempt === null) return;
		gen.direct = null;
		this.timers.clearTimeout(attempt.disconnectTimer);
		attempt.tin.onopen = attempt.tin.onclose = attempt.tout.onopen = attempt.tout.onclose = null;
		attempt.tout.onmessage = null;
		attempt.pc.onicecandidate = null;
		attempt.pc.onconnectionstatechange = null;
		for (const close of [() => attempt.tin.close(), () => attempt.tout.close(), () => attempt.pc.close()]) {
			try {
				close();
			} catch {
				// already closed
			}
		}
		// The machine drops its peer now instead of waiting for ICE to time out; the relay stays.
		if (tellMachine && attempt.offered) this.signal(gen, TermSignalKind.END, {});
	}

	// --- frames from the machine -----------------------------------------------------------

	private signalFromMachine(gen: Generation, kind: TermSignalKind, sdp: string, candidate: string, reason: string): void {
		const attempt = gen.direct;
		if (attempt === null || !attempt.offered) return;
		switch (kind) {
			case TermSignalKind.ANSWER: {
				if (attempt.answered) return;
				if (!FINGERPRINT.test(sdp)) return this.directEnded(gen, "no_fingerprint", true);
				attempt.answered = true;
				attempt.pc.setRemoteDescription({ type: "answer", sdp }).then(
					() => {
						if (gen.direct !== attempt) return;
						for (const line of attempt.remoteCandidates.splice(0)) this.addCandidate(attempt, line);
					},
					() => this.directEnded(gen, "bad_answer", true),
				);
				return;
			}
			case TermSignalKind.CANDIDATE:
				if (candidate === "") return;
				if (attempt.answered) this.addCandidate(attempt, candidate);
				else attempt.remoteCandidates.push(candidate);
				return;
			case TermSignalKind.END:
				// The machine already dropped its peer: nothing to tell it.
				return this.directEnded(gen, reason || "ended", false);
			default:
				return;
		}
	}

	private addCandidate(attempt: DirectAttempt, line: string): void {
		// One m=application section: index 0.
		attempt.pc.addIceCandidate({ candidate: line.replace(/^a=/, ""), sdpMLineIndex: 0 }).catch(() => undefined);
	}

	private statusFromMachine(gen: Generation, path: TermPath, rttMs: number, reason: string): void {
		switch (path) {
			case TermPath.DIRECT:
				// Comes once when the channels open and once more with the ICE round trip.
				if (gen.direct !== null) gen.direct.machineDirect = true;
				if (rttMs > 0 && this.rtts.length === 0) this.showRtt(rttMs, true);
				return;
			case TermPath.RELAY:
				// The machine lost the direct path it had reported (a relay opening while it is up says "direct").
				if (gen.direct?.machineDirect === true) this.directEnded(gen, "relay", false);
				return;
			case TermPath.CLOSED:
				return this.generationClosed(gen, reason);
			default:
				return;
		}
	}

	private receive(gen: Generation, bytes: Uint8Array): void {
		if (this.gen !== gen) return;
		const frame = decodeServerFrame(bytes);
		if (frame === null) return;
		switch (frame.type) {
			case "hello":
				if (frame.version !== WIRE_VERSION) return this.fail("unsupported");
				gen.helloAnswered = true;
				// Direct first: open the relay of this link now, so the link survives the direct path dropping.
				if (gen.sendPath === "direct" && !gen.relayOpen) {
					gen.standbyPing = this.nextPing();
					this.transmit(gen, "relay", encodePing(gen.standbyPing));
				}
				return;
			case "output": {
				const s = this.sessions.get(frame.session);
				if (s !== undefined) this.applyOutput(gen, s, frame.offset, frame.data);
				return;
			}
			case "snapshot": {
				const s = this.sessions.get(frame.session);
				if (s === undefined) return;
				s.epoch += 1;
				s.applied = s.written = s.acked = frame.offset;
				s.gap = false;
				this.timers.clearTimeout(s.ackTimer);
				s.ackTimer = null;
				s.sink.snapshot({ cols: frame.cols, rows: frame.rows, altScreen: frame.altScreen, vt: frame.vt });
				return;
			}
			case "exit":
				this.sessions.get(frame.session)?.sink.exit(frame.code, frame.signal);
				return;
			case "pong":
				if (gen.barrier?.token === frame.micros) return this.finishBarrier(gen);
				if (gen.standbyPing === frame.micros) return;
				this.showRtt(this.clock() - frame.micros / 1000, false);
				return;
			case "error":
				return this.machineError(gen, frame.session, frame.code);
			case "unknown":
				return;
		}
	}

	private machineError(gen: Generation, session: number, code: number): void {
		switch (code) {
			case TermErrorCode.revoked:
				return this.fail("revoked");
			case TermErrorCode.badVersion:
				return this.fail("unsupported");
			case TermErrorCode.noSuchSession: {
				const s = this.sessions.get(session);
				if (s === undefined) return;
				this.dropSession(session, false);
				s.sink.gone();
				return;
			}
			case TermErrorCode.notAttached: {
				// A frame raced its Attach (a path change): attach again.
				const s = this.sessions.get(session);
				if (s === undefined) return;
				s.gap = true;
				this.askAgain(gen, s);
				return;
			}
			default:
				return;
		}
	}

	private applyOutput(gen: Generation, s: SessionState, offset: number, data: Uint8Array): void {
		if (offset > s.applied) {
			// A gap: the bytes before it come again after an Attach.
			s.gap = true;
			this.askAgain(gen, s);
			return;
		}
		const end = offset + data.length;
		if (end <= s.applied) return;
		const fresh = offset === s.applied ? data : data.subarray(s.applied - offset);
		s.applied = end;
		const epoch = s.epoch;
		s.sink.output(fresh, () => this.written(s, epoch, end));
	}

	/** Attach with the applied offset, at most every RESYNC_MS per session. */
	private askAgain(gen: Generation, s: SessionState): void {
		if (s.resyncTimer !== null) return;
		const wait = s.resyncAt + RESYNC_MS - this.timers.now();
		if (wait <= 0) {
			this.sendAttach(gen, s);
			return;
		}
		s.resyncTimer = this.timers.setTimeout(() => {
			s.resyncTimer = null;
			if (this.gen === gen && this.sessions.get(s.id) === s && s.gap) this.askAgain(gen, s);
		}, wait);
	}

	private written(s: SessionState, epoch: number, end: number): void {
		if (s.epoch !== epoch || this.sessions.get(s.id) !== s) return;
		if (end > s.written) s.written = end;
		if (s.written - s.acked >= ACK_BYTES) return this.ack(s);
		if (s.written > s.acked && s.ackTimer === null) {
			s.ackTimer = this.timers.setTimeout(() => {
				s.ackTimer = null;
				if (s.written > s.acked) this.ack(s);
			}, ACK_MS);
		}
	}

	private ack(s: SessionState): void {
		this.timers.clearTimeout(s.ackTimer);
		s.ackTimer = null;
		s.acked = s.written;
		const gen = this.gen;
		if (gen?.sendPath != null && this.sessions.get(s.id) === s) this.send(gen, encodeAck(s.id, s.written));
	}

	// --- sending -----------------------------------------------------------------------------

	/** A frame on the path in use; held while the barrier waits. */
	private send(gen: Generation, frame: Uint8Array<ArrayBuffer>): void {
		if (gen.barrier !== null) {
			gen.barrier.held.push(frame);
			return;
		}
		if (gen.sendPath !== null) this.transmit(gen, gen.sendPath, frame);
	}

	private transmit(gen: Generation, path: Path, frame: Uint8Array<ArrayBuffer>): boolean {
		if (path === "relay") {
			gen.relayOpen = true;
			return this.deps.carrier.post({ case: "termData", value: { link: gen.linkId, data: frame } });
		}
		const attempt = gen.direct;
		if (attempt === null || !attempt.open || attempt.tin.readyState !== "open") return false;
		try {
			attempt.tin.send(frame);
			return true;
		} catch {
			this.directEnded(gen, "send_failed", true);
			return false;
		}
	}

	private tick(): void {
		const gen = this.gen;
		if (gen === null || gen.sendPath === null || gen.barrier !== null) return;
		this.transmit(gen, gen.sendPath, encodePing(this.nextPing()));
	}

	/** A Ping value (microseconds of the clock) never used before. */
	private nextPing(): number {
		const micros = Math.max(this.lastPing + 1, Math.floor(this.clock() * 1000));
		this.lastPing = micros;
		return micros;
	}

	private showRtt(ms: number, fromMachine: boolean): void {
		if (!(ms >= 0) || !Number.isFinite(ms)) return;
		if (!fromMachine) {
			this.rtts.push(ms);
			if (this.rtts.length > 5) this.rtts.shift();
		}
		const sorted = fromMachine ? [ms] : [...this.rtts].sort((a, b) => a - b);
		const median = Math.round(sorted[Math.floor(sorted.length / 2)] ?? ms);
		const now = this.timers.now();
		if (median === this.rttShown || (this.rttShown !== null && now - this.rttShownAt < RTT_EMIT_MS)) return;
		this.rttShown = median;
		this.rttShownAt = now;
		this.update();
	}

	// --- status ------------------------------------------------------------------------------

	private computeStatus(): TerminalStatus {
		if (this.failure !== null) return { kind: "failed", reason: this.failure };
		if (!this.started) return { kind: "idle" };
		const gen = this.gen;
		if (gen?.sendPath != null) {
			// While the barrier waits the relay still carries everything.
			const path: Path = gen.barrier !== null ? "relay" : gen.sendPath;
			return { kind: "open", path, rttMs: this.rttShown, directIssue: path === "relay" ? gen.directIssue : "" };
		}
		if (this.relinks > 0) return { kind: "reconnecting", attempt: this.relinks };
		// The machine's link is up and no session is attached: nothing is connecting (a generation begins with the first attach).
		if (this.sessions.size === 0 && this.deps.carrier.snapshot().status.kind === "open") return { kind: "idle" };
		return { kind: "connecting" };
	}

	private update(): void {
		const next = this.computeStatus();
		const cur = this.current;
		const same =
			next.kind === cur.kind &&
			(next.kind !== "open" || (cur.kind === "open" && cur.path === next.path && cur.rttMs === next.rttMs && cur.directIssue === next.directIssue)) &&
			(next.kind !== "reconnecting" || (cur.kind === "reconnecting" && cur.attempt === next.attempt)) &&
			(next.kind !== "failed" || (cur.kind === "failed" && cur.reason === next.reason));
		if (same) return;
		this.current = next;
		for (const listener of this.listeners) listener();
	}
}

/**
 * The machine's own screen, for what no browser page shows (a passkey sheet,
 * a Keychain prompt): macOS Screen Sharing, which only the owner turns on in
 * System Settings. tunelo never turns it on or changes a setting; it only:
 *
 * - says whether it is on (a VNC service answers on 127.0.0.1:5900) and
 *   whether it is reachable from the network (it listens beyond loopback and
 *   the firewall does not block all incoming connections);
 * - when a device asks, opens one TCP stream to it and relays the bytes both
 *   ways over the device's end-to-end encrypted link. The VNC client on the
 *   device authenticates with the service itself (Apple's VNC
 *   authentication), so the Mac account's password goes through as opaque
 *   bytes: never read, kept or logged here. Nothing of the stream is logged.
 *
 * One session at a time. It ends when the device closes it, when nothing
 * came from the device for 10 minutes, when the service closes the stream,
 * when the device's link closes, or when tunelo stops.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type Socket, connect } from "node:net";
import { promisify } from "node:util";
import type { AuditLog } from "../safety/audit-log.ts";

const run = promisify(execFile);

export const SCREEN_SHARING_PORT = 5900;
export const SCREEN_SHARE_IDLE_MS = 10 * 60_000;
/** Bytes per frame to the device. */
export const CHUNK_BYTES = 256 * 1024;
/** The device's link holds this much unsent: stop reading the service until it drains below RESUME_BYTES. */
const PAUSE_BYTES = 4 * 1024 * 1024;
const RESUME_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 2_000;
const FIREWALL = "/usr/libexec/ApplicationFirewall/socketfilterfw";

export class ScreenSharingOff extends Error {}
export class ScreenShareBusy extends Error {}
export class ScreenShareGone extends Error {}

export type ScreenShareEndReason = "closed" | "idle" | "service" | "stopped";

export interface ScreenShareStatusInfo {
	supported: boolean;
	enabled: boolean;
	exposed: boolean;
	firewallOn: boolean;
}

/** Where a session's bytes and its end go: one device's link. */
export interface ScreenShareSink {
	data(streamId: string, bytes: Uint8Array): void;
	closed(streamId: string, reason: ScreenShareEndReason): void;
	/** Bytes the device's link has not sent yet. */
	buffered(): number;
}

/** How the machine's state is read (fakes in tests). */
export interface ScreenShareProbe {
	/** Local addresses something listens on for the port (netstat). */
	listening(port: number): Promise<string[]>;
	firewall(): Promise<{ on: boolean; blockAll: boolean }>;
}

/** The local addresses of LISTEN sockets on `port` in `netstat -an -p tcp` output ("*", "127.0.0.1", "::1", …). */
export function listenersIn(netstat: string, port: number): string[] {
	const out: string[] = [];
	for (const line of netstat.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (!cols[0]?.startsWith("tcp") || cols.at(-1) !== "LISTEN") continue;
		const local = cols[3] ?? "";
		const suffix = `.${port}`;
		if (local.endsWith(suffix)) out.push(local.slice(0, -suffix.length));
	}
	return out;
}

/** Whether any of these addresses is reachable from beyond this machine. */
export function beyondLoopback(addresses: readonly string[]): boolean {
	return addresses.some((a) => !(a.startsWith("127.") || a === "::1" || a === "localhost"));
}

/** The firewall's state from `socketfilterfw --getglobalstate` and `--getblockall`. */
export function firewallFrom(globalState: string, blockAll: string): { on: boolean; blockAll: boolean } {
	return { on: /enabled/i.test(globalState) && !/disabled/i.test(globalState), blockAll: /\benabled\b/i.test(blockAll) };
}

export const macProbe: ScreenShareProbe = {
	async listening(port) {
		try {
			const { stdout } = await run("netstat", ["-an", "-p", "tcp"], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
			return listenersIn(stdout, port);
		} catch {
			return [];
		}
	},
	async firewall() {
		try {
			const [g, b] = await Promise.all([run(FIREWALL, ["--getglobalstate"], { timeout: 5_000 }), run(FIREWALL, ["--getblockall"], { timeout: 5_000 })]);
			return firewallFrom(g.stdout, b.stdout);
		} catch {
			return { on: false, blockAll: false };
		}
	},
};

/** Whether a VNC service answers at host:port (it greets with "RFB "). The probe reads the greeting only. */
export function vncAnswers(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		let done = false;
		const finish = (yes: boolean) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve(yes);
		};
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("error", () => finish(false));
		socket.once("data", (d: Buffer) => finish(d.subarray(0, 4).toString("latin1") === "RFB "));
		socket.once("close", () => finish(false));
	});
}

interface Session {
	id: string;
	sink: ScreenShareSink;
	socket: Socket;
	lastFromDevice: number;
	timer: ReturnType<typeof setInterval>;
	resume: ReturnType<typeof setInterval> | undefined;
}

export interface ScreenShareOptions {
	audit: AuditLog;
	log?: (line: string) => void;
	host?: string;
	port?: number;
	/** macOS only by default. */
	supported?: boolean;
	probe?: ScreenShareProbe;
	idleMs?: number;
	now?: () => number;
}

export class ScreenShare {
	private session: Session | undefined;
	private readonly host: string;
	private readonly port: number;
	private readonly idleMs: number;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	readonly supported: boolean;

	constructor(private readonly opts: ScreenShareOptions) {
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? SCREEN_SHARING_PORT;
		this.idleMs = opts.idleMs ?? SCREEN_SHARE_IDLE_MS;
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => undefined);
		this.supported = opts.supported ?? process.platform === "darwin";
	}

	get idleLimitMs(): number {
		return this.idleMs;
	}

	/** Whether Screen Sharing is on, and reachable from the network. Reads only; changes nothing. */
	async status(): Promise<ScreenShareStatusInfo> {
		if (!this.supported) return { supported: false, enabled: false, exposed: false, firewallOn: false };
		const probe = this.opts.probe ?? macProbe;
		const [enabled, addresses, firewall] = await Promise.all([this.session ? Promise.resolve(true) : vncAnswers(this.host, this.port), probe.listening(this.port), probe.firewall()]);
		const exposed = enabled && beyondLoopback(addresses) && !(firewall.on && firewall.blockAll);
		return { supported: true, enabled, exposed, firewallOn: firewall.on };
	}

	/** A device opens the session (on the user's tap). */
	async open(sink: ScreenShareSink, device: string): Promise<{ streamId: string; idleMs: number }> {
		if (!this.supported) throw new ScreenSharingOff("this machine has no Screen Sharing");
		if (this.session) throw new ScreenShareBusy("a screen sharing session is open already");
		const socket = await new Promise<Socket>((resolve, reject) => {
			const s = connect({ host: this.host, port: this.port });
			s.once("connect", () => {
				s.off("error", reject);
				resolve(s);
			});
			s.once("error", () => reject(new ScreenSharingOff("Screen Sharing is off on this machine")));
		});
		if (this.session) {
			socket.destroy();
			throw new ScreenShareBusy("a screen sharing session is open already");
		}
		socket.setNoDelay(true);
		const id = randomBytes(12).toString("base64url");
		const session: Session = {
			id,
			sink,
			socket,
			lastFromDevice: this.now(),
			timer: setInterval(() => {
				if (this.now() - session.lastFromDevice >= this.idleMs) this.end(session, "idle");
			}, Math.min(this.idleMs, 15_000)),
			resume: undefined,
		};
		session.timer.unref?.();
		this.session = session;
		socket.on("data", (chunk: Buffer) => this.fromService(session, chunk));
		socket.on("error", () => this.end(session, "service"));
		socket.on("close", () => this.end(session, "service"));
		this.opts.audit.write({ device, action: "screen_share", path: `${this.host}:${this.port}`, detail: "open" });
		this.log(`screen share: opened by ${device}`);
		return { streamId: id, idleMs: this.idleMs };
	}

	private fromService(s: Session, chunk: Buffer): void {
		for (let i = 0; i < chunk.byteLength; i += CHUNK_BYTES) {
			const part = chunk.subarray(i, i + CHUNK_BYTES);
			s.sink.data(s.id, new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
		}
		if (s.resume || s.sink.buffered() <= PAUSE_BYTES) return;
		// The device's link is behind: read no more until it catches up.
		s.socket.pause();
		s.resume = setInterval(() => {
			if (s.sink.buffered() > RESUME_BYTES) return;
			clearInterval(s.resume);
			s.resume = undefined;
			s.socket.resume();
		}, 50);
		s.resume.unref?.();
	}

	private mine(streamId: string, sink: ScreenShareSink): Session {
		const s = this.session;
		if (!s || s.id !== streamId || s.sink !== sink) throw new ScreenShareGone("this screen sharing session is no longer open");
		return s;
	}

	/** Bytes from the device to the service. */
	write(streamId: string, sink: ScreenShareSink, data: Uint8Array): void {
		const s = this.mine(streamId, sink);
		s.lastFromDevice = this.now();
		s.socket.write(data);
	}

	close(streamId: string, sink: ScreenShareSink): void {
		this.end(this.mine(streamId, sink), "closed");
	}

	/** A device's link closed: its session ends. */
	drop(sink: ScreenShareSink): void {
		if (this.session?.sink === sink) this.end(this.session, "closed");
	}

	stop(): void {
		if (this.session) this.end(this.session, "stopped");
	}

	private end(s: Session, reason: ScreenShareEndReason): void {
		if (this.session !== s) return;
		this.session = undefined;
		clearInterval(s.timer);
		clearInterval(s.resume);
		s.socket.destroy();
		s.sink.closed(s.id, reason);
		this.log(`screen share: closed (${reason})`);
	}
}

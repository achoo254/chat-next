// The page's terminal link against the real terminal process on the relay
// path, with this test playing the agent (the control socket of
// docs/terminal-wire.md section 6) in place of the end-to-end connection:
// a real shell's snapshot and echo, a large output that only finishes if the
// acknowledgements pace the window right, and a dropped connection whose new
// link continues from the applied offset without losing or repeating a byte.
// Needs the binary (TUNELO_TERM_HOST_BIN; `cargo build --release` in
// apps/term-host makes it); without it the file is skipped, said on stderr.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TermPath, type Frame } from "@achoo254/chat-proto/remote/remote";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LinkStatus } from "../../src/machines/link/machine-link.ts";
import { TerminalLink, type TerminalCarrier, type TerminalSink } from "../../src/terminal/terminal-link.ts";
import { decodeServerFrame } from "../../src/terminal/terminal-wire.ts";

const BIN = process.env.TUNELO_TERM_HOST_BIN;
if (BIN === undefined || BIN === "") {
	// Straight to stderr: vitest keeps console output of a skipped file to itself.
	process.stderr.write(
		"\n*** terminal-host-real.test.ts (web) SKIPPED: TUNELO_TERM_HOST_BIN is not set. Build apps/term-host (cargo build --release) and point it at the binary to run these tests. ***\n\n",
	);
}

type Json = Record<string, unknown>;

/** The agent's side of the control socket: commands, events, relay frames. */
class ControlClient {
	private buf = Buffer.alloc(0);
	private next = 1;
	private readonly waiting = new Map<number, (reply: Json) => void>();
	readonly onEvent = new Set<(event: Json) => void>();
	readonly onRelay = new Set<(conn: number, frame: Uint8Array) => void>();

	constructor(private readonly socket: Socket) {
		socket.on("data", (chunk: Buffer) => this.read(chunk));
	}

	private read(chunk: Buffer): void {
		this.buf = Buffer.concat([this.buf, chunk]);
		while (this.buf.length >= 4) {
			const len = this.buf.readUInt32BE(0);
			if (this.buf.length < 4 + len) return;
			const kind = this.buf[4];
			const body = this.buf.subarray(5, 4 + len);
			this.buf = this.buf.subarray(4 + len);
			if (kind === 1) {
				const conn = body.readUInt32BE(0);
				const frame = new Uint8Array(body.subarray(4));
				for (const l of this.onRelay) l(conn, frame);
				continue;
			}
			const value = JSON.parse(body.toString("utf8")) as Json;
			if (typeof value.event === "string") for (const l of this.onEvent) l(value);
			else if (typeof value.id === "number") this.waiting.get(value.id)?.(value);
		}
	}

	call(cmd: string, params: Json = {}): Promise<Json> {
		const id = this.next++;
		const body = Buffer.from(JSON.stringify({ ...params, id, cmd }));
		const head = Buffer.alloc(5);
		head.writeUInt32BE(body.length + 1, 0);
		head[4] = 0;
		this.socket.write(Buffer.concat([head, body]));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no reply to ${cmd}`)), 10_000);
			this.waiting.set(id, (reply) => {
				clearTimeout(timer);
				this.waiting.delete(id);
				if (reply.ok === true) resolve((reply.result ?? {}) as Json);
				else reject(new Error(`${cmd}: ${JSON.stringify(reply.error)}`));
			});
		});
	}

	relay(conn: number, frame: Uint8Array): void {
		const head = Buffer.alloc(9);
		head.writeUInt32BE(frame.length + 5, 0);
		head[4] = 1;
		head.writeUInt32BE(conn, 5);
		this.socket.write(Buffer.concat([head, Buffer.from(frame)]));
	}
}

/**
 * The end-to-end connection as the link sees it, done the way the agent does
 * it: a link's first TermData grants a connection and opens its relay; its
 * frames go in order; the terminal process's frames come back as TermData;
 * the connection dropping closes the link's connection on the machine.
 */
class RelayCarrier implements TerminalCarrier {
	status: LinkStatus = { kind: "idle" };
	private readonly listeners = new Set<() => void>();
	private readonly frameListeners = new Set<(body: Frame["body"]) => void>();
	private link = 0;
	private conn = 0;
	private chain: Promise<void> = Promise.resolve();
	/** Every frame the terminal process sent, decoded (to check it never answered with an error). */
	readonly fromMachine: ReturnType<typeof decodeServerFrame>[] = [];
	private static nextConn = 500;

	constructor(private readonly control: ControlClient) {
		control.onRelay.add((conn, frame) => {
			if (conn !== this.conn || this.status.kind !== "open") return;
			this.fromMachine.push(decodeServerFrame(frame));
			this.emitFrame({ case: "termData", value: { link: this.link, data: frame } } as Frame["body"]);
		});
		control.onEvent.add((event) => {
			if (event.event === "conn_state" && event.conn === this.conn && event.state === "closed") {
				this.emitFrame({ case: "termStatus", value: { link: this.link, path: TermPath.CLOSED, rttMs: 0, reason: String(event.reason ?? "") } } as Frame["body"]);
			}
		});
	}

	private emitFrame(body: Frame["body"]): void {
		for (const l of this.frameListeners) l(body);
	}

	private set(status: LinkStatus): void {
		this.status = status;
		for (const l of this.listeners) l();
	}

	request(): Promise<Frame> {
		return Promise.reject(new Error("no signaling on this connection"));
	}

	post(body: Parameters<TerminalCarrier["post"]>[0]): boolean {
		if (this.status.kind !== "open" || body.case !== "termData") return false;
		const { link, data } = body.value as { link: number; data: Uint8Array };
		const frame = new Uint8Array(data);
		if (link !== this.link) {
			this.link = link;
			const conn = RelayCarrier.nextConn++;
			this.conn = conn;
			const deviceKey = randomBytes(32).toString("base64url");
			this.chain = this.control.call("grant", { conn, deviceKey }).then(() => this.control.call("relay_open", { conn })).then(() => undefined);
		}
		const conn = this.conn;
		this.chain = this.chain.then(() => this.control.relay(conn, frame));
		return true;
	}

	onFrame(listener: (body: Frame["body"]) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	snapshot = (): { readonly status: LinkStatus } => this;

	start(): void {
		if (this.status.kind !== "open") this.set({ kind: "open" });
	}

	stop(): void {
		this.drop();
		this.set({ kind: "idle" });
	}

	/** The connection drops: the agent closes the link's connection on the machine. */
	drop(): void {
		if (this.conn !== 0) void this.control.call("conn_close", { conn: this.conn }).catch(() => undefined);
		this.conn = 0;
		this.link = 0;
		this.set({ kind: "offline", attempt: 1 });
	}

	reopen(): void {
		this.set({ kind: "open" });
	}
}

/** What reached the screen, as bytes. */
class Screen implements TerminalSink {
	bytes: number[] = [];
	snapshots = 0;
	snapshot(): void {
		this.snapshots += 1;
	}
	output(data: Uint8Array, done: () => void): void {
		for (const b of data) this.bytes.push(b);
		setTimeout(done, 0);
	}
	exit(): void {}
	gone(): void {}
	get text(): string {
		return new TextDecoder().decode(new Uint8Array(this.bytes));
	}
}

async function until(check: () => boolean, what: string, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The numbers `seq` printed, in order, from a terminal's output. */
function numbers(text: string): number[] {
	return text
		.split(/\r?\n/)
		.filter((line) => /^\d+$/.test(line))
		.map(Number);
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe.skipIf(BIN === undefined || BIN === "")("the terminal link against the real terminal process (relay path)", () => {
	let home: string;
	let daemon: ChildProcess;
	let control: ControlClient;
	let socket: Socket;

	beforeAll(async () => {
		// Short: a Unix socket path must stay under 104 bytes on macOS.
		home = mkdtempSync(join(tmpdir(), "wt-"));
		daemon = spawn(BIN ?? "", [], { env: { ...process.env, TUNELO_HOME: home, TUNELO_TERM_STUN: "" }, stdio: "ignore" });
		const controlFile = join(home, "term-host", "control.json");
		await until(() => existsSync(controlFile), "control.json", 10_000);
		const info = JSON.parse(readFileSync(controlFile, "utf8")) as { socket: string; token: string };
		socket = createConnection(info.socket);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", () => resolve());
			socket.once("error", reject);
		});
		control = new ControlClient(socket);
		await control.call("hello", { major: 1, minor: 1, token: info.token, agentVersion: "web-test" });
		await control.call("set_revoked", { deviceKeys: [] });
	}, 20_000);

	afterAll(async () => {
		await control?.call("shutdown").catch(() => undefined);
		socket?.destroy();
		if (daemon !== undefined && daemon.exitCode === null) {
			await Promise.race([new Promise((r) => daemon.once("exit", r)), new Promise((r) => setTimeout(r, 5_000))]);
			if (daemon.exitCode === null) daemon.kill("SIGKILL");
		}
		if (home !== undefined) rmSync(home, { recursive: true, force: true });
	});

	const open = async (args?: string[]): Promise<number> => {
		const result = await control.call("open", { cols: 100, rows: 30, shell: "/bin/sh", ...(args === undefined ? {} : { args }) });
		return Number(result.session);
	};

	it("shows a real shell: snapshot, then the output of a typed command", async () => {
		const carrier = new RelayCarrier(control);
		const link = new TerminalLink({ carrier, peers: null, iceServers: [] });
		link.start();
		const session = await open();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1, "snapshot");
		link.input(session, new TextEncoder().encode("echo hi_$((6*7))\r"));
		await until(() => screen.text.includes("hi_42"), "hi_42");
		expect(link.status()).toMatchObject({ kind: "open", path: "relay" });
		expect(carrier.fromMachine.filter((f) => f === null || f.type === "error")).toEqual([]);
		link.stop();
		await control.call("close", { session });
	}, 30_000);

	it("streams a large output to the end: acknowledgements keep the window moving", async () => {
		const carrier = new RelayCarrier(control);
		const link = new TerminalLink({ carrier, peers: null, iceServers: [] });
		link.start();
		const session = await open(["-c", "sleep 0.3; seq 1 200000; printf END_MARK; sleep 30"]);
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.text.includes("END_MARK"), "the end of the output", 60_000);
		expect(numbers(screen.text)).toEqual(range(200_000));
		expect(screen.bytes.length).toBeGreaterThan(1024 * 1024);
		expect(carrier.fromMachine.filter((f) => f === null || f.type === "error")).toEqual([]);
		link.stop();
		await control.call("close", { session });
	}, 90_000);

	it("continues byte for byte on a new link after the connection drops", async () => {
		const carrier = new RelayCarrier(control);
		const link = new TerminalLink({ carrier, peers: null, iceServers: [] });
		link.start();
		const session = await open(["-c", "sleep 0.3; seq 1 30000; sleep 1; seq 30001 40000; printf END_MARK; sleep 30"]);
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.bytes.length > 20_000, "some output");
		carrier.drop();
		await new Promise((r) => setTimeout(r, 600));
		carrier.reopen();
		await until(() => screen.text.includes("END_MARK"), "the end of the output", 60_000);
		expect(screen.snapshots).toBe(1);
		expect(numbers(screen.text)).toEqual(range(40_000));
		expect(carrier.fromMachine.filter((f) => f === null || f.type === "error")).toEqual([]);
		link.stop();
		await control.call("close", { session });
	}, 90_000);
});

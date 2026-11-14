// The terminal link against a fake machine (agent and terminal process, see
// fake-terminal.ts) over the real end-to-end connection code, with fake
// WebRTC peers: output applied by offset, acknowledgements once written,
// the 5 s wait for the direct path, falling back and coming back without a
// byte lost or shown twice, keystroke order across the switch, refusals and
// revocation, and a new link after the connection drops that keeps the screen.
import { generateKeyPair } from "@achoo254/chat-remote-protocol";
import { TermSignalKind } from "@achoo254/chat-proto/remote/remote";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import { ACK_MS, DIRECT_WAIT_MS, TerminalLink, type TerminalSink, type TerminalStatus } from "../../src/terminal/terminal-link.ts";
import { defaultAnswer, FakeMachine, until } from "./fake-machine.ts";
import { FakePeers, FakeTerminalHost, serverFrames } from "./fake-terminal.ts";

const URL_A = "wss://abc.tunnel.hoandat.com";
const dec = new TextDecoder();

/** Timers the test moves by hand; `now` is their clock. */
class ManualTimers implements Timers {
	private time = 1_000_000;
	private next = 1;
	private readonly due = new Map<number, { at: number; fn: () => void; every: number }>();

	now(): number {
		return this.time;
	}
	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.next++;
		this.due.set(id, { at: this.time + ms, fn, every: 0 });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.due.delete(handle as number);
	}
	setInterval(fn: () => void, ms: number): unknown {
		const id = this.next++;
		this.due.set(id, { at: this.time + ms, fn, every: ms });
		return id;
	}
	clearInterval(handle: unknown): void {
		this.due.delete(handle as number);
	}
	/** Runs what falls due within `ms`, in time order. */
	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			let first: [number, { at: number; fn: () => void; every: number }] | null = null;
			for (const entry of this.due) if (entry[1].at <= end && (first === null || entry[1].at < first[1].at)) first = entry;
			if (first === null) break;
			const [id, timer] = first;
			this.time = timer.at;
			if (timer.every > 0) timer.at += timer.every;
			else this.due.delete(id);
			timer.fn();
		}
		this.time = end;
	}
}

/** A screen that keeps the text it was given; `hold` keeps writes unfinished until finish(). */
class Screen implements TerminalSink {
	text = "";
	snapshots = 0;
	exits: number[] = [];
	isGone = false;
	hold = false;
	private unfinished: (() => void)[] = [];

	snapshot(s: { vt: Uint8Array }): void {
		this.snapshots += 1;
		this.text = dec.decode(s.vt).replace("\x1bc", "");
	}
	output(data: Uint8Array, done: () => void): void {
		this.text += dec.decode(data);
		if (this.hold) this.unfinished.push(done);
		else done();
	}
	exit(code: number): void {
		this.exits.push(code);
	}
	gone(): void {
		this.isGone = true;
	}
	finish(): void {
		for (const done of this.unfinished.splice(0)) done();
	}
}

let machine: FakeMachine;
let host: FakeTerminalHost;
let peers: FakePeers;
let timers: ManualTimers;
let carrier: MachineLink;
let link: TerminalLink;

async function setup(options: { direct: boolean }): Promise<void> {
	machine = await FakeMachine.create();
	const device = await generateKeyPair();
	machine.trusted = [device.publicKey];
	peers = new FakePeers();
	host = new FakeTerminalHost(machine, peers);
	machine.handler = (frame, socket) => host.handle(frame, socket) ?? defaultAnswer(frame);
	carrier = new MachineLink({
		device: () => Promise.resolve(device),
		expectedKey: () => machine.keys.publicKey,
		tunnelUrl: () => URL_A,
		refreshTunnel: () => Promise.resolve(URL_A),
		socket: machine.factory,
		random: () => 0,
		purpose: "terminal",
	});
	timers = new ManualTimers();
	let draw = 0;
	link = new TerminalLink({ carrier, peers: options.direct ? peers.factory : null, iceServers: [], timers, clock: () => timers.now(), random: () => (draw++ * 0.37) % 1 });
}

afterEach(() => {
	link.stop();
});

const status = (): TerminalStatus => link.status();
const path = (): string => {
	const s = status();
	return s.kind === "open" ? s.path : s.kind;
};
const sentOn = (type: string, where: "direct" | "relay") => host.frames.filter((f) => f.frame.type === type && f.path === where);
const type = (session: number, text: string) => link.input(session, new TextEncoder().encode(text));

describe("the relay path", () => {
	beforeEach(() => setup({ direct: false }));

	it("says Hello, shows the screen from a snapshot, then live output and echoed keys", async () => {
		const session = host.open();
		host.print(session, "$ ");
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1 && screen.text === "$ ", "snapshot");
		expect(path()).toBe("relay");
		expect(host.frames[0]?.frame.type).toBe("hello");
		expect(machine.sent("termSignal")).toEqual([]);
		// The terminal's own connection asks nothing of the chat.
		expect(machine.sent("threadList")).toEqual([]);
		type(session, "ls\r");
		await until(() => screen.text === "$ ls\r", "echo");
		expect(host.keystrokes).toEqual([{ session, text: "ls\r", path: "relay" }]);
	});

	it("sends a claimed size again although unchanged, and a size that differs from the snapshot's", async () => {
		// Another device left the session at 90 × 20; this page's pane is 200 × 50.
		const session = host.open(90, 20);
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1, "snapshot");
		link.resize(session, 90, 20);
		link.resize(session, 200, 50);
		await until(() => host.resizes.length === 1, "the pane's own size");
		expect(host.resizes).toEqual([{ session, cols: 200, rows: 50 }]);
		// The machine took another device's size since: a plain resize of the same size stays quiet, a claim is sent.
		link.resize(session, 200, 50);
		link.resize(session, 200, 50, true);
		await until(() => host.resizes.length === 2, "the claim");
		expect(host.resizes[1]).toEqual({ session, cols: 200, rows: 50 });
	});

	it("applies output by offset: a gap is dropped and asked again, duplicates are cut", async () => {
		const session = host.open();
		host.print(session, "abc");
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.text === "abc", "snapshot");
		const linkId = machine.sent("termData")[0]?.link ?? 0;
		const raw = (frame: Uint8Array) => machine.send(machine.socket, { case: "termData", value: { link: linkId, data: frame } });
		const attaches = () => sentOn("attach", "relay").length;
		const before = attaches();
		// Offset 5 while 3 bytes are applied: a gap.
		raw(serverFrames.output(session, 5, new TextEncoder().encode("FG")));
		timers.advance(300);
		await until(() => attaches() === before + 1, "attach again");
		expect(host.frames.filter((f) => f.frame.type === "attach").at(-1)?.frame).toEqual({ type: "attach", session, lastOffset: 3 });
		// Bytes 1..4: "bc" again, then "d" is new.
		raw(serverFrames.output(session, 1, new TextEncoder().encode("bcd")));
		raw(serverFrames.output(session, 0, new TextEncoder().encode("abcd")));
		raw(serverFrames.output(session, 4, new TextEncoder().encode("e")));
		await until(() => screen.text === "abcde", "in order");
		expect(screen.text).toBe("abcde");
	});

	it("acknowledges once written: 16 KiB at once, smaller output 50 ms after the first byte", async () => {
		const session = host.open();
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1, "snapshot");
		screen.hold = true;
		host.print(session, "x".repeat(10));
		await until(() => screen.text.length === 10, "output");
		timers.advance(ACK_MS * 2);
		await new Promise((r) => setTimeout(r, 10));
		expect(host.acks).toEqual([]);
		screen.finish();
		timers.advance(ACK_MS - 1);
		await new Promise((r) => setTimeout(r, 10));
		expect(host.acks).toEqual([]);
		timers.advance(1);
		await until(() => host.acks.length === 1, "timed ack");
		expect(host.acks[0]).toEqual({ session, offset: 10, path: "relay" });
		screen.hold = false;
		host.print(session, "y".repeat(16 * 1024));
		await until(() => host.acks.length === 2, "threshold ack");
		expect(host.acks[1]?.offset).toBe(10 + 16 * 1024);
	});

	it("starts a new link after the connection drops and keeps the screen: the machine replays what was missed", async () => {
		const session = host.open();
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1, "snapshot");
		host.print(session, "one ");
		await until(() => screen.text === "one ", "one");
		const firstLink = machine.sent("termData")[0]?.link;
		machine.socket.drop();
		await until(() => status().kind !== "open", "lost");
		host.print(session, "two ");
		await until(() => screen.text === "one two ", "replayed");
		host.print(session, "three");
		await until(() => screen.text === "one two three", "live");
		expect(screen.snapshots).toBe(1);
		expect(host.frames.filter((f) => f.frame.type === "attach").map((f) => f.frame)).toEqual([
			{ type: "attach", session, lastOffset: 0 },
			{ type: "attach", session, lastOffset: 4 },
		]);
		expect(machine.sent("termData").at(-1)?.link).not.toBe(firstLink);
		expect(path()).toBe("relay");
	});

	it("shows the session's end and a session that is gone", async () => {
		const session = host.open();
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1, "snapshot");
		host.exit(session, 3);
		await until(() => screen.exits.length === 1, "exit");
		expect(screen.exits).toEqual([3]);
		const other = new Screen();
		link.attach(99, other);
		await until(() => other.isGone, "gone");
	});

	it("is refused when the machine does not grant this device, and stops when it is revoked", async () => {
		host.refuse = true;
		link.start();
		link.attach(host.open(), new Screen());
		await until(() => status().kind === "failed", "refused");
		expect(status()).toEqual({ kind: "failed", reason: "revoked" });
	});

	it("stops at once on Error 6 (revoked) while open", async () => {
		const session = host.open();
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1, "snapshot");
		host.broadcast(serverFrames.error(0, 6, "revoked"));
		await until(() => status().kind === "failed", "revoked");
		expect(status()).toEqual({ kind: "failed", reason: "revoked" });
		type(session, "x");
		await new Promise((r) => setTimeout(r, 20));
		expect(host.keystrokes).toEqual([]);
	});
});

describe("the direct path", () => {
	beforeEach(() => setup({ direct: true }));

	async function openDirect(session: number, screen: Screen): Promise<void> {
		link.start();
		link.attach(session, screen);
		await until(() => peers.made.length === 1 && peers.last.remoteSdp !== "", "answer");
		host.connectDirect(peers.last);
		await until(() => screen.snapshots === 1, "snapshot");
	}

	it("offers both channels, sends its candidates after the offer, opens direct and keeps the relay ready", async () => {
		const session = host.open();
		const screen = new Screen();
		await openDirect(session, screen);
		expect(path()).toBe("direct");
		expect(peers.last.channels.map((c) => c.label)).toEqual(["term-in", "term-out"]);
		const signals = machine.sent("termSignal");
		expect(signals[0]?.kind).toBe(TermSignalKind.OFFER);
		expect(signals[1]).toMatchObject({ kind: TermSignalKind.CANDIDATE });
		expect(peers.last.remoteCandidates).toEqual(["candidate:2 1 udp 1686052607 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0"]);
		expect(host.frames[0]).toMatchObject({ frame: { type: "hello" }, path: "direct" });
		// The relay of the link opens behind the direct path (a Ping), so a drop does not end the link.
		await until(() => sentOn("ping", "relay").length === 1, "relay ready");
		type(session, "pwd\r");
		await until(() => screen.text === "pwd\r", "echo");
		expect(host.keystrokes).toEqual([{ session, text: "pwd\r", path: "direct" }]);
	});

	it("shows the round trip, and a second DIRECT does not attach again", async () => {
		const session = host.open();
		await openDirect(session, new Screen());
		const attaches = host.frames.filter((f) => f.frame.type === "attach").length;
		host.directRtt(peers.last, 12.4);
		await until(() => status().kind === "open" && (status() as { rttMs: number | null }).rttMs === 12, "rtt");
		expect(status()).toEqual({ kind: "open", path: "direct", rttMs: 12, directIssue: "" });
		expect(host.frames.filter((f) => f.frame.type === "attach").length).toBe(attaches);
	});

	it("waits 5 s for the direct path, then uses the relay and tells the machine to drop the peer", async () => {
		const session = host.open();
		const screen = new Screen();
		link.start();
		link.attach(session, screen);
		await until(() => peers.made.length === 1, "offer");
		timers.advance(DIRECT_WAIT_MS - 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(status().kind).toBe("connecting");
		expect(host.frames).toEqual([]);
		timers.advance(1);
		await until(() => screen.snapshots === 1, "snapshot on the relay");
		expect(status()).toMatchObject({ kind: "open", path: "relay", directIssue: "timeout" });
		await until(() => machine.sent("termSignal").some((s) => s.kind === TermSignalKind.END), "end");
		expect(peers.last.closed).toBe(true);
	});

	it("after the connection drops, shows the screen on the relay at once and goes direct when the new path opens", async () => {
		const session = host.open();
		const screen = new Screen();
		await openDirect(session, screen);
		host.print(session, "one ");
		await until(() => screen.text === "one ", "one");
		// The app back from the background: the connection had died. No 5 s wait for the direct path this time.
		machine.socket.drop();
		await until(() => status().kind !== "open", "lost");
		host.print(session, "two ");
		await until(() => screen.text === "one two ", "replayed on the relay");
		expect(path()).toBe("relay");
		await until(() => peers.made.length === 2 && peers.last.remoteSdp !== "", "a new offer");
		host.connectDirect(peers.last);
		await until(() => path() === "direct", "direct again");
		host.print(session, "three");
		await until(() => screen.text === "one two three", "live");
		expect(screen.snapshots).toBe(1);
	});

	it("uses the relay at once when the machine ends the peer (DTLS fingerprint mismatch)", async () => {
		host.endOffersWith = "dtls_failed";
		const session = host.open();
		const screen = new Screen();
		link.start();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1, "snapshot");
		expect(status()).toMatchObject({ kind: "open", path: "relay", directIssue: "dtls_failed" });
	});

	it("does not trust an answer without a DTLS fingerprint", async () => {
		const session = host.open();
		host.silentOffers = true;
		link.start();
		link.attach(session, new Screen());
		await until(() => machine.sent("termSignal").length > 0, "offer");
		const linkId = machine.sent("termSignal")[0]?.link ?? 0;
		// An answer with no fingerprint to pin.
		machine.send(machine.socket, { case: "termSignal", value: { link: linkId, kind: TermSignalKind.ANSWER, sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" } });
		await until(() => status().kind === "open", "relay");
		expect(status()).toMatchObject({ path: "relay", directIssue: "no_fingerprint" });
	});

	it("goes direct → relay → direct without losing or repeating a byte", async () => {
		const session = host.open();
		host.print(session, "start;");
		const screen = new Screen();
		await openDirect(session, screen);
		await until(() => sentOn("ping", "relay").length === 1, "relay ready");
		let n = 0;
		const burst = (count: number) => {
			for (let i = 0; i < count; i++) host.print(session, `${n++};`);
		};
		burst(50);
		// The direct path dies with output in flight on it.
		burst(5);
		host.dropDirect(peers.last);
		burst(50);
		await until(() => path() === "relay", "relay");
		burst(50);
		// Back to direct on the next attempt (15 s later).
		timers.advance(15_000);
		await until(() => peers.made.length === 2 && peers.last.remoteSdp !== "", "second offer answered");
		burst(20);
		host.connectDirect(peers.last);
		burst(20);
		await until(() => path() === "direct", "direct again");
		burst(50);
		await until(() => screen.text === host.text(session), "same bytes");
		expect(screen.text).toBe(host.text(session));
		expect(screen.snapshots).toBe(1);
	});

	it("keeps keystrokes in order from a live relay to the direct path (Ping/Pong barrier)", async () => {
		const session = host.open();
		const screen = new Screen();
		link.start();
		link.attach(session, screen);
		await until(() => peers.made.length === 1, "offer");
		timers.advance(DIRECT_WAIT_MS);
		await until(() => screen.snapshots === 1, "on the relay");
		// The relay becomes slow: frames wait at the machine.
		host.holdRelay = true;
		type(session, "a");
		type(session, "b");
		timers.advance(15_000);
		await until(() => peers.made.length === 2 && peers.last.remoteSdp !== "", "second offer");
		host.connectDirect(peers.last);
		// Typed while the barrier waits: held, not sent direct.
		type(session, "c");
		await new Promise((r) => setTimeout(r, 20));
		expect(host.keystrokes).toEqual([]);
		expect(sentOn("input", "direct")).toEqual([]);
		expect(path()).toBe("relay");
		host.holdRelay = false;
		host.releaseRelay();
		await until(() => host.keystrokes.length === 3, "all keys");
		expect(host.keystrokes.map((k) => `${k.text}:${k.path}`)).toEqual(["a:relay", "b:relay", "c:direct"]);
		expect(path()).toBe("direct");
		await until(() => screen.text === "abc", "echo");
	});

	it("is refused when the machine does not grant this device", async () => {
		host.refuse = true;
		link.start();
		link.attach(host.open(), new Screen());
		await until(() => status().kind === "failed", "refused");
		expect(status()).toEqual({ kind: "failed", reason: "refused" });
	});
});

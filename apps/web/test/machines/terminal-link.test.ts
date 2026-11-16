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
import { BUSY_RETRY_MS, HISTORY_TIMEOUT_MS, type HistoryReply } from "../../src/terminal/terminal-history-requests.ts";
import { ACK_MS, DIRECT_WAIT_MS, TerminalLink, type LiveScreen, type TerminalSink, type TerminalStatus } from "../../src/terminal/terminal-link.ts";
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
	lives: LiveScreen[] = [];
	previews: string[] = [];
	caughtUps = 0;
	exits: number[] = [];
	isGone = false;
	hold = false;
	private unfinished: (() => void)[] = [];

	snapshot(s: { vt: Uint8Array }): void {
		this.snapshots += 1;
		this.text = dec.decode(s.vt).replace("\x1bc", "");
	}
	liveSnapshot(live: LiveScreen): void {
		this.lives.push(live);
		this.text = dec.decode(live.vt).replace("\x1bc", "");
	}
	preview(p: { vt: Uint8Array }): void {
		this.previews.push(dec.decode(p.vt).replace("c", ""));
	}
	caughtUp(): void {
		this.caughtUps += 1;
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

	it("asks a machine that renders previews for one before a fresh replay, and says when the replay caught up", async () => {
		host.previews = true;
		const session = host.open();
		host.print(session, "old lines, newest line");
		link.start();
		const screen = new Screen();
		screen.hold = true;
		link.attach(session, screen);
		await until(() => screen.previews.length === 1, "preview");
		expect(screen.previews[0]).toContain("newest line");
		expect(host.frames.map((f) => f.frame.type).filter((t) => t === "preview" || t === "attach")).toEqual(["preview", "attach"]);
		// The replay is in the screen's hands but not written yet: not caught up.
		await until(() => screen.snapshots === 1, "replay");
		expect(screen.caughtUps).toBe(0);
		screen.finish();
		host.print(session, "!");
		await until(() => screen.caughtUps === 1, "caught up");
		screen.finish();
		// A link that comes back resumes from its offset: no preview then.
		machine.socket.drop();
		await until(() => host.frames.filter((f) => f.frame.type === "attach").length === 2, "attach again");
		expect(host.frames.filter((f) => f.frame.type === "preview")).toHaveLength(1);
		expect(screen.previews).toHaveLength(1);
	});

	it("shows the replay as before when the machine ignores Preview (tunelo before 3.5.0)", async () => {
		const session = host.open();
		host.print(session, "$ ");
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		await until(() => screen.snapshots === 1 && screen.text.endsWith("$ "), "snapshot");
		expect(host.frames.some((f) => f.frame.type === "preview")).toBe(true);
		expect(screen.previews).toEqual([]);
		expect(screen.caughtUps).toBe(0);
		expect(status().kind).toBe("open");
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

describe("a machine that opens a session at its screen as it is now (CAP_LIVE_HISTORY)", () => {
	beforeEach(async () => {
		await setup({ direct: false });
		host.liveHistory = true;
	});

	const linkId = () => machine.sent("termData").at(-1)?.link ?? 0;
	const raw = (frame: Uint8Array) => machine.send(machine.socket, { case: "termData", value: { link: linkId(), data: frame } });
	const rowsOf = (reply: HistoryReply) => (reply.kind === "rows" ? dec.decode(reply.vt).split("\x1b[m\r\n").slice(0, -1) : []);
	const historyAsked = () => host.frames.filter((f) => f.frame.type === "historyRequest").map((f) => f.frame);

	/** The screen of the pane that asks for history. */
	let shown = new Screen();
	/** Asks for history as the pane does: for the screen it shows. */
	const ask = (session: number, beforeRow: number, maxRows: number) => {
		const life = shown.lives.at(-1);
		return link.history(session, { epoch: life?.epoch ?? 0, historyEnd: life?.historyEnd ?? 0 }, beforeRow, maxRows);
	};

	async function open(rows = 1_200): Promise<{ session: number; screen: Screen }> {
		const session = host.open();
		host.withHistory(session, rows);
		host.print(session, "$ ");
		link.start();
		const screen = new Screen();
		shown = screen;
		link.attach(session, screen);
		await until(() => screen.lives.length === 1, "live snapshot");
		return { session, screen };
	}

	it("says it takes live snapshots, gets one instead of a replay and a preview, and keys go at once", async () => {
		const { session, screen } = await open();
		expect(host.frames[0]?.frame).toEqual({ type: "hello", version: 1, caps: 1 });
		expect(screen.lives[0]).toMatchObject({ cols: 80, rows: 24, epoch: 1, historyEnd: 1_200 });
		expect(screen.text).toBe("$ ");
		expect(screen.previews).toEqual([]);
		expect(screen.snapshots).toBe(0);
		type(session, "ls\r");
		await until(() => screen.text === "$ ls\r", "echo");
		expect(host.keystrokes).toEqual([{ session, text: "ls\r", path: "relay" }]);
		// Output written is acknowledged by offset, as before.
		timers.advance(ACK_MS);
		await until(() => host.acks.length === 1, "ack");
		expect(host.acks[0]?.offset).toBe(host.text(session).length);
	});

	it("sends the pane's size only after the screen came, and only when it differs from the session's", async () => {
		const session = host.open(80, 24);
		link.start();
		const screen = new Screen();
		link.attach(session, screen);
		// The pane fits before the machine answered: the same size as the session's.
		link.resize(session, 80, 24);
		link.resize(session, 80, 24, true);
		await until(() => screen.lives.length === 1, "live snapshot");
		await new Promise((r) => setTimeout(r, 20));
		expect(host.resizes).toEqual([]);
		// Another pane, another size: it goes once the screen came.
		const other = host.open(80, 24);
		const second = new Screen();
		link.attach(other, second);
		link.resize(other, 120, 40);
		await until(() => host.resizes.length === 1, "the pane's size");
		expect(host.resizes).toEqual([{ session: other, cols: 120, rows: 40 }]);
		expect(host.frames.findIndex((f) => f.frame.type === "resize")).toBeGreaterThan(host.frames.findIndex((f) => f.frame.type === "attach" && f.frame.session === other));
	});

	it("takes a live snapshot in parts, and one that comes before the machine's Hello", async () => {
		const session = host.open();
		link.start();
		const screen = new Screen();
		// The machine reads nothing yet: its frames below come before its Hello.
		host.holdRelay = true;
		link.attach(session, screen);
		await until(() => linkId() !== 0, "link");
		const vt = new TextEncoder().encode("\x1bcthe screen now");
		const at = { offset: 100, cols: 90, rows: 30, epoch: 4, historyEnd: 77, tailRows: 0, parts: 3 };
		raw(serverFrames.liveSnapshot(session, { ...at, part: 0 }, vt.subarray(0, 5)));
		raw(serverFrames.liveSnapshot(session, { ...at, part: 1 }, vt.subarray(5, 10)));
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.lives).toEqual([]);
		raw(serverFrames.liveSnapshot(session, { ...at, part: 2 }, vt.subarray(10)));
		raw(serverFrames.output(session, 100, new TextEncoder().encode("!")));
		await until(() => screen.text === "the screen now!", "screen then output");
		expect(screen.lives[0]).toMatchObject({ cols: 90, rows: 30, epoch: 4, historyEnd: 77 });
		// A part missing: the screen does not start from a piece of it.
		raw(serverFrames.liveSnapshot(session, { ...at, offset: 200, part: 0 }, vt.subarray(0, 5)));
		raw(serverFrames.liveSnapshot(session, { ...at, offset: 200, part: 2 }, vt.subarray(10)));
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.lives).toHaveLength(1);
		host.holdRelay = false;
		host.releaseRelay();
		await until(() => status().kind === "open", "open");
	});

	it("still replays a session whose full-screen program shows, after its preview", async () => {
		host.previews = true;
		const session = host.open();
		const s = host.sessions.get(session);
		if (s !== undefined) s.altScreen = true;
		host.print(session, "vim");
		link.start();
		const screen = new Screen();
		shown = screen;
		link.attach(session, screen);
		await until(() => screen.previews.length === 1 && screen.snapshots === 1 && screen.text === "vim", "preview and replay");
		expect(screen.lives).toEqual([]);
		// Its history is all in the screen: none to ask for.
		expect(await ask(session, 10, 10)).toEqual({ kind: "failed", reason: "unavailable" });
	});

	it("brings pages of history older and older, in parts, down to the first row", async () => {
		host.historyParts = 3;
		const { session } = await open(1_200);
		const first = await ask(session, 1_200, 500);
		expect(first).toMatchObject({ kind: "rows", epoch: 1, firstRow: 700, rowCount: 500, atStart: false });
		expect(rowsOf(first)[0]).toBe("row 700");
		expect(rowsOf(first).at(-1)).toBe("row 1199");
		const second = await ask(session, 700, 500);
		expect(second).toMatchObject({ firstRow: 200, rowCount: 500, atStart: false });
		const last = await ask(session, 200, 500);
		expect(last).toMatchObject({ firstRow: 0, rowCount: 200, atStart: true });
		expect(historyAsked().map((f) => (f.type === "historyRequest" ? f.reqId : 0))).toEqual([1, 2, 3]);
	});

	it("says when the program cleared the history since, and when the machine has none to give", async () => {
		const { session } = await open(50);
		const s = host.sessions.get(session);
		if (s !== undefined) s.epoch = 2;
		expect(await ask(session, 50, 50)).toMatchObject({ kind: "rows", epoch: 2, rowCount: 0, atStart: true });
		host.historyFailWith = 1;
		expect(await ask(session, 50, 50)).toEqual({ kind: "failed", reason: "unavailable" });
		// Still busy after every wait: then it fails.
		host.historyFailWith = 2;
		const busy = ask(session, 50, 50);
		for (const wait of BUSY_RETRY_MS) {
			await new Promise((r) => setTimeout(r, 20));
			timers.advance(wait);
		}
		expect(await busy).toEqual({ kind: "failed", reason: "busy" });
		expect(historyAsked().length).toBe(3 + BUSY_RETRY_MS.length);
	});

	it("gives up on a page after 10 s and drops its late answer; the next one is answered", async () => {
		const { session } = await open(100);
		host.historyHold = true;
		const late = ask(session, 100, 10);
		await until(() => historyAsked().length === 1, "asked");
		timers.advance(HISTORY_TIMEOUT_MS - 1);
		let settled = false;
		void late.then(() => (settled = true));
		await new Promise((r) => setTimeout(r, 10));
		expect(settled).toBe(false);
		timers.advance(1);
		expect(await late).toEqual({ kind: "failed", reason: "timeout" });
		// The machine answers the old one at last: nobody waits for it any more.
		host.historyHold = false;
		host.answerHistory();
		await new Promise((r) => setTimeout(r, 20));
		expect(await ask(session, 90, 10)).toMatchObject({ kind: "rows", firstRow: 80, rowCount: 10 });
	});

	it("drops the answer to a page asked before the screen started over", async () => {
		const { session, screen } = await open(100);
		host.historyHold = true;
		const asked = ask(session, 100, 10);
		await until(() => historyAsked().length === 1, "asked");
		// The machine lost its ring: the screen starts over, the history life with it.
		const at = { offset: host.text(session).length, cols: 80, rows: 24, epoch: 1, historyEnd: 100, tailRows: 0, part: 0, parts: 1 };
		raw(serverFrames.liveSnapshot(session, at, new TextEncoder().encode("\x1bcagain")));
		expect(await asked).toEqual({ kind: "dropped" });
		expect(screen.lives).toHaveLength(2);
		host.historyHold = false;
		host.answerHistory();
		await new Promise((r) => setTimeout(r, 20));
		// Asked again, the page comes.
		expect(await ask(session, 100, 10)).toMatchObject({ kind: "rows", firstRow: 90 });
	});

	it("asks for the page in flight again after a change of path, with the same id, and takes it whole", async () => {
		const { session, screen } = await open(100);
		host.historyHold = true;
		const asked = ask(session, 100, 10);
		await until(() => historyAsked().length === 1, "asked");
		const reqId = historyAsked()[0]?.type === "historyRequest" ? (historyAsked()[0] as { reqId: number }).reqId : -1;
		// Half a page came, then the connection dropped.
		const page = { reqId, epoch: 1, firstRow: 90, rowCount: 10, parts: 2, atStart: false };
		raw(serverFrames.history(session, { ...page, part: 0 }, new TextEncoder().encode("A")));
		machine.socket.drop();
		await until(() => historyAsked().length === 2, "asked again on the new link");
		expect(historyAsked()[1]).toMatchObject({ type: "historyRequest", reqId, beforeRow: 100, maxRows: 10 });
		// Asked after its Attach, which resumes from the offset applied.
		const types = host.frames.map((f) => f.frame.type);
		expect(types.lastIndexOf("historyRequest")).toBeGreaterThan(types.lastIndexOf("attach"));
		expect(host.frames.filter((f) => f.frame.type === "attach").at(-1)?.frame).toMatchObject({ lastOffset: host.text(session).length });
		raw(serverFrames.history(session, { ...page, part: 0 }, new TextEncoder().encode("A")));
		raw(serverFrames.history(session, { ...page, part: 1 }, new TextEncoder().encode("B")));
		const reply = await asked;
		expect(reply.kind === "rows" && dec.decode(reply.vt)).toBe("AB");
		expect(screen.lives).toHaveLength(1);
	});

	it("takes a page that the machine replaced halfway, because the history life changed, as an empty page of the new life", async () => {
		const { session } = await open(100);
		host.historyHold = true;
		const asked = ask(session, 100, 10);
		await until(() => historyAsked().length === 1, "asked");
		const reqId = (historyAsked()[0] as { reqId: number }).reqId;
		raw(serverFrames.history(session, { reqId, epoch: 1, firstRow: 90, rowCount: 10, part: 0, parts: 3, atStart: false }, new TextEncoder().encode("A")));
		// The program cleared the history while the page was on its way: the rest is one empty frame of the new life.
		raw(serverFrames.history(session, { reqId, epoch: 2, firstRow: 0, rowCount: 0, part: 0, parts: 1, atStart: true }, new Uint8Array()));
		const reply = await asked;
		expect(reply).toMatchObject({ kind: "rows", epoch: 2, rowCount: 0, atStart: true });
		expect(reply.kind === "rows" && reply.vt.length).toBe(0);
	});

	it("takes a page whose parts come twice and out of order across a change of path", async () => {
		const { session } = await open(100);
		host.historyHold = true;
		const asked = ask(session, 100, 10);
		await until(() => historyAsked().length === 1, "asked");
		const reqId = (historyAsked()[0] as { reqId: number }).reqId;
		const page = { reqId, epoch: 1, firstRow: 90, rowCount: 10, parts: 4, atStart: false };
		const part = (n: number) => raw(serverFrames.history(session, { ...page, part: n }, new TextEncoder().encode(String(n))));
		// The page again from its first part on the new path, a late part of the old one in between.
		part(0);
		part(2);
		part(1);
		part(0);
		part(2);
		part(3);
		const reply = await asked;
		expect(reply.kind === "rows" && dec.decode(reply.vt)).toBe("0123");
	});

	it("takes a live snapshot whose parts come twice across a change of path", async () => {
		const session = host.open();
		link.start();
		const screen = new Screen();
		host.holdRelay = true;
		link.attach(session, screen);
		await until(() => linkId() !== 0, "link");
		const at = { offset: 10, cols: 80, rows: 24, epoch: 1, historyEnd: 5, tailRows: 0, parts: 3 };
		const part = (n: number) => raw(serverFrames.liveSnapshot(session, { ...at, part: n }, new TextEncoder().encode(String(n))));
		part(0);
		part(2);
		part(1);
		part(0);
		part(1);
		part(2);
		await until(() => screen.lives.length === 1, "live snapshot");
		expect(screen.text).toBe("012");
	});

	it("asks a busy machine again a little later instead of failing", async () => {
		const { session } = await open(100);
		host.historyHold = true;
		const first = ask(session, 100, 10);
		await until(() => historyAsked().length === 1, "asked");
		timers.advance(HISTORY_TIMEOUT_MS);
		expect(await first).toEqual({ kind: "failed", reason: "timeout" });
		// The machine still builds the page given up on: the next one is refused as busy, and asked again.
		const next = ask(session, 100, 10);
		await until(() => historyAsked().length === 2, "asked");
		await new Promise((r) => setTimeout(r, 20));
		timers.advance(BUSY_RETRY_MS[0]);
		await until(() => historyAsked().length === 3, "asked again");
		host.historyHold = false;
		host.answerHistory();
		await new Promise((r) => setTimeout(r, 20));
		timers.advance(BUSY_RETRY_MS[1]);
		expect(await next).toMatchObject({ kind: "rows", firstRow: 90, rowCount: 10 });
	});

	it("does not answer a pane asking for rows of a screen no longer shown", async () => {
		const { session } = await open(100);
		expect(await link.history(session, { epoch: 1, historyEnd: 99 }, 99, 10)).toEqual({ kind: "dropped" });
		expect(await link.history(session, { epoch: 7, historyEnd: 100 }, 100, 10)).toEqual({ kind: "dropped" });
		expect(historyAsked()).toEqual([]);
	});

	it("drops what a pane asked once it leaves", async () => {
		const { session } = await open(100);
		host.historyHold = true;
		// A session not shown here: nothing to answer.
		expect(await ask(99, 100, 10)).toEqual({ kind: "dropped" });
		const mine = ask(session, 100, 10);
		link.attach(session, new Screen());
		expect(await mine).toEqual({ kind: "dropped" });
	});
});

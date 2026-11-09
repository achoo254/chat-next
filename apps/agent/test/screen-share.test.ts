import { readFileSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ErrorReason, type Frame, MachineInfoSchema, ScreenShareEnd } from "@achoo254/chat-proto/remote/remote";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { RemoteBrowser } from "../src/remote-browser/remote-browser.ts";
import { CHUNK_BYTES, ScreenShare, type ScreenShareProbe, beyondLoopback, firewallFrom, listenersIn } from "../src/screen-share/screen-share.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, tempDir } from "./harness.ts";
import { type DeviceLink, pairedDevice } from "./support/device-link.ts";
import { FakeChrome } from "./support/fake-chrome.ts";

async function until(check: () => boolean, ms = 2_000): Promise<void> {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
	throw new Error("timed out");
}

/** The system's VNC service on loopback: greets, records what clients send, and can send or close. */
class FakeVnc {
	server!: Server;
	port = 0;
	sockets: Socket[] = [];
	received: Buffer[] = [];
	closed = 0;
	async start(): Promise<void> {
		this.server = createServer((s) => {
			this.sockets.push(s);
			s.write("RFB 003.889\n");
			s.on("data", (d) => this.received.push(d));
			s.on("close", () => (this.closed += 1));
			// The bridge (or a probe) may reset the connection: Linux reports it as an error.
			s.on("error", () => undefined);
		});
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
		this.port = (this.server.address() as { port: number }).port;
	}
	get bytes(): string {
		return Buffer.concat(this.received).toString("latin1");
	}
	stop(): void {
		for (const s of this.sockets) s.destroy();
		this.server.close();
	}
}

const probe = (listening: string[], firewall = { on: false, blockAll: false }): ScreenShareProbe => ({ listening: async () => listening, firewall: async () => firewall });

let vnc: FakeVnc;
let dir: string;
let logs: string[];

beforeEach(async () => {
	vnc = new FakeVnc();
	await vnc.start();
	dir = tempDir("screen-");
	logs = [];
});
afterEach(() => vnc.stop());

function share(opts: { idleMs?: number; port?: number; probe?: ScreenShareProbe; supported?: boolean } = {}) {
	return new ScreenShare({ audit: new AuditLog(join(dir, "audit.jsonl")), log: (l) => logs.push(l), port: opts.port ?? vnc.port, supported: opts.supported ?? true, probe: opts.probe ?? probe(["127.0.0.1"]), ...(opts.idleMs ? { idleMs: opts.idleMs } : {}) });
}

async function device(s: ScreenShare, browser?: RemoteBrowser): Promise<DeviceLink> {
	const { core } = makeCore([fakeProvider()]);
	const link = await pairedDevice({
		core,
		config: new ConfigStore(dir),
		audit: new AuditLog(join(dir, "audit.jsonl")),
		screenShare: s,
		...(browser ? { browser, machineInfo: async () => create(MachineInfoSchema, { name: "mac" }) } : {}),
	});
	await link.request("ping", { case: "ping", value: {} });
	return link;
}

const of = (link: DeviceLink, kind: NonNullable<Frame["body"]["case"]>) => link.received.filter((f) => f.body.case === kind);

describe("whether Screen Sharing is on and reachable", () => {
	it("reads netstat and the firewall as macOS prints them", () => {
		const netstat = [
			"Active Internet connections (including servers)",
			"Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
			"tcp4       0      0  *.5900                 *.*                    LISTEN",
			"tcp6       0      0  *.5900                 *.*                    LISTEN",
			"tcp4       0      0  127.0.0.1.5901         *.*                    LISTEN",
			"tcp4       0      0  192.168.1.5.5900       10.0.0.2.51000         ESTABLISHED",
		].join("\n");
		expect(listenersIn(netstat, 5900)).toEqual(["*", "*"]);
		expect(beyondLoopback(["127.0.0.1", "::1"])).toBe(false);
		expect(beyondLoopback(["*"])).toBe(true);
		expect(firewallFrom("Firewall is disabled. (State = 0)", "Firewall has block all state set to disabled.")).toEqual({ on: false, blockAll: false });
		expect(firewallFrom("Firewall is enabled. (State = 1)", "Firewall has block all state set to enabled.")).toEqual({ on: true, blockAll: true });
	});

	it("says on, off and exposed; changes nothing", async () => {
		expect(await share({ probe: probe(["127.0.0.1"]) }).status()).toEqual({ supported: true, enabled: true, exposed: false, firewallOn: false });
		expect(await share({ probe: probe(["*"]) }).status()).toMatchObject({ enabled: true, exposed: true });
		expect(await share({ probe: probe(["*"], { on: true, blockAll: false }) }).status()).toMatchObject({ exposed: true, firewallOn: true });
		expect(await share({ probe: probe(["*"], { on: true, blockAll: true }) }).status()).toMatchObject({ exposed: false, firewallOn: true });
		vnc.stop();
		expect(await share({ probe: probe(["*"]) }).status()).toMatchObject({ enabled: false, exposed: false });
		expect(await share({ supported: false }).status()).toEqual({ supported: false, enabled: false, exposed: false, firewallOn: false });
	});
});

describe("the bridge", () => {
	it("opens only when asked, relays bytes both ways in order, and logs none of them", async () => {
		const s = share();
		const link = await device(s);
		const status = await link.request("s", { case: "screenShareStatusRequest", value: {} });
		expect(status.body.case === "screenShareStatus" && status.body.value.enabled).toBe(true);
		await new Promise((r) => setTimeout(r, 50));
		// The status only read the greeting: no session, nothing sent to the service.
		expect(vnc.received).toHaveLength(0);
		expect(vnc.sockets.every((x) => x.destroyed)).toBe(true);

		const opened = await link.request("o", { case: "screenShareOpen", value: {} });
		if (opened.body.case !== "screenShareOpened") throw new Error("not opened");
		const streamId = opened.body.value.streamId;
		expect(opened.body.value.idleMs).toBe(600_000);
		// The service's greeting reaches the device.
		await until(() => of(link, "screenShareData").length >= 1);

		const SECRET = "mac-account-password-123";
		expect((await link.request("d1", { case: "screenShareData", value: { streamId, data: new TextEncoder().encode(`RFB 003.889\n${SECRET}`) } })).body.case).toBe("ack");
		await until(() => vnc.bytes.includes(SECRET));

		// A large update from the service arrives whole, in pieces of at most 256 KiB.
		const big = Buffer.alloc(CHUNK_BYTES * 2 + 1000, 7);
		vnc.sockets.at(-1)?.write(big);
		const got = () =>
			Buffer.concat(of(link, "screenShareData").map((f) => (f.body.case === "screenShareData" ? Buffer.from(f.body.value.data) : Buffer.alloc(0)))).byteLength;
		await until(() => got() === 12 + big.byteLength);
		expect(of(link, "screenShareData").every((f) => f.body.case === "screenShareData" && f.body.value.data.byteLength <= CHUNK_BYTES)).toBe(true);

		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^screen share: opened by phone/);
		expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain('"action":"screen_share"');
		expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain(SECRET);

		expect((await link.request("c", { case: "screenShareClose", value: { streamId } })).body.case).toBe("ack");
		await until(() => vnc.closed >= 2);
		const after = await link.request("d2", { case: "screenShareData", value: { streamId, data: new Uint8Array([1]) } });
		expect(after.body.case === "error" && after.body.value.reason).toBe(ErrorReason.SCREEN_SHARE_GONE);
		expect(logs.join("\n")).not.toContain(SECRET);
	});

	it("one session at a time; the device's link closing ends it", async () => {
		const s = share();
		const a = await device(s);
		const b = await device(s);
		expect((await a.request("o", { case: "screenShareOpen", value: {} })).body.case).toBe("screenShareOpened");
		const busy = await b.request("o", { case: "screenShareOpen", value: {} });
		expect(busy.body.case === "error" && busy.body.value.reason).toBe(ErrorReason.SCREEN_SHARE_BUSY);
		// Another device cannot write into it either.
		a.close();
		await until(() => vnc.closed >= 1);
		expect((await b.request("o2", { case: "screenShareOpen", value: {} })).body.case).toBe("screenShareOpened");
	});

	it("ends when nothing comes from the device for too long, or when the service closes", async () => {
		const s = share({ idleMs: 150 });
		const link = await device(s);
		await link.request("o", { case: "screenShareOpen", value: {} });
		await until(() => of(link, "screenShareClosed").length === 1, 3_000);
		const closed = of(link, "screenShareClosed")[0];
		expect(closed?.body.case === "screenShareClosed" && closed.body.value.reason).toBe(ScreenShareEnd.IDLE);

		await link.request("o2", { case: "screenShareOpen", value: {} });
		await until(() => vnc.sockets.length === 2);
		vnc.sockets.at(-1)?.destroy();
		await until(() => of(link, "screenShareClosed").length === 2);
		const second = of(link, "screenShareClosed")[1];
		expect(second?.body.case === "screenShareClosed" && second.body.value.reason).toBe(ScreenShareEnd.SERVICE);
	});

	it("Screen Sharing off: refused, and the web is told why", async () => {
		const port = vnc.port;
		vnc.stop();
		const link = await device(share({ port }));
		const off = await link.request("o", { case: "screenShareOpen", value: {} });
		expect(off.body.case === "error" && off.body.value.reason).toBe(ErrorReason.SCREEN_SHARING_OFF);
	});

	it("a machine without it refuses every request", async () => {
		const link = await device(share({ supported: false }));
		const r = await link.request("s", { case: "screenShareStatusRequest", value: {} });
		expect(r.body.case === "error" && r.body.value.reason).toBe(ErrorReason.UNSUPPORTED_REQUEST);
	});
});

describe("deleting the browser's profile from a device", () => {
	it("ends takeovers, closes the browser, deletes the profile and logs it", async () => {
		const chrome = new FakeChrome();
		await chrome.start();
		try {
			const browser = new RemoteBrowser({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")), launcher: chrome.launcher });
			const waiting = browser.requestTakeover({ key: "k", threadId: "t" }, { reason: "Sign in", osDialog: true }).catch((err: unknown) => err as Error);
			await until(() => browser.openTakeovers().length === 1);
			expect(browser.openTakeovers()[0]?.osDialog).toBe(true);
			const link = await device(share(), browser);
			expect(of(link, "browserTakeover")[0]?.body.case === "browserTakeover" && (of(link, "browserTakeover")[0]?.body.value as { osDialog: boolean }).osDialog).toBe(true);
			const answer = await link.request("x", { case: "browserClear", value: {} });
			expect(answer.body.case).toBe("machineInfo");
			expect(String(await waiting)).toMatch(/profile was deleted/);
			expect(chrome.cleared).toBe(1);
			expect(chrome.called("Browser.close")).toHaveLength(1);
			expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain('"device":"phone');
			expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain('"action":"browser_clear"');
		} finally {
			chrome.stop();
		}
	});
});

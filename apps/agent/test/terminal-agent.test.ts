// The agent's terminal against a stand-in terminal process that speaks the
// real control protocol: who may open a terminal, signaling, the relay path,
// revocation, reconnects, the consent log, and that a terminal keystroke
// never waits behind a slow chat request.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorCode, ErrorReason, TermPath, TermSignalKind, TerminalAvailability } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, toBase64Url } from "@achoo254/chat-remote-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import type { AuditLog } from "../src/safety/audit-log.ts";
import { Machine } from "../src/machine.ts";
import { TokenBucket } from "../src/terminal/terminal-service.ts";
import { fakeProvider } from "./fake-provider.ts";
import { tempDir } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";
import { revokeDevice } from "./support/trusted-devices.ts";
import { FakeTermHost, fakeUnit } from "./support/fake-term-host.ts";
import { type DeviceConnection, termDatas, termSignals, termStatuses, terminalMachine } from "./support/terminal-device.ts";
import { T, attachFrame, helloFrame, inputFrame, readServerFrame } from "./support/terminal-frames.ts";

// Any existing file stands for the binary: the fake unit starts the stand-in instead.
const env = { TUNELO_TERM_HOST_BIN: "/bin/sh" };
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function setup(extra: { claudeConfigDir?: () => string | undefined; orphanGraceMs?: number; minor?: number } = {}) {
  const configDir = join(tempDir("term-"), "cfg");
  const host = new FakeTermHost(configDir);
  host.minor = extra.minor ?? 0;
  const unit = fakeUnit(host);
  const m = await terminalMachine({
    unit,
    env,
    configDir,
    ...(extra.claudeConfigDir ? { claudeConfigDir: extra.claudeConfigDir } : {}),
    ...(extra.orphanGraceMs !== undefined ? { orphanGraceMs: extra.orphanGraceMs } : {}),
  });
  cleanup.push(() => rmSync(dirname(configDir), { recursive: true, force: true }), () => m.terminal.stop(), () => host.stop());
  return { ...m, host, unit };
}

const statuses = (c: DeviceConnection, link: number) => termStatuses(c.received).filter((s) => s.link === link);
const termData = (c: DeviceConnection, link: number) => termDatas(c.received).filter((d) => d.link === link);
/** The machine's terminal lines in the consent log, oldest first. */
const terminalAudit = (audit: AuditLog) =>
  audit
    .list(1000)
    .filter((e) => e.action === "terminal")
    .reverse();

describe("terminal permission", () => {
  it("never reaches an unknown device: the end-to-end handshake refuses it first", async () => {
    const m = await setup();
    const stranger = await generateKeyPair();
    await expect(m.connect(stranger)).rejects.toThrow();
    expect(m.host.commands).toEqual([]);
  });

  it("refuses a device revoked while its connection is open, and writes the refusal to the consent log", async () => {
    const m = await setup();
    const device = await m.pair();
    const c = await m.connect(device);
    revokeDevice(m.config, device.publicKey);
    const r = await c.request("1", { case: "termListRequest", value: {} });
    expect(r.body).toMatchObject({ case: "error", value: { code: ErrorCode.INVALID, reason: ErrorReason.ACCESS_DENIED } });
    c.send({ case: "termData", value: { link: 3, data: helloFrame() } });
    await c.waitFor((f) => f.body.case === "termStatus" && f.body.value.path === TermPath.CLOSED);
    expect(statuses(c, 3).at(-1)?.reason).toBe("revoked");
    // Nothing was granted.
    expect(m.host.commands.filter((x) => x.cmd === "grant")).toEqual([]);
    const lines = terminalAudit(m.audit);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.detail.startsWith("denied"))).toBe(true);
  });
});

describe("terminal signaling", () => {
  it("grants a link to the paired device under its whole key and relays offer, answer and candidates both ways", async () => {
    const m = await setup();
    const device = await m.pair();
    const c = await m.connect(device);
    const ack = await c.request("o1", { case: "termSignal", value: { link: 7, kind: TermSignalKind.OFFER, sdp: "v=0\r\nfake-offer\r\n" } });
    expect(ack.body.case).toBe("ack");
    const answer = await c.waitFor((f) => f.body.case === "termSignal" && f.body.value.kind === TermSignalKind.ANSWER);
    expect(answer.body.value).toMatchObject({ link: 7, sdp: "v=0\r\nfake-answer\r\n" });
    await c.waitFor((f) => f.body.case === "termSignal" && f.body.value.kind === TermSignalKind.CANDIDATE);
    expect(statuses(c, 7).map((s) => s.path)).toContain(TermPath.CONNECTING);

    const grant = m.host.commands.find((x) => x.cmd === "grant");
    expect(grant?.deviceKey).toBe(toBase64Url(device.publicKey));
    const offer = m.host.commands.find((x) => x.cmd === "signal");
    expect(offer).toMatchObject({ conn: grant?.conn, kind: "offer", sdp: "v=0\r\nfake-offer\r\n" });

    await c.request("c1", { case: "termSignal", value: { link: 7, kind: TermSignalKind.CANDIDATE, candidate: "candidate:9 1 udp 9 198.51.100.7 5000 typ host" } });
    await c.request("e1", { case: "termSignal", value: { link: 7, kind: TermSignalKind.END } });
    const signals = m.host.commands.filter((x) => x.cmd === "signal").map((x) => x.kind);
    expect(signals).toEqual(["offer", "candidate", "end"]);
    // A candidate for a link that does not exist is an error by id.
    const unknown = await c.request("c2", { case: "termSignal", value: { link: 99, kind: TermSignalKind.CANDIDATE, candidate: "x" } });
    expect(unknown.body).toMatchObject({ case: "error", value: { code: ErrorCode.NOT_FOUND } });
  });

  it("passes on 'direct' twice (the second with the round trip) and writes a failed DTLS check to the consent log", async () => {
    const m = await setup();
    const device = await m.pair();
    const c = await m.connect(device);
    await c.request("o1", { case: "termSignal", value: { link: 1, kind: TermSignalKind.OFFER, sdp: "v=0\r\n" } });
    const conn = m.host.commands.find((x) => x.cmd === "grant")?.conn;
    m.host.emit({ event: "conn_state", conn, state: "direct" });
    m.host.emit({ event: "conn_state", conn, state: "direct", rttMs: 1.4 });
    m.host.emit({ event: "signal", conn, kind: "end", reason: "dtls_failed" });
    m.host.emit({ event: "conn_state", conn, state: "relay" });
    await c.waitFor((f) => f.body.case === "termStatus" && f.body.value.path === TermPath.RELAY);
    const direct = statuses(c, 1).filter((s) => s.path === TermPath.DIRECT);
    expect(direct.map((s) => s.rttMs)).toEqual([0, expect.closeTo(1.4, 3)]);
    const end = termSignals(c.received).find((s) => s.kind === TermSignalKind.END);
    expect(end?.reason).toBe("dtls_failed");
    const lines = terminalAudit(m.audit);
    expect(lines.some((l) => l.detail === `dtls_failed conn ${String(conn)}`)).toBe(true);
    expect(lines.some((l) => l.device.includes(toBase64Url(device.publicKey).slice(0, 8)))).toBe(true);
  });
});

describe("terminal relay path", () => {
  it("carries terminal frames byte for byte: Hello is answered and a keystroke comes back", async () => {
    const m = await setup();
    const c = await m.connect(await m.pair());
    c.send({ case: "termData", value: { link: 2, data: helloFrame() } });
    c.send({ case: "termData", value: { link: 2, data: attachFrame(1, 0n) } });
    c.send({ case: "termData", value: { link: 2, data: inputFrame(1, "k") } });
    await c.waitFor((f) => f.body.case === "termData" && f.body.value.data[0] === T.OUTPUT);
    const types = termData(c, 2).map((d) => readServerFrame(d.data).type);
    expect(types).toEqual(["hello", "output"]);
    const out = readServerFrame(termData(c, 2)[1]?.data ?? new Uint8Array());
    expect(out.type === "output" && new TextDecoder().decode(out.data)).toBe("k");
    // grant, then relay_open, then frames: in that order.
    expect(m.host.order.filter((x) => x === "grant" || x === "relay_open")).toEqual(["grant", "relay_open"]);
    expect(statuses(c, 2).map((s) => s.path)).toEqual([TermPath.RELAY]);
  });

  it("a slow chat request on the same connection does not hold a keystroke's echo back", async () => {
    const m = await setup();
    const c = await m.connect(await m.pair());
    c.send({ case: "termData", value: { link: 1, data: helloFrame() } });
    c.send({ case: "termData", value: { link: 1, data: attachFrame(1, 0n) } });
    await c.waitFor((f) => f.body.case === "termData");
    let release: () => void = () => undefined;
    vi.spyOn(m.core, "list").mockImplementation(() => []);
    vi.spyOn(m.core, "create").mockImplementation(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new Error("slow on purpose"));
        }),
    );
    const slow = c.request("slow", { case: "threadCreate", value: { provider: "fake", dir: "/", text: "hi" } });
    // A ping queued behind it waits too: proof the queue is held.
    const ping = c.request("p", { case: "ping", value: {} });
    const t0 = performance.now();
    c.send({ case: "termData", value: { link: 1, data: inputFrame(1, "z") } });
    await c.waitFor((f) => f.body.case === "termData" && f.body.value.data[0] === T.OUTPUT);
    const echoMs = performance.now() - t0;
    expect(echoMs).toBeLessThan(100);
    expect(c.received.some((f) => f.id === "p")).toBe(false);
    release();
    expect((await slow).body.case).toBe("error");
    expect((await ping).body.case).toBe("pong");
  });

  it("a broken terminal frame ends only its link; a forged message ends only its connection, chat goes on", async () => {
    const m = await setup();
    const device = await m.pair();
    const chat = await m.connect(device);
    const term = await m.connect(device);
    term.send({ case: "termData", value: { link: 4, data: helloFrame() } });
    await term.waitFor((f) => f.body.case === "termData");
    term.send({ case: "termData", value: { link: 4, data: new Uint8Array([0x10, 0, 0]) } });
    const closed = await term.waitFor((f) => f.body.case === "termStatus" && f.body.value.path === TermPath.CLOSED);
    expect(closed.body.value).toMatchObject({ link: 4, reason: "bad_frame" });
    await vi.waitFor(() => expect(m.host.commands.some((x) => x.cmd === "conn_close")).toBe(true));
    // The connection itself is still fine.
    expect((await term.request("p1", { case: "ping", value: {} })).body.case).toBe("pong");
    // Bytes that do not open as a sealed frame close that connection only.
    term.raw(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
    await vi.waitFor(() => expect(term.isClosed()).toBe(true));
    expect(chat.isClosed()).toBe(false);
    expect((await chat.request("p2", { case: "ping", value: {} })).body.case).toBe("pong");
  });

  it("holds output while the device's socket is full and sends it in order once it drains", async () => {
    const m = await setup();
    let full = true;
    const c = await m.connect(await m.pair(), () => (full ? 10 * 1024 * 1024 : 0));
    c.send({ case: "termData", value: { link: 1, data: helloFrame() } });
    c.send({ case: "termData", value: { link: 1, data: attachFrame(1, 0n) } });
    for (const ch of "abc") c.send({ case: "termData", value: { link: 1, data: inputFrame(1, ch) } });
    await new Promise((r) => setTimeout(r, 100));
    expect(termData(c, 1)).toEqual([]);
    full = false;
    await vi.waitFor(() => expect(termData(c, 1).length).toBe(4));
    const echoed = termData(c, 1)
      .slice(1)
      .map((d) => readServerFrame(d.data))
      .map((f) => (f.type === "output" ? new TextDecoder().decode(f.data) : "?"));
    expect(echoed.join("")).toBe("abc");
  });

  it("the machine's relay budget lets 40 frames through at once and refills at 200 a second", () => {
    let now = 0;
    const bucket = new TokenBucket(200, 40, () => now);
    let taken = 0;
    while (bucket.take()) taken++;
    expect(taken).toBe(40);
    expect(bucket.wait()).toBe(5);
    now += 50;
    taken = 0;
    while (bucket.take()) taken++;
    expect(taken).toBe(10);
  });
});

describe("terminal sessions", () => {
  it("lists, opens, resizes and closes sessions; limits and gone sessions get their reasons", async () => {
    const m = await setup();
    const c = await m.connect(await m.pair());
    const opened = await c.request("1", { case: "termOpen", value: { cols: 80, rows: 24, cwd: "" } });
    expect(opened.body).toMatchObject({ case: "termOpened", value: { session: 1 } });
    const open = m.host.commands.find((x) => x.cmd === "open");
    // The user's home, and no Claude folder for the default profile.
    expect(open?.cwd).toBeTypeOf("string");
    expect(open).not.toHaveProperty("env");
    const list = await c.request("2", { case: "termListRequest", value: {} });
    expect(list.body).toMatchObject({ case: "termListResult", value: { maxSessions: 20, sessions: [{ session: 1, cols: 80, rows: 24, cwd: open?.cwd }] } });
    expect((await c.request("3", { case: "termResize", value: { session: 1, cols: 100, rows: 30 } })).body.case).toBe("ack");
    expect((await c.request("4", { case: "termClose", value: { session: 1 } })).body).toMatchObject({ case: "termClosed", value: { session: 1 } });
    const gone = await c.request("5", { case: "termResize", value: { session: 1, cols: 100, rows: 30 } });
    expect(gone.body).toMatchObject({ case: "error", value: { code: ErrorCode.NOT_FOUND, reason: ErrorReason.TERMINAL_SESSION_NOT_FOUND } });
    const badDim = await c.request("6", { case: "termOpen", value: { cols: 0, rows: 24, cwd: "" } });
    expect(badDim.body).toMatchObject({ case: "error", value: { code: ErrorCode.INVALID } });
    const badDir = await c.request("7", { case: "termOpen", value: { cols: 80, rows: 24, cwd: "/no/such/folder" } });
    expect(badDir.body).toMatchObject({ case: "error", value: { reason: ErrorReason.FOLDER_NOT_FOUND } });
    for (let i = 0; i < 20; i++) await c.request(`f${i}`, { case: "termOpen", value: { cols: 80, rows: 24, cwd: "" } });
    const full = await c.request("8", { case: "termOpen", value: { cols: 80, rows: 24, cwd: "" } });
    expect(full.body).toMatchObject({ case: "error", value: { reason: ErrorReason.TERMINAL_SESSION_LIMIT } });
  });

  it("gives a shell the selected Claude profile's folder only when it is not the default one", async () => {
    const m = await setup({ claudeConfigDir: () => "/Users/someone/.config/tunelo/claude/p1" });
    const c = await m.connect(await m.pair());
    await c.request("1", { case: "termOpen", value: { cols: 80, rows: 24, cwd: "" } });
    expect(m.host.commands.find((x) => x.cmd === "open")?.env).toEqual({ CLAUDE_CONFIG_DIR: "/Users/someone/.config/tunelo/claude/p1" });
  });

  it("a machine without the terminal says UNSUPPORTED_REQUEST, as older agents do for any frame they do not know", async () => {
    const m = await setup();
    const c = await m.connect(await m.pair());
    // Older agent behavior: a frame without a known body.
    c.send({ case: undefined }, "u");
    const unknown = await c.waitFor((f) => f.id === "u");
    expect(unknown.body).toMatchObject({ case: "error", value: { reason: ErrorReason.UNSUPPORTED_REQUEST } });
    // A connection made without a terminal answers Term* the same way.
    const plain = await terminalMachine({ unit: undefined });
    const noTerm = await pairedDevice({ core: plain.core, config: plain.config, audit: plain.audit });
    const r = await noTerm.request("t", { case: "termListRequest", value: {} });
    expect(r.body).toMatchObject({ case: "error", value: { reason: ErrorReason.UNSUPPORTED_REQUEST } });
    plain.terminal.stop();
  });
});

describe("terminal revocation and reconnects", () => {
  it("revoking a device closes its links at once; set_revoked always goes before any grant after a reconnect", async () => {
    const m = await setup();
    const device = await m.pair();
    const other = await m.pair("phone");
    const c = await m.connect(device);
    const o = await m.connect(other);
    c.send({ case: "termData", value: { link: 1, data: helloFrame() } });
    o.send({ case: "termData", value: { link: 1, data: helloFrame() } });
    await c.waitFor((f) => f.body.case === "termData");
    await o.waitFor((f) => f.body.case === "termData");
    const key = toBase64Url(device.publicKey);
    revokeDevice(m.config, key);
    const t0 = performance.now();
    m.terminal.revokeDevice(key);
    const closed = await c.waitFor((f) => f.body.case === "termStatus" && f.body.value.path === TermPath.CLOSED, 1_000);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(closed.body.value).toMatchObject({ reason: "revoked" });
    expect(statuses(o, 1).some((s) => s.path === TermPath.CLOSED)).toBe(false);

    // The terminal process drops the agent: it reconnects, hands over the revoked keys, then grants again.
    const before = m.host.order.length;
    m.host.dropAgent();
    await vi.waitFor(() => expect(m.host.order.slice(before)).toEqual(expect.arrayContaining(["hello", "set_revoked"])), { timeout: 5_000 });
    const after = m.host.order.slice(before);
    expect(after.slice(0, 2)).toEqual(["hello", "set_revoked"]);
    expect(m.host.commands.filter((x) => x.cmd === "set_revoked").at(-1)?.deviceKeys).toEqual([key]);
    // The relay-only link of the other device ended with the agent's link; a new frame opens a new one.
    await o.waitFor((f) => f.body.case === "termStatus" && f.body.value.path === TermPath.CLOSED);
    expect(statuses(o, 1).at(-1)?.reason).toBe("agent_gone");
    o.send({ case: "termData", value: { link: 1, data: helloFrame() } });
    await vi.waitFor(() => expect(termData(o, 1).length).toBe(2));
    const order = m.host.order.slice(before);
    expect(order.indexOf("set_revoked")).toBeLessThan(order.indexOf("grant"));
  });

  it("a device the account no longer lists loses its terminal links, and the consent log says so", async () => {
    const host = new FakeTermHost(join(tempDir("term-"), "cfg"));
    const config = new ConfigStore(host.configDir);
    const machine = new Machine({ config, providers: [fakeProvider()], log: () => undefined, termHostUnit: fakeUnit(host), env });
    cleanup.push(() => rmSync(dirname(host.configDir), { recursive: true, force: true }), () => machine.terminal.stop(), () => host.stop());
    const device = await generateKeyPair();
    const key = toBase64Url(device.publicKey);
    machine.applyTrustedDevices([{ key, name: "phone", platform: "ios", createdAt: 1 }]);
    await machine.terminal.ensure();
    machine.applyTrustedDevices([]);
    await vi.waitFor(() => expect(host.commands.find((x) => x.cmd === "revoke_device")?.deviceKey).toBe(key));
    expect(host.commands.filter((x) => x.cmd === "revoke_device")).toHaveLength(1);
    expect(config.deviceStatus(device.publicKey)).toBe("revoked");
    expect(machine.audit.list(10).map((e) => [e.action, e.device])).toEqual([
      ["revoke", `phone (${key.slice(0, 8)})`],
      ["device_added", `phone (${key.slice(0, 8)})`],
    ]);
  });

  it("writes the terminal process's unsent audit once, acknowledges it, and keeps typed bytes out", async () => {
    const m = await setup();
    const device = await m.pair();
    const key = toBase64Url(device.publicKey);
    m.host.pendingAudit = [
      { seq: 1, kind: "open", session: 3, conn: 9, deviceKey: key, at: 1_000 },
      { seq: 2, kind: "close", session: 3, conn: 9, deviceKey: key, at: 2_000 },
    ];
    const c = await m.connect(device);
    await c.request("l", { case: "termListRequest", value: {} });
    await vi.waitFor(() => expect(m.host.commands.find((x) => x.cmd === "ack_audit")?.upTo).toBe(2));
    // Live events (and the same seq again) after that.
    m.host.emit({ event: "audit", seq: 2, kind: "close", session: 3, conn: 9, deviceKey: key, at: 2_000 });
    c.send({ case: "termData", value: { link: 1, data: helloFrame() } });
    c.send({ case: "termData", value: { link: 1, data: attachFrame(5, 0n) } });
    c.send({ case: "termData", value: { link: 1, data: inputFrame(5, "secret-typed-text") } });
    await c.waitFor((f) => f.body.case === "termData" && f.body.value.data[0] === T.OUTPUT);
    c.close();
    await vi.waitFor(() => {
      const lines = terminalAudit(m.audit);
      expect(lines.map((l) => l.detail)).toEqual(["open session 3 conn 9", "close session 3 conn 9", expect.stringMatching(/^open session 5 conn \d+$/), expect.stringMatching(/^close session 5 conn \d+$/)]);
    });
    const raw = JSON.stringify(m.audit.list(1000));
    expect(raw).not.toContain("secret-typed-text");
    expect(terminalAudit(m.audit).every((l) => l.device === `laptop (${key.slice(0, 8)})`)).toBe(true);
  });
});

describe("connections left by an earlier agent run", () => {
  const closes = (host: FakeTermHost) => host.commands.filter((x) => x.cmd === "conn_close").map((x) => x.conn);

  it("closes the ones this run does not hold after the grace, keeps its own across reconnects, and never touches sessions", async () => {
    const m = await setup({ minor: 1, orphanGraceMs: 150 });
    const leftKey = toBase64Url((await generateKeyPair()).publicKey);
    // A direct peer of the previous agent run, attached to session 1, still live in the terminal process.
    m.host.conns.set(77, { key: leftKey, relay: false, offset: new Map([[1, 0n]]) });
    m.host.sessions = [{ session: 1, title: "", cols: 80, rows: 24, createdAt: 1, attached: true }];
    const c = await m.connect(await m.pair());
    // This run's own link, granted and on the direct path.
    await c.request("o", { case: "termSignal", value: { link: 3, kind: TermSignalKind.OFFER, sdp: "v=0\r\n" } });
    const own = m.host.commands.find((x) => x.cmd === "grant")?.conn;
    expect(own).toBeTypeOf("number");
    m.host.emit({ event: "conn_state", conn: own, state: "direct" });
    await c.waitFor((f) => f.body.case === "termStatus" && f.body.value.link === 3 && f.body.value.path === TermPath.DIRECT);

    // The control link drops twice before the grace ends; every hello lists both connections again.
    for (let i = 0; i < 2; i++) {
      const before = m.host.order.length;
      m.host.dropAgent();
      await vi.waitFor(() => expect(m.host.order.slice(before)).toContain("set_revoked"), { timeout: 5_000 });
    }
    expect(m.host.commands.filter((x) => x.cmd === "hello")).toHaveLength(3);
    await vi.waitFor(() => expect(closes(m.host)).toEqual([77]), { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 300));
    // Closed once; this run's link lives on; no session was closed.
    expect(closes(m.host)).toEqual([77]);
    expect(m.host.conns.has(own as number)).toBe(true);
    expect(statuses(c, 3).some((s) => s.path === TermPath.CLOSED)).toBe(false);
    expect(m.host.commands.some((x) => x.cmd === "close")).toBe(false);
    expect(m.host.sessions.map((s) => s.session)).toEqual([1]);
    // The agent writes the detach of the closed connection to the consent log.
    await vi.waitFor(() => expect(terminalAudit(m.audit).map((l) => l.detail)).toContain("close session 1 conn 77"));
    expect(m.logs.some((l) => l.includes("left by an earlier agent run"))).toBe(true);
  });

  it("a connection that ends by itself during the grace is not closed again", async () => {
    const m = await setup({ minor: 1, orphanGraceMs: 200 });
    m.host.conns.set(78, { key: toBase64Url((await generateKeyPair()).publicKey), relay: false, offset: new Map() });
    await m.terminal.ensure();
    m.host.conns.delete(78);
    m.host.emit({ event: "conn_state", conn: 78, state: "closed", reason: "transport_closed" });
    await new Promise((r) => setTimeout(r, 400));
    expect(closes(m.host)).toEqual([]);
  });

  it("a minor 0 terminal process lists no connections: nothing is closed and nothing fails", async () => {
    const m = await setup({ orphanGraceMs: 50 });
    m.host.conns.set(77, { key: toBase64Url((await generateKeyPair()).publicKey), relay: false, offset: new Map() });
    const c = await m.connect(await m.pair());
    c.send({ case: "termData", value: { link: 1, data: helloFrame() } });
    await c.waitFor((f) => f.body.case === "termData");
    await new Promise((r) => setTimeout(r, 250));
    expect(m.host.commands.find((x) => x.cmd === "hello")?.minor).toBe(1);
    expect(closes(m.host)).toEqual([]);
    expect(m.host.conns.has(77)).toBe(true);
    expect(m.logs.some((l) => l.includes("earlier agent run"))).toBe(false);
    expect(m.terminal.availability()).toBe(TerminalAvailability.AVAILABLE);
  });
});

describe("terminal availability", () => {
  it("is missing without a binary, incompatible without a supervisor or for another major, available once connected", async () => {
    const missing = await terminalMachine({ unit: fakeUnit(new FakeTermHost(tempDir())), env: { TUNELO_TERM_HOST_BIN: "/no/such/binary" } });
    expect(missing.terminal.availability()).toBe(TerminalAvailability.MISSING);
    const c = await missing.connect(await missing.pair());
    const r = await c.request("1", { case: "termListRequest", value: {} });
    expect(r.body).toMatchObject({ case: "error", value: { reason: ErrorReason.TERMINAL_UNAVAILABLE } });
    missing.terminal.stop();

    const unsupervised = await terminalMachine({ unit: undefined, env });
    expect(unsupervised.terminal.availability()).toBe(TerminalAvailability.INCOMPATIBLE);
    unsupervised.terminal.stop();

    const m = await setup();
    expect(m.terminal.availability()).toBe(TerminalAvailability.AVAILABLE);
    m.host.major = 2;
    await m.host.start();
    await expect(m.terminal.ensure()).rejects.toThrow(/another version/);
    expect(m.terminal.availability()).toBe(TerminalAvailability.INCOMPATIBLE);
    await m.host.stop();
    m.host.major = 1;
    await expect(m.terminal.ensure()).resolves.toBeUndefined();
    expect(m.terminal.availability()).toBe(TerminalAvailability.AVAILABLE);
    // The unit was written once for that binary, and started each time none ran.
    expect(m.unit.installs).toEqual(["/bin/sh"]);
  });
});

// The agent's terminal against the real tunelo-term-host binary (path in
// TUNELO_TERM_HOST_BIN; `cargo build --release` in apps/term-host makes it).
// Devices talk to the machine over in-memory end-to-end connections; the
// terminal process runs a real shell in a real PTY. Node has no WebRTC, so
// terminal bytes go over the relay path here; the direct path's signaling is
// checked with a real SDP offer the terminal process answers.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { TermPath, TermSignalKind } from "@achoo254/chat-proto/remote/remote";
import { toBase64Url } from "@achoo254/chat-remote-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTermHost } from "../src/service.ts";
import { ControlError, readControlInfo } from "../src/terminal/host-link.ts";
import type { TermHostUnit } from "../src/terminal/host-supervisor.ts";
import { tempDir } from "./harness.ts";
import { type DeviceConnection, termStatuses, terminalMachine } from "./support/terminal-device.ts";
import { T, attachFrame, helloFrame, inputFrame, readServerFrame } from "./support/terminal-frames.ts";

const BIN = process.env.TUNELO_TERM_HOST_BIN;
if (!BIN) {
  // Straight to stderr: vitest keeps console output of a skipped file to itself.
  process.stderr.write(
    "\n*** terminal-host-real.test.ts SKIPPED: TUNELO_TERM_HOST_BIN is not set. Build apps/term-host (cargo build --release) and point it at the binary to run these tests. ***\n\n",
  );
}

/** Starts the binary directly, as its OS unit would; stderr goes to term-host.log in the config folder. */
function directUnit(configDir: string, started: ChildProcess[]): TermHostUnit {
  let installed = "";
  return {
    current: (bin) => installed === bin,
    install: async (bin) => {
      installed = bin;
    },
    start: async () => {
      const log = openSync(join(configDir, "term-host.log"), "a");
      const child = spawn(installed, [], {
        // A quick plain login shell; no STUN in tests.
        env: { ...process.env, TUNELO_HOME: configDir, TUNELO_TERM_STUN: "", SHELL: "/bin/sh" },
        stdio: ["ignore", "ignore", log],
        detached: true,
      });
      child.unref();
      started.push(child);
    },
    remove: async () => undefined,
  };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function machine(configDir = join(tempDir("termr-"), "cfg")) {
  const started: ChildProcess[] = [];
  const unit = directUnit(configDir, started);
  const m = await terminalMachine({ unit, env: { TUNELO_TERM_HOST_BIN: BIN ?? "" }, configDir });
  cleanup.push(async () => {
    m.terminal.stop();
    await removeTermHost(configDir, unit, () => undefined);
    for (const c of started) if (c.pid && alive(c.pid)) process.kill(c.pid, "SIGKILL");
    rmSync(dirname(configDir), { recursive: true, force: true });
  });
  return { ...m, configDir, unit, started };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Everything the shell printed on a link's session so far (Snapshot text and Output), as text. */
function screen(c: DeviceConnection, link: number, session: number): string {
  let text = "";
  for (const f of c.received) {
    if (f.body.case !== "termData" || f.body.value.link !== link) continue;
    const s = readServerFrame(f.body.value.data);
    if (s.type === "output" && s.session === session) text += new TextDecoder().decode(s.data);
    if (s.type === "snapshot" && s.session === session) text += new TextDecoder().decode(s.vt);
  }
  return text;
}

async function openShell(c: DeviceConnection, link: number): Promise<number> {
  const opened = await c.request(`open-${link}`, { case: "termOpen", value: { cols: 80, rows: 24, cwd: "" } });
  if (opened.body.case !== "termOpened") throw new Error(`not opened: ${JSON.stringify(opened.body.value)}`);
  const session = opened.body.value.session;
  c.send({ case: "termData", value: { link, data: helloFrame() } });
  c.send({ case: "termData", value: { link, data: attachFrame(session, 0n) } });
  await c.waitFor((f) => f.body.case === "termData" && f.body.value.link === link && f.body.value.data[0] === T.S_HELLO, 10_000);
  return session;
}

async function typeAndWait(c: DeviceConnection, link: number, session: number, line: string, expected: string, ms = 10_000): Promise<void> {
  c.send({ case: "termData", value: { link, data: inputFrame(session, line) } });
  await vi.waitFor(() => expect(screen(c, link, session)).toContain(expected), { timeout: ms, interval: 20 });
}

// An offer as a browser writes it for two data channels (fingerprint of a throwaway certificate).
const OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:Zx3q",
  "a=ice-pwd:N1ql7b0k2T4mJ8sVfR6yHc5w",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).padStart(2, "0").toUpperCase()).join(":")}`,
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "",
].join("\r\n");

describe.skipIf(!BIN)("terminal with the real terminal process", () => {
  it("runs a real shell over the relay path, echoes typing, and keeps typed bytes out of the consent log and its log", async () => {
    const m = await machine();
    const c = await m.connect(await m.pair());
    const session = await openShell(c, 1);
    await typeAndWait(c, 1, session, "echo hi_$((6*7)) typed-secret-xyz\r", "hi_42");
    expect(termStatuses(c.received).filter((s) => s.link === 1).map((s) => s.path)).toContain(TermPath.RELAY);
    const list = await c.request("l", { case: "termListRequest", value: {} });
    expect(list.body).toMatchObject({ case: "termListResult", value: { sessions: [{ session, attached: true }] } });
    c.close();
    // The close reaches the consent log through the terminal process's audit.
    await vi.waitFor(() => expect(m.audit.list(100).filter((e) => e.action === "terminal").map((e) => e.detail.split(" ")[0])).toEqual(["close", "open"]), { timeout: 5_000 });
    expect(JSON.stringify(m.audit.list(100))).not.toContain("typed-secret-xyz");
    expect(readFileSync(join(m.configDir, "term-host.log"), "utf8")).not.toContain("typed-secret-xyz");
  });

  it("answers a real SDP offer through the agent, then the device drops the peer", async () => {
    const m = await machine();
    const c = await m.connect(await m.pair());
    const ack = await c.request("o", { case: "termSignal", value: { link: 5, kind: TermSignalKind.OFFER, sdp: OFFER } });
    expect(ack.body.case).toBe("ack");
    const reply = await c.waitFor((f) => f.body.case === "termSignal" && f.body.value.link === 5, 10_000);
    const signal = reply.body.case === "termSignal" ? reply.body.value : undefined;
    // The terminal process leaves out loopback and link-local addresses; with none left it ends with no_address.
    const usable = Object.values(networkInterfaces())
      .flat()
      .some((a) => a !== undefined && !a.internal && !a.address.startsWith("169.254.") && !a.address.toLowerCase().startsWith("fe80"));
    if (usable) {
      expect(signal?.kind).toBe(TermSignalKind.ANSWER);
      expect(signal?.sdp).toMatch(/a=fingerprint:sha-256 /);
      expect(signal?.sdp).toMatch(/m=application/);
      expect(signal?.sdp).toMatch(/a=candidate:.* typ host/);
    } else {
      expect(signal).toMatchObject({ kind: TermSignalKind.END, reason: "no_address" });
    }
    expect(termStatuses(c.received).some((s) => s.link === 5 && s.path === TermPath.CONNECTING)).toBe(true);
    expect((await c.request("e", { case: "termSignal", value: { link: 5, kind: TermSignalKind.END } })).body.case).toBe("ack");
  });

  it("revoking a device closes its open terminal within a second, while its connection is still up", async () => {
    const m = await machine();
    const device = await m.pair();
    const c = await m.connect(device);
    const session = await openShell(c, 1);
    await typeAndWait(c, 1, session, "echo ready_$((2+3))\r", "ready_5");
    const key = toBase64Url(device.publicKey);
    m.config.revokeDevice(key);
    const t0 = performance.now();
    m.terminal.revokeDevice(key);
    const closed = await c.waitFor((f) => f.body.case === "termStatus" && f.body.value.link === 1 && f.body.value.path === TermPath.CLOSED, 1_000);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(closed.body.value).toMatchObject({ reason: "revoked" });
    // The terminal process said so on the link before closing it (Error 6).
    const errors = c.received.flatMap((f) => (f.body.case === "termData" ? [readServerFrame(f.body.value.data)] : [])).filter((s) => s.type === "error");
    expect(errors.some((e) => e.type === "error" && e.code === 6)).toBe(true);
    // A new link of that device is refused.
    c.send({ case: "termData", value: { link: 2, data: helloFrame() } });
    await c.waitFor((f) => f.body.case === "termStatus" && f.body.value.link === 2 && f.body.value.path === TermPath.CLOSED);
  });

  it("a new agent finds the sessions kept, and hands over revocations before any grant", async () => {
    const configDir = join(tempDir("termr-"), "cfg");
    const first = await machine(configDir);
    const device = await first.pair();
    const gone = await first.pair("old phone");
    const c = await first.connect(device);
    const session = await openShell(c, 1);
    await typeAndWait(c, 1, session, "MARK=kept_$((40+2)); echo set\r", "set");
    c.close();
    // The agent stops (as for an update) and the old phone is revoked meanwhile.
    first.terminal.stop();
    first.config.revokeDevice(toBase64Url(gone.publicKey));

    const second = await terminalMachine({ unit: first.unit, env: { TUNELO_TERM_HOST_BIN: BIN ?? "" }, configDir });
    cleanup.push(() => second.terminal.stop());
    second.terminal.start();
    await second.terminal.ensure();
    expect(first.started).toHaveLength(1); // the same terminal process, not a new one
    // The terminal process itself refuses the revoked key now (the agent's own check is skipped here on purpose).
    await expect(second.terminal.call("grant", { conn: 4242, deviceKey: toBase64Url(gone.publicKey) })).rejects.toThrow(ControlError);
    await vi.waitFor(() => expect(second.audit.list(100).some((e) => e.action === "terminal" && e.detail.startsWith("denied (revoked)"))).toBe(true));

    const c2 = await second.connect(device);
    const list = await c2.request("l", { case: "termListRequest", value: {} });
    expect(list.body.case === "termListResult" && list.body.value.sessions.map((s) => s.session)).toContain(session);
    c2.send({ case: "termData", value: { link: 9, data: helloFrame() } });
    c2.send({ case: "termData", value: { link: 9, data: attachFrame(session, 0n) } });
    await typeAndWait(c2, 9, session, "echo $MARK\r", "kept_42");
  });

  it("a restarted agent closes the connections the old run left after its grace, keeps its own and the sessions, revocations first", async () => {
    const configDir = join(tempDir("termr-"), "cfg");
    const first = await machine(configDir);
    const device = await first.pair();
    const gone = await first.pair("old phone");
    const c = await first.connect(device);
    const session = await openShell(c, 1);
    await typeAndWait(c, 1, session, "MARK=left_$((40+2)); echo set\r", "set");
    // Links that outlive the agent: a peer being set up has no relay, so its grant stays when the agent goes.
    const firstGrants = vi.spyOn(first.terminal, "grant");
    expect((await c.request("o", { case: "termSignal", value: { link: 5, kind: TermSignalKind.OFFER, sdp: OFFER } })).body.case).toBe("ack");
    const old = await first.connect(gone);
    expect((await old.request("o2", { case: "termSignal", value: { link: 6, kind: TermSignalKind.OFFER, sdp: OFFER } })).body.case).toBe("ack");
    const [left, revokedLeft] = await Promise.all(firstGrants.mock.results.map((r) => (r.type === "return" ? r.value : Promise.reject(new Error("grant threw")))));
    // The agent goes away without a word (crash or update); the old phone is revoked meanwhile.
    first.terminal.stop();
    first.config.revokeDevice(toBase64Url(gone.publicKey));

    const second = await terminalMachine({ unit: first.unit, env: { TUNELO_TERM_HOST_BIN: BIN ?? "" }, configDir, orphanGraceMs: 600 });
    cleanup.push(() => second.terminal.stop());
    const calls = vi.spyOn(second.terminal, "call");
    const secondGrants = vi.spyOn(second.terminal, "grant");
    second.terminal.start();
    await second.terminal.ensure();
    expect(first.started).toHaveLength(1); // the same terminal process

    // A link of the new run, granted during the grace, reaches the kept session.
    const c2 = await second.connect(device);
    c2.send({ case: "termData", value: { link: 9, data: helloFrame() } });
    c2.send({ case: "termData", value: { link: 9, data: attachFrame(session, 0n) } });
    await typeAndWait(c2, 9, session, "echo $MARK\r", "left_42");
    const own = await secondGrants.mock.results[0]?.value;
    expect(own).toBeTypeOf("number");

    // After the grace the agent closes the old run's connection, and only that one.
    const closes = () => calls.mock.calls.filter(([cmd]) => cmd === "conn_close").map(([, p]) => p.conn);
    await vi.waitFor(() => expect(closes()).toEqual([left]), { timeout: 5_000 });
    await expect(second.terminal.call("relay_open", { conn: left })).rejects.toMatchObject({ code: "no_such_conn" });
    await new Promise((r) => setTimeout(r, 700));
    expect(closes()).toEqual([left]);
    await typeAndWait(c2, 9, session, "echo again_$((1+2))\r", "again_3");
    expect(termStatuses(c2.received).some((s) => s.link === 9 && s.path === TermPath.CLOSED)).toBe(false);
    const list = await c2.request("l", { case: "termListRequest", value: {} });
    expect(list.body.case === "termListResult" && list.body.value.sessions.map((s) => s.session)).toEqual([session]);

    // Revocations went first: the revoked phone's connection was closed by set_revoked before this run's link opened.
    const log = readFileSync(join(configDir, "term-host.log"), "utf8");
    const revokedAt = log.indexOf(`connection ${String(revokedLeft)} closed (revoked)`);
    expect(revokedAt).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`connection ${String(own)} open on relay`)).toBeGreaterThan(revokedAt);
    expect(log).toContain(`connection ${String(left)} closed (closed)`);
    expect(second.logs.some((l) => l.includes("left by an earlier agent run"))).toBe(true);
  });

  it("a slow chat request does not hold a terminal echo back more than 100 ms", async () => {
    const m = await machine();
    const c = await m.connect(await m.pair());
    const session = await openShell(c, 1);
    await typeAndWait(c, 1, session, "stty raw -echo; cat\r", "cat");
    await new Promise((r) => setTimeout(r, 300));
    let release: () => void = () => undefined;
    vi.spyOn(m.core, "create").mockImplementation(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new Error("slow on purpose"));
        }),
    );
    const slow = c.request("slow", { case: "threadCreate", value: { provider: "fake", dir: "/", text: "hi" } });
    const marks = ["q", "w", "e", "r", "t"];
    for (const ch of marks) {
      const before = screen(c, 1, session).length;
      const t0 = performance.now();
      c.send({ case: "termData", value: { link: 1, data: inputFrame(session, ch) } });
      await vi.waitFor(() => expect(screen(c, 1, session).slice(before)).toContain(ch), { timeout: 2_000, interval: 1 });
      expect(performance.now() - t0).toBeLessThan(100);
    }
    expect(c.received.some((f) => f.id === "slow")).toBe(false);
    release();
    expect((await slow).body).toMatchObject({ case: "error" });
  });

  it("uninstall shuts the terminal process down, says how many sessions were open, and leaves no process", async () => {
    const m = await machine();
    const c = await m.connect(await m.pair());
    await openShell(c, 1);
    const info = readControlInfo(m.configDir);
    expect(info?.pid).toBeGreaterThan(0);
    m.terminal.stop();
    const warnings: string[] = [];
    await removeTermHost(m.configDir, m.unit, (l) => warnings.push(l));
    expect(warnings).toEqual(["1 terminal session was still open on this machine; their shells were closed."]);
    expect(alive(info?.pid ?? 0)).toBe(false);
    expect(existsSync(join(m.configDir, "term-host", "control.json"))).toBe(false);
    for (const child of m.started) expect(alive(child.pid ?? 0)).toBe(false);
  });
});

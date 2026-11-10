// The running Machine over a real WebSocket: a device paired by the
// authenticator code is announced to the account's devices (the install's
// own browser is not), wrong codes sent on many connections at once
// cannot get past the shared lock, and running `tunelo install --trust` again on a
// machine already added is the way back in when every paired device and the
// authenticator are lost: the new browser pairs and sets a new secret.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { type Frame, FrameSchema, HandshakeErrorCode } from "@achoo254/chat-proto/remote/remote";
import {
  HandshakeFailure,
  type KeyPair,
  PakeFailure,
  decodePlain,
  encodePlain,
  generateKeyPair,
  generateTotpSecret,
  pakeStart,
  startHandshake,
  toBase64Url,
  totpCode,
  totpCodeAt,
  totpStep,
  type DeviceTrust,
} from "@achoo254/chat-remote-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type InstallDeps, install } from "../src/commands/install.ts";
import { ConfigStore } from "../src/config.ts";
import { Machine } from "../src/machine.ts";
import { fakeProvider } from "./fake-provider.ts";

process.env.TUNELO_KEYSTORE = "file";

let dir = "";
let running: Machine | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A WebSocket to the machine's local port, read one message at a time; null once closed. */
async function socket(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "nodebuffer";
  const inbox: Uint8Array[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  ws.on("message", (d: Buffer) => {
    inbox.push(new Uint8Array(d));
    wake?.();
  });
  ws.on("close", () => {
    closed = true;
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = async (): Promise<Uint8Array | null> => {
    for (;;) {
      const d = inbox.shift();
      if (d) return d;
      if (closed) return null;
      await new Promise<void>((r) => (wake = r));
    }
  };
  return { ws, next };
}

/** A new device types `code` on the pairing page; true once the machine paired it. */
async function pairByCode(port: number, device: KeyPair, code: string): Promise<boolean> {
  const s = await socket(port);
  const p = await pakeStart({ code, deviceKey: device.publicKey, deviceName: "stolen laptop" });
  s.ws.send(encodePlain({ case: "pakeStart", value: p.start }));
  const reply = decodePlain((await s.next()) ?? new Uint8Array());
  if (reply.body.case !== "pakeReply") throw new Error(`unexpected ${reply.body.case}`);
  try {
    const { finish } = await p.finish(reply.body.value);
    s.ws.send(encodePlain({ case: "pakeFinish", value: finish }));
  } catch (err) {
    if (!(err instanceof PakeFailure)) throw err;
    s.ws.close();
    return false;
  }
  // The machine closes once it paired the device.
  expect(await s.next()).toBeNull();
  return true;
}

/** A device's end-to-end link; it rejects with the machine's refusal. */
async function open(port: number, device: KeyPair, machineKey: Uint8Array, trust: DeviceTrust = { kind: "pinned", machineKey }) {
  const s = await socket(port);
  const hs = await startHandshake({ device, deviceName: "browser", trust });
  s.ws.send(hs.hello);
  const { session } = await hs.finish((await s.next()) ?? new Uint8Array());
  return {
    async request(id: string, body: Parameters<typeof create<typeof FrameSchema>>[1]): Promise<Frame> {
      s.ws.send(session.seal(create(FrameSchema, { id, ...body })));
      for (;;) {
        const f = session.open((await s.next()) ?? new Uint8Array());
        if (f.id === id) return f;
      }
    },
    close: () => s.ws.close(),
  };
}

/** A code no authenticator with `secret` shows within two steps of now. */
function wrongCode(secret: Uint8Array): string {
  const step = totpStep(Date.now());
  const near = new Set([-2, -1, 0, 1, 2].map((d) => totpCodeAt(secret, step + d)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, "0");
    if (!near.has(code)) return code;
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

async function start(config: ConfigStore): Promise<{ machine: Machine; port: number; paired: number[] }> {
  const machine = new Machine({ config, providers: [fakeProvider()], log: () => undefined });
  running = machine;
  const port = await machine.start(0);
  const paired: number[] = [];
  machine.setNotifyPaired(() => paired.push(Date.now()));
  return { machine, port, paired };
}

function installDeps(): InstallDeps {
  return {
    readSecret: async () => "",
    signIn: async () => undefined,
    isRunning: async () => false,
    stopService: async () => undefined,
    startService: async () => undefined,
    installService: async () => "launchd",
    checkService: async () => undefined,
    keepRunningLoggedOut: async () => null,
    ensureMachineKey: async () => undefined,
    serviceDiskAccess: async () => "not-applicable",
    openDiskAccessSettings: () => undefined,
    log: () => undefined,
  };
}

describe("a device paired by the authenticator code", () => {
  test("is announced to the account's devices once; a wrong code is not", async () => {
    dir = mkdtempSync(join(tmpdir(), "tunelo-pairing-"));
    const config = new ConfigStore(dir);
    const secret = generateTotpSecret();
    config.setTotpSecret(secret);
    const { port, paired } = await start(config);

    expect(await pairByCode(port, await generateKeyPair(), wrongCode(secret))).toBe(false);
    expect(paired).toHaveLength(0);

    const device = await generateKeyPair();
    expect(await pairByCode(port, device, totpCode(secret))).toBe(true);
    await until(() => paired.length === 1);
    expect(config.deviceStatus(device.publicKey)).toBe("paired");
  });
});

describe("the shared lock on wrong codes", () => {
  test("holds when wrong codes arrive on many connections at once", async () => {
    dir = mkdtempSync(join(tmpdir(), "tunelo-lockout-"));
    const config = new ConfigStore(dir);
    const secret = generateTotpSecret();
    config.setTotpSecret(secret);
    const { port, paired } = await start(config);

    // Eight devices (the most the machine lets handshake at once) send a wrong code together.
    const devices = await Promise.all(
      Array.from({ length: 8 }, async () => ({
        s: await socket(port),
        p: await pakeStart({ code: wrongCode(secret), deviceKey: (await generateKeyPair()).publicKey, deviceName: "x" }),
      })),
    );
    for (const { s, p } of devices) s.ws.send(encodePlain({ case: "pakeStart", value: p.start }));
    const answers = await Promise.all(devices.map(async ({ s }) => decodePlain((await s.next()) ?? new Uint8Array()).body));
    for (const { s } of devices) s.ws.close();
    const replied = answers.filter((b) => b.case === "pakeReply").length;
    const locked = answers.filter((b) => b.case === "error" && b.value.code === HandshakeErrorCode.TOO_MANY_ATTEMPTS).length;
    expect({ replied, locked }).toEqual({ replied: 5, locked: 3 });

    // Locked for everyone now, the right code too.
    const s = await socket(port);
    const right = await pakeStart({ code: totpCode(secret), deviceKey: (await generateKeyPair()).publicKey, deviceName: "x" });
    s.ws.send(encodePlain({ case: "pakeStart", value: right.start }));
    const answer = decodePlain((await s.next()) ?? new Uint8Array()).body;
    expect(answer.case === "error" && answer.value.code).toBe(HandshakeErrorCode.TOO_MANY_ATTEMPTS);
    expect(paired).toHaveLength(0);
  });
});

describe("running `tunelo install --trust` again", () => {
  test("lets a new browser in when every device and the authenticator are lost, without announcing it", async () => {
    dir = mkdtempSync(join(tmpdir(), "tunelo-reinstall-"));
    const config = new ConfigStore(dir);
    // A machine already added and in use: its devices and authenticator are gone.
    const lostPhone = await generateKeyPair();
    const lostSecret = generateTotpSecret();
    config.addDevice(lostPhone.publicKey, "lost phone");
    config.setTotpSecret(lostSecret);
    config.update((c) => {
      c.machineId = "5";
      c.machineSecret = "o".repeat(43);
      c.claimed = true;
    });

    // A new browser shows the install command; the owner runs it on the machine.
    const browser = await generateKeyPair();
    const installSecret = crypto.getRandomValues(new Uint8Array(32));
    const deps = installDeps();
    deps.readSecret = async () => `${toBase64Url(installSecret)}\n`;
    await install(dir, { trust: toBase64Url(browser.publicKey) }, deps);

    const { machine, port, paired } = await start(new ConfigStore(dir));
    // A stranger is still refused; the install's browser gets in.
    await expect(open(port, await generateKeyPair(), machine.publicKey)).rejects.toThrow(HandshakeFailure);
    const link = await open(port, browser, machine.publicKey, { kind: "install", secret: installSecret });
    // From that browser the owner sets a new authenticator secret; the lost one stops pairing.
    const fresh = generateTotpSecret();
    const set = await link.request("1", { body: { case: "totpSet", value: { secret: fresh } } });
    expect(set.body).toMatchObject({ case: "totpStatus", value: { enabled: true } });
    link.close();
    const store = new ConfigStore(dir);
    expect(store.deviceStatus(browser.publicKey)).toBe("paired");
    expect(store.get().install).toBeUndefined();
    // The owner ran the command on the machine: no "new device" push.
    expect(paired).toHaveLength(0);
    // Unless the two secrets happen to show the same code right now.
    if (totpCode(lostSecret) !== totpCode(fresh)) expect(await pairByCode(port, await generateKeyPair(), totpCode(lostSecret))).toBe(false);
    expect(await pairByCode(port, await generateKeyPair(), totpCode(fresh))).toBe(true);
  });

  test("the install's secret only works for the browser it names", async () => {
    dir = mkdtempSync(join(tmpdir(), "tunelo-reinstall-"));
    const browser = await generateKeyPair();
    const installSecret = crypto.getRandomValues(new Uint8Array(32));
    const deps = installDeps();
    deps.readSecret = async () => `${toBase64Url(installSecret)}\n`;
    await install(dir, { trust: toBase64Url(browser.publicKey) }, deps);
    const { machine, port } = await start(new ConfigStore(dir));
    const other = await generateKeyPair();
    const refused = await open(port, other, machine.publicKey, { kind: "install", secret: installSecret }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(HandshakeFailure);
    expect((refused as HandshakeFailure).code).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
  });
});

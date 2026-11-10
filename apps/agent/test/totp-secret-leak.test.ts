// The authenticator secret a paired device sets stays on the machine: it is
// kept in config.json only, and none of the agent's calls to the chat server
// (adding the machine, heartbeat, "needs you" and "new device paired"
// pushes) nor any log line carries it, in any usual encoding. The "new
// device paired" push names no device either. Runs the real Machine over a real WebSocket and
// the real machine-api calls against a stubbed fetch.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { type Frame, FrameSchema, type ThreadSummary, ThreadSummarySchema } from "@achoo254/chat-proto/remote/remote";
import {
  base32Encode,
  decodePlain,
  encodePlain,
  generateKeyPair,
  generateTotpSecret,
  pakeStart,
  startHandshake,
  toBase64Url,
  totpCode,
} from "@achoo254/chat-remote-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { ConfigStore } from "../src/config.ts";
import { Machine } from "../src/machine.ts";
import { fakeProvider } from "./fake-provider.ts";

process.env.TUNELO_KEYSTORE = "file";

vi.mock("@tunelo/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tunelo/client")>();
  return {
    ...real,
    linkMachineToApp: async () => {
      throw new real.SelfLinkError(503, null);
    },
  };
});

vi.mock("../src/tunnel.ts", () => ({
  TUNNEL_SERVER: "https://tunnel.example",
  isSignedIn: () => true,
  openTunnel: (_opts: unknown, events: { onUrl: (url: string, features: string[]) => void }) => {
    events.onUrl("wss://m-0.tunnel.hoandat.com", []);
    return () => undefined;
  },
}));

vi.mock("../src/identity/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/identity/session.ts")>()),
  identitySession: () => ({
    info: () => ({ issuer: "https://auth.example", sub: "acc_1", clientId: "tunelo-agent" }),
    covers: () => true,
    getAppToken: async () => "access-token",
  }),
}));

const { goOnline } = await import("../src/online.ts");

type Call = { url: string; headers: string; body: string };

let dir = "";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A paired device's sealed link to the machine on its local port. */
async function deviceLink(port: number, machineKey: Uint8Array, config: ConfigStore) {
  const device = await generateKeyPair();
  config.addDevice(device.publicKey, "phone");
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "nodebuffer";
  const inbox: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (d: Buffer) => {
    inbox.push(new Uint8Array(d));
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = async (): Promise<Uint8Array> => {
    for (;;) {
      const d = inbox.shift();
      if (d) return d;
      await new Promise<void>((r) => (wake = r));
    }
  };
  const hs = await startHandshake({ device, deviceName: "phone", trust: { kind: "pinned", machineKey } });
  ws.send(hs.hello);
  const { session } = await hs.finish(await next());
  return {
    async request(id: string, body: Parameters<typeof create<typeof FrameSchema>>[1]): Promise<Frame> {
      ws.send(session.seal(create(FrameSchema, { id, ...body })));
      for (;;) {
        const f = session.open(await next());
        if (f.id === id) return f;
      }
    },
    close: () => ws.close(),
  };
}

/** A new device pairs by the authenticator code over the machine's local port. */
async function pairByCode(port: number, deviceKey: Uint8Array, deviceName: string, code: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "nodebuffer";
  const replies: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (d: Buffer) => {
    replies.push(new Uint8Array(d));
    wake?.();
  });
  const closed = new Promise<void>((r) => ws.once("close", () => r()));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const p = await pakeStart({ code, deviceKey, deviceName });
  ws.send(encodePlain({ case: "pakeStart", value: p.start }));
  while (replies.length === 0) await new Promise<void>((r) => (wake = r));
  const reply = decodePlain(replies[0] ?? new Uint8Array());
  if (reply.body.case !== "pakeReply") throw new Error(`unexpected ${reply.body.case}`);
  const { finish } = await p.finish(reply.body.value);
  ws.send(encodePlain({ case: "pakeFinish", value: finish }));
  await closed;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("the authenticator secret never leaves the machine", () => {
  test("not in a call to the chat server, a log line or the consent log", async () => {
    dir = mkdtempSync(join(tmpdir(), "tunelo-totp-"));
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: JSON.stringify(init?.headers ?? {}), body: typeof init?.body === "string" ? init.body : "" });
      const answer = url.endsWith("/RegisterMachine") ? { machineId: "7", machineSecret: "s".repeat(43) } : {};
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    });
    const printed: string[] = [];
    for (const method of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")));
    }
    const logs: string[] = [];
    const config = new ConfigStore(dir);
    const machine = new Machine({ config, providers: [fakeProvider()], log: (l) => logs.push(l) });
    const port = await machine.start(0);
    const secret = generateTotpSecret();
    const newcomer = await generateKeyPair();
    try {
      const link = await deviceLink(port, machine.publicKey, config);
      const set = await link.request("1", { body: { case: "totpSet", value: { secret } } });
      expect(set.body).toMatchObject({ case: "totpStatus", value: { enabled: true } });
      expect((await machine.machineInfo()).totpEnabled).toBe(true);
      link.close();

      // Online: the machine is added, beats, and asks for a "needs you" push.
      let notify: ((thread: ThreadSummary, pending: number) => void) | undefined;
      const setNotify = machine.setNotify.bind(machine);
      vi.spyOn(machine, "setNotify").mockImplementation((fn) => {
        notify = fn;
        setNotify(fn);
      });
      const online = goOnline(machine, port, (l) => logs.push(l));
      try {
        await until(() => calls.some((c) => c.url.endsWith("/Heartbeat")));
        notify?.(create(ThreadSummarySchema, { id: "t_1" }), 1);
        await until(() => calls.some((c) => c.url.endsWith("/NotifyNeedsInput")));
        // A device paired by the code: the account's devices hear of it, without its name or key.
        await pairByCode(port, newcomer.publicKey, "Bob's work laptop", totpCode(secret));
        await until(() => calls.some((c) => c.body.includes("DEVICE_PAIRED")));
        const pairedCall = calls.find((c) => c.body.includes("DEVICE_PAIRED"));
        expect(JSON.parse(pairedCall?.body ?? "{}")).toEqual({ kind: "NEEDS_INPUT_KIND_DEVICE_PAIRED", pendingCount: 1, sessionId: "" });
        expect(pairedCall?.url.endsWith("/NotifyNeedsInput")).toBe(true);
      } finally {
        online.stop();
      }
    } finally {
      await machine.stop();
    }

    expect(calls.map((c) => c.url.split("/").at(-1))).toEqual(expect.arrayContaining(["RegisterMachine", "Heartbeat", "NotifyNeedsInput"]));
    const hex = Buffer.from(secret).toString("hex");
    const encodings = [toBase64Url(secret), Buffer.from(secret).toString("base64"), base32Encode(secret), hex, hex.toUpperCase()];
    const sent = calls.map((c) => `${c.url}\n${c.headers}\n${c.body}`).join("\n");
    const logged = [...logs, ...printed].join("\n");
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
    for (const e of encodings) {
      expect(sent).not.toContain(e);
      expect(logged).not.toContain(e);
      expect(audit).not.toContain(e);
    }
    const newcomerKey = [toBase64Url(newcomer.publicKey), Buffer.from(newcomer.publicKey).toString("base64"), Buffer.from(newcomer.publicKey).toString("hex")];
    for (const e of [...newcomerKey, "Bob", toBase64Url(newcomer.publicKey).slice(0, 8)]) expect(sent).not.toContain(e);
    expect(audit).toContain('"action":"pair"');
    expect(audit).toContain('"action":"totp_set"');
    // Kept only in the machine's own config, readable by its owner alone.
    expect(readFileSync(config.file, "utf8")).toContain(toBase64Url(secret));
    if (process.platform !== "win32") expect(statSync(config.file).mode & 0o777).toBe(0o600);
  });
});

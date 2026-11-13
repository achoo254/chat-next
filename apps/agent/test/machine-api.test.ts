// The calls to Chat's machine API, against a local stand-in: registering
// proves the machine key with the challenge sent back as it came, the
// heartbeat reports the connected devices and reads the trusted ones (bad
// keys left out, int64 as strings), and logout's UnregisterMachine.
import { type IncomingMessage, type Server, createServer } from "node:http";
import { type KeyPair, generateKeyPair, proveKeyPossession, toBase64Url } from "@achoo254/chat-remote-protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

type Call = { method: string; auth: string; body: Record<string, unknown> };
const calls: Call[] = [];
let answer: (method: string, body: Record<string, unknown>) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
let server: Server;
let serverKey: KeyPair;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function read(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  serverKey = await generateKeyPair();
  server = createServer((req, res) => {
    void read(req).then((body) => {
      const method = (req.url ?? "").split("/").at(-1) ?? "";
      calls.push({ method, auth: String(req.headers.authorization ?? ""), body });
      const a = answer(method, body);
      res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  process.env.TUNELO_CHAT_SERVER = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => {
  delete process.env.TUNELO_CHAT_SERVER;
  server.close();
});

const api = () => import("../src/machine-api.ts");

describe("machine API", () => {
  test("registers with a proof that it holds the machine key", async () => {
    const { registerMachine } = await api();
    const machine = await generateKeyPair();
    const nonce = new Uint8Array(32).fill(7);
    const challenge = { serverKey: b64(serverKey.publicKey), nonce: b64(nonce), expiresAt: "1900000000" };
    answer = (method) => (method === "GetMachineKeyChallenge" ? { status: 200, json: { challenge } } : { status: 200, json: { machineId: "12", machineSecret: "s".repeat(43) } });
    calls.length = 0;
    expect(await registerMachine("tok", machine, "3.0.0", "mac")).toEqual({ machineId: "12", machineSecret: "s".repeat(43) });
    expect(calls.map((c) => [c.method, c.auth])).toEqual([
      ["GetMachineKeyChallenge", "Bearer tok"],
      ["RegisterMachine", "Bearer tok"],
    ]);
    const reg = calls[1]?.body as { publicKey: string; name: string; agentVersion: string; proof: { challenge: unknown; mac: string } };
    expect(reg.publicKey).toBe(b64(machine.publicKey));
    expect([reg.name, reg.agentVersion]).toEqual(["mac", "3.0.0"]);
    expect(reg.proof.challenge).toEqual(challenge);
    // The server's side of the same Diffie-Hellman gives the same mac.
    expect(reg.proof.mac).toBe(b64(await proveKeyPossession(serverKey.privateKey, { serverKey: machine.publicKey, nonce })));
  });

  test("a malformed challenge or answer is an error, and no proof is sent", async () => {
    const { registerMachine, MachineApiError } = await api();
    answer = () => ({ status: 200, json: { challenge: { serverKey: "AAAA", nonce: "AAAA" } } });
    calls.length = 0;
    await expect(registerMachine("tok", await generateKeyPair(), "3.0.0")).rejects.toBeInstanceOf(MachineApiError);
    expect(calls.map((c) => c.method)).toEqual(["GetMachineKeyChallenge"]);
    answer = () => ({ status: 403, json: { code: "permission_denied", message: "bad_key_proof: the proof does not check" } });
    const err = await registerMachine("tok", await generateKeyPair(), "3.0.0").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MachineApiError);
    expect((err as InstanceType<typeof MachineApiError>).reason).toBe("bad_key_proof");
  });

  test("the heartbeat sends the connected keys and reads the trusted devices", async () => {
    const { heartbeat } = await api();
    const good = new Uint8Array(32).fill(4);
    answer = () => ({
      status: 200,
      json: {
        minAgentVersion: "3.0.0",
        trustedDevices: [
          { publicKey: b64(good), name: "phone", platform: "ios", createdAt: "1731400000" },
          { publicKey: b64(new Uint8Array(31)), name: "short" },
          { name: "no key" },
        ],
      },
    });
    calls.length = 0;
    const r = await heartbeat("secret", { tunnelUrl: "wss://x", agentVersion: "3.0.0", connectedDeviceKeys: Array.from({ length: 60 }, () => good) });
    expect(r).toEqual({
      revoked: false,
      minAgentVersion: "3.0.0",
      tunnelRefused: false,
      trustedDevices: [{ key: toBase64Url(good), name: "phone", platform: "ios", createdAt: 1_731_400_000_000 }],
    });
    expect(calls[0]?.auth).toBe("Bearer secret");
    expect((calls[0]?.body.connectedDeviceKeys as string[]).length).toBe(50);
  });

  test("a needs-you push names the waiting thread's AI, never its content", async () => {
    const { notifyNeedsInput } = await api();
    answer = () => ({ status: 200, json: {} });
    calls.length = 0;
    await notifyNeedsInput("secret", { kind: "question", pendingCount: 2, sessionId: "t_1", providerId: "antigravity" });
    expect(calls).toEqual([
      { method: "NotifyNeedsInput", auth: "Bearer secret", body: { kind: "NEEDS_INPUT_KIND_QUESTION", pendingCount: 2, sessionId: "t_1", providerId: "antigravity" } },
    ]);
  });

  test("unregisters with the machine secret", async () => {
    const { unregisterMachine } = await api();
    answer = () => ({ status: 200, json: {} });
    calls.length = 0;
    await unregisterMachine("secret");
    expect(calls).toEqual([{ method: "UnregisterMachine", auth: "Bearer secret", body: {} }]);
  });
});

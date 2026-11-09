// End to end on one machine: a stand-in for the tunnel server (it accepts
// the machine tunnel, names the `local-forward` feature or not, and sends
// requests down the tunnel the way the gating server does), the real tunnel
// client of openTunnel, the machine's local server, and an app on loopback.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientToServerMessage, TunnelRequest } from "@tunelo/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ConfigStore } from "../../src/config.ts";
import { DEV_CUSTOM_SERVER_ENV } from "../../src/identity/credentials.ts";
import { identitySession } from "../../src/identity/session.ts";
import { Machine } from "../../src/machine.ts";
import { fakeProvider } from "../fake-provider.ts";
import { fakeJwt } from "../support/fake-idp.ts";

const SUBDOMAIN = "m-00000000000000000000000000000b";

type Answer = { status: number; headers: Record<string, string | string[]>; body: string };

/** The stand-in tunnel server: one machine socket, requests sent by the test. */
async function standIn(features: string[] | undefined) {
  let socket: WebSocket | undefined;
  let connected: () => void = () => undefined;
  const ready = new Promise<void>((r) => (connected = r));
  const answers = new Map<string, { status: number; headers: Record<string, string | string[]>; chunks: Buffer[]; done: (a: Answer) => void }>();
  const auths: Record<string, unknown>[] = [];
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, path: "/tunnel" });
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ClientToServerMessage;
      if (msg.type === "auth") {
        auths.push(msg as unknown as Record<string, unknown>);
        ws.send(JSON.stringify({ type: "auth-result", success: true, subdomain: SUBDOMAIN, url: `https://${SUBDOMAIN}.tunnel.example.com`, ...(features ? { features } : {}) }));
        connected();
      } else if (msg.type === "stream-start") {
        const a = answers.get(msg.id);
        if (a) {
          a.status = msg.status;
          a.headers = msg.headers;
        }
      } else if (msg.type === "stream-data") {
        answers.get(msg.id)?.chunks.push(Buffer.from(msg.data, "base64"));
      } else if (msg.type === "stream-end") {
        const a = answers.get(msg.id);
        a?.done({ status: a.status, headers: a.headers, body: Buffer.concat(a.chunks).toString("utf8") });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let seq = 0;
  return {
    url: `http://127.0.0.1:${port}`,
    ready,
    auths,
    send(path: string, headers: Record<string, string>): Promise<Answer> {
      const id = `r${++seq}`;
      return new Promise((done) => {
        answers.set(id, { status: 0, headers: {}, chunks: [], done });
        const request: TunnelRequest = { type: "request", id, method: "GET", path, headers: { host: `${SUBDOMAIN}.tunnel.example.com`, ...headers }, body: null, subdomain: SUBDOMAIN };
        socket?.send(JSON.stringify(request));
      });
    },
    close: () =>
      new Promise<void>((r) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => r());
      }),
  };
}

const APP = `require("node:http").createServer((q, s) => { s.writeHead(q.url.startsWith("/go") ? 302 : 200, { location: "http://localhost:" + this_port + "/next", "tunelo-forward-error": "TUNELO_FORWARD_003" }); s.end("app " + q.headers.host + " " + q.url + " cookie=" + (q.headers.cookie || "")); }).listen(0, "127.0.0.1", function () { this_port = this.address().port; console.log(this_port); }); var this_port = 0;`;

let dir = "";
let app: ChildProcess;
let appPort = 0;
let machine: Machine;
let closeTunnel: () => void = () => undefined;
let server: Awaited<ReturnType<typeof standIn>> | undefined;
const logs: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-forward-e2e-"));
  process.env[DEV_CUSTOM_SERVER_ENV] = "1";
  app = spawn(process.execPath, ["-e", APP], { stdio: ["ignore", "pipe", "inherit"] });
  appPort = await new Promise<number>((resolve, reject) => {
    app.stdout?.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
    app.once("error", reject);
  });
  logs.length = 0;
});

afterEach(async () => {
  closeTunnel();
  await machine.stop();
  await server?.close();
  app.kill();
  Reflect.deleteProperty(process.env, DEV_CUSTOM_SERVER_ENV);
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

/** The machine online through the stand-in, as online.ts wires it. */
async function online(features: string[] | undefined) {
  server = await standIn(features);
  vi.stubEnv("CHAT_AGENT_TUNNEL_SERVER", server.url);
  vi.resetModules();
  const { openTunnel } = await import("../../src/tunnel.ts");
  await identitySession(dir).adopt(
    { issuer: "https://auth.example", sub: "acc_e2e", refreshToken: "rt", accessToken: fakeJwt("acc_e2e"), accessTokenExpiresAt: Date.now() + 3_600_000 },
    "https://tunnel.example",
  );
  machine = new Machine({ config: new ConfigStore(dir), providers: [fakeProvider()], log: (l) => logs.push(l) });
  const port = await machine.start(0);
  let up: () => void = () => undefined;
  const connected = new Promise<void>((r) => (up = r));
  closeTunnel = openTunnel(
    { dir, localPort: port, deviceId: "chat-agent.1" },
    {
      onUrl: (url, f) => {
        machine.localForward.tunnelConnected(url, f);
        up();
      },
      onDown: () => machine.localForward.tunnelDisconnected(),
      onFatal: (code, message) => logs.push(`fatal ${code} ${message}`),
      log: (l) => logs.push(l),
    },
  );
  await server.ready;
  await connected;
  return server;
}

describe("Localman's requests through the machine tunnel", () => {
  test("a granted request reaches the app as localhost; its tunelo-* headers and own address never come back", async () => {
    const s = await online(["local-forward"]);
    const r = await s.send("/.tunelo/forward/hello?x=1", { "tunelo-forward-granted": "1", "tunelo-local-port": String(appPort), cookie: "sid=cookie-secret" });
    expect(r.status).toBe(200);
    expect(r.body).toBe(`app localhost:${appPort} /hello?x=1 cookie=sid=cookie-secret`);
    expect(Object.keys(r.headers).filter((h) => h.toLowerCase().startsWith("tunelo-"))).toEqual([]);
    expect(r.headers.location).toBe("/.tunelo/forward/next");
    expect(logs.join("\n")).toContain(`local forward GET :${appPort} /hello → 200`);
    expect(logs.join("\n")).not.toContain("cookie-secret");
  });

  test("the machine tunnel signs in as a machine without naming a local port", async () => {
    const s = await online(["local-forward"]);
    expect(s.auths).toHaveLength(1);
    // It asks for no name: the relay derives it from the account and the device id.
    expect(s.auths[0]).toEqual(expect.objectContaining({ kind: "machine", deviceId: "chat-agent.1", subdomain: "" }));
    expect(s.auths[0]).not.toHaveProperty("localPort");
    // Requests still reach the device link's server.
    const r = await s.send("/.tunelo/forward/", { "tunelo-forward-granted": "1", "tunelo-local-port": String(appPort) });
    expect(r.status).toBe(200);
  });

  test("the request with no grant, and every request when the server did not name the feature, is refused", async () => {
    const s = await online(["local-forward"]);
    const r = await s.send("/.tunelo/forward/", { "tunelo-local-port": String(appPort) });
    expect([r.status, r.headers["tunelo-forward-error"]]).toEqual([404, "TUNELO_FORWARD_001"]);
    closeTunnel();
    await machine.stop();
    await s.close();
    const old = await online(undefined);
    const o = await old.send("/.tunelo/forward/", { "tunelo-forward-granted": "1", "tunelo-local-port": String(appPort) });
    expect([o.status, o.headers["tunelo-forward-error"]]).toEqual([404, "TUNELO_FORWARD_001"]);
  });

  test("turned off, Localman gets 403 TUNELO_FORWARD_003 through the tunnel", async () => {
    const s = await online(["local-forward"]);
    await machine.localForward.setEnabled(false, "local");
    const r = await s.send("/.tunelo/forward/", { "tunelo-forward-granted": "1", "tunelo-local-port": String(appPort) });
    expect([r.status, r.headers["tunelo-forward-error"]]).toEqual([403, "TUNELO_FORWARD_003"]);
  });
});

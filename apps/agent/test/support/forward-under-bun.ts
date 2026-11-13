// Run with Bun (the runtime of the released tunelo), from
// test/tunnels/forward-under-bun.test.ts: the forward path's behaviours that
// differ between Bun's node:http and Node's. Prints one JSON object of
// results by scenario and exits 0; the test checks them.
import { type IncomingMessage, type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForwardDenyList } from "../../src/tunnels/forward-deny-ports.ts";
import { LocalForward } from "../../src/tunnels/forward.ts";
import { ForwardSettings } from "../../src/tunnels/forward-settings.ts";

const HOST = "m-0000000000000000000000000000cc.tunnel.example.com";
const dir = mkdtempSync(join(tmpdir(), "tunelo-bun-forward-"));
const logs: string[] = [];
const appClosed: string[] = [];
const results: Record<string, unknown> = {};

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
}

const app = createServer((req, res) => {
  const url = req.url ?? "/";
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (url.startsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      req.socket.once("close", () => appClosed.push(url));
      return;
    }
    if (url.startsWith("/big")) return void res.end("x".repeat(5000));
    res.end(`app ${req.headers.host} ${req.method} ${url} ${Buffer.concat(chunks).length}`);
  });
});
const appPort = await listen(app);
const v6 = createServer((req, res) => res.end(`v6 ${req.headers.host}`));
const v6Port = await listen(v6, "::1");

const forward = new LocalForward({
  settings: new ForwardSettings(dir),
  log: (l) => logs.push(l),
  maxRequestBytes: 10,
  maxResponseBytes: 100,
  deny: new ForwardDenyList({ configDir: dir, ownPorts: () => [], extraPorts: () => [], listening: async () => [], processes: async () => [], runs: () => [], ideLockDirs: () => [] }),
});
forward.tunnelConnected(`wss://${HOST}/`, ["local-forward"]);
const front = createServer((req, res) => {
  if (!forward.handle(req, res)) res.writeHead(426).end();
});
const frontPort = await listen(front);

type Answer = { status: number; body: string };
function send(path: string, port: number, body?: string[]): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: frontPort, path, method: body ? "POST" : "GET", headers: { host: HOST, "tunelo-forward-granted": "1", "tunelo-local-port": String(port) } }, (res: IncomingMessage) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    for (const part of body ?? []) req.write(part);
    req.end();
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (check()) return true;
  return check();
}

results.basic = await send("/.tunelo/forward/a?b=1", appPort);
results.ipv6 = await send("/.tunelo/forward/", v6Port);
results.uppercase = await send("/.TUNELO/FORWARD/up", appPort);
results.chunkedTooLarge = await send("/.tunelo/forward/", appPort, ["a".repeat(8), "b".repeat(8)]);

logs.length = 0;
await send("/.tunelo/forward/big", appPort).catch(() => undefined);
await wait(100);
results.cutOff = { cut: logs.some((l) => l.includes("→ cut off: response too large")), callerLeft: logs.some((l) => l.includes("caller left")) };

logs.length = 0;
await new Promise<void>((resolve) => {
  const req = request({ host: "127.0.0.1", port: frontPort, path: "/.tunelo/forward/stream", headers: { host: HOST, "tunelo-forward-granted": "1", "tunelo-local-port": String(appPort) } }, (res) => {
    res.once("data", () => {
      req.destroy();
      resolve();
    });
  });
  req.on("error", () => undefined);
  req.end();
});
results.callerLeft = { appClosed: await until(() => appClosed.length > 0, 2000), logged: logs.some((l) => l.includes("/stream → caller left")) };

console.log(JSON.stringify(results));
for (const s of [front, app, v6]) s.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);

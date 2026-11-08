// Localman's requests for localhost through the machine tunnel: only what the
// gating tunnel server let through this very tunnel is served, to 127.0.0.1
// with Host localhost:<port>; refused ports (shared list, tunelo's own, IDE
// locks, debug ports, the user's) never are; the app cannot fake a refusal
// or send the caller off the forward path; nothing secret reaches the log.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { ForwardDenyList } from "../../src/tunnels/forward-deny-ports.ts";
import { LocalForward, appPath, headersForApp, loggedPath, rewriteLocation } from "../../src/tunnels/forward.ts";
import type { ListeningPort, ProcessLine } from "../../src/tunnels/listening-ports.ts";

const TUNNEL_HOST = "m-0123456789abcdef0123456789abcd.tunnel.example.com";
const GRANTED = { host: TUNNEL_HOST, "tunelo-forward-granted": "1" };

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };

let dir = "";
let app: Server;
let appPort = 0;
let front: Server;
let frontPort = 0;
let seen: Seen[] = [];
let logs: string[] = [];
let forward: LocalForward;
let config: ConfigStore;
let listening: ListeningPort[] = [];
let processes: ProcessLine[] = [];
let claudeHome = "";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const s = createServer();
  const p = await listen(s);
  await close(s);
  return p;
}

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };

function send(path: string, headers: Record<string, string>, opts: { method?: string; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: frontPort, path, method: opts.method ?? "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

function makeForward(extra: { maxRequestBytes?: number; timeoutMs?: number } = {}): LocalForward {
  return new LocalForward({
    config,
    audit: new AuditLog(join(dir, "audit.jsonl")),
    log: (line) => logs.push(line),
    deny: new ForwardDenyList({
      configDir: dir,
      ownPorts: () => [frontPort],
      extraPorts: () => config.get().localForwardBlockedPorts ?? [],
      listening: async () => listening,
      processes: async () => processes,
      runs: () => [],
      claudeHomes: () => [claudeHome],
    }),
    ...extra,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-forward-"));
  claudeHome = join(dir, "claude-home");
  config = new ConfigStore(dir);
  seen = [];
  logs = [];
  listening = [];
  processes = [];
  app = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = req.url ?? "/";
      if (url.startsWith("/redirect")) {
        const to = new URL(url, "http://x").searchParams.get("to") ?? "/";
        res.writeHead(302, { location: to }).end();
        return;
      }
      if (url.startsWith("/hang")) return; // never answers
      res.writeHead(200, {
        "content-type": "text/plain",
        "tunelo-forward-error": "TUNELO_FORWARD_001",
        "tunelo-anything": "x",
        "x-app": "yes",
      });
      res.end(`hello ${req.method} ${url}`);
    });
  });
  appPort = await listen(app);
  forward = makeForward();
  front = createServer((req, res) => {
    if (!forward.handle(req, res)) res.writeHead(426).end();
  });
  frontPort = await listen(front);
  forward.tunnelConnected(`wss://${TUNNEL_HOST}/`, ["local-forward"]);
});

afterEach(async () => {
  await close(app);
  await close(front);
  rmSync(dir, { recursive: true, force: true });
});

const port = () => String(appPort);

describe("who gets served", () => {
  test("without the grant, or with anything but exactly 1, the answer is 404 TUNELO_FORWARD_001 and the app sees nothing", async () => {
    for (const headers of [
      { host: TUNNEL_HOST, "tunelo-local-port": port() },
      { host: TUNNEL_HOST, "tunelo-forward-granted": "true", "tunelo-local-port": port() },
      { host: TUNNEL_HOST, "tunelo-forward-granted": "1, 1", "tunelo-local-port": port() },
      { host: TUNNEL_HOST, "tunelo-forward-granted": "", "tunelo-local-port": port() },
    ]) {
      const r = await send("/.tunelo/forward/", headers);
      expect(r.status).toBe(404);
      expect(r.headers["tunelo-forward-error"]).toBe("TUNELO_FORWARD_001");
      expect(JSON.parse(r.body)).toEqual({ error: { code: "TUNELO_FORWARD_001", message: "Not found" } });
    }
    expect(seen).toEqual([]);
  });

  test("a request that did not come through the tunnel (another Host) is refused, grant or not", async () => {
    for (const host of ["localhost", `127.0.0.1:${frontPort}`, "evil.example", `${TUNNEL_HOST}.evil.example`]) {
      const r = await send("/.tunelo/forward/", { ...GRANTED, host, "tunelo-local-port": port() });
      expect(r.status).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  test("a tunnel server that did not name local-forward, or no tunnel at all, serves nothing", async () => {
    forward.tunnelConnected(`wss://${TUNNEL_HOST}/`, []);
    expect((await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": port() })).status).toBe(404);
    forward.tunnelConnected(`wss://${TUNNEL_HOST}/`, ["local-forward"]);
    forward.tunnelDisconnected();
    expect((await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": port() })).status).toBe(404);
    expect(seen).toEqual([]);
    expect(forward.state().available).toBe(false);
  });

  test("paths outside the forward path are not this handler's", async () => {
    const r = await send("/.tunelo/forwarded", GRANTED);
    expect(r.status).toBe(426);
    expect((await send("/", GRANTED)).status).toBe(426);
  });

  test("turned off: 403 TUNELO_FORWARD_003, written to the consent log; on again serves", async () => {
    forward.setEnabled(false, "phone (abc)");
    const r = await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": port() });
    expect(r.status).toBe(403);
    expect(r.headers["tunelo-forward-error"]).toBe("TUNELO_FORWARD_003");
    expect((await send("/.tunelo/forward/ports", GRANTED)).status).toBe(403);
    expect(new ConfigStore(dir).get().localForward).toBe(false);
    forward.setEnabled(true, "local");
    expect((await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": port() })).status).toBe(200);
    const audit = new AuditLog(join(dir, "audit.jsonl")).list(10);
    expect(audit.map((e) => [e.device, e.action, e.detail])).toEqual([
      ["local", "local_forward", "on"],
      ["phone (abc)", "local_forward", "off"],
    ]);
  });

  test("not a port: 400 TUNELO_FORWARD_004; no port outside /ports: 400 too", async () => {
    for (const bad of ["abc", "0", "65536", "+80", "80, 9222"]) {
      const r = await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": bad });
      expect([r.status, r.headers["tunelo-forward-error"]]).toEqual([400, "TUNELO_FORWARD_004"]);
    }
    const r = await send("/.tunelo/forward/api", GRANTED);
    expect([r.status, r.headers["tunelo-forward-error"]]).toEqual([400, "TUNELO_FORWARD_004"]);
  });

  test("nothing listening: 502 TUNELO_FORWARD_005", async () => {
    const r = await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": String(await freePort()) });
    expect(r.status).toBe(502);
    expect(r.headers["tunelo-forward-error"]).toBe("TUNELO_FORWARD_005");
  });
});

describe("refused ports: 403 TUNELO_FORWARD_002", () => {
  const blocked = async (p: number) => {
    const r = await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": String(p) });
    return [r.status, r.headers["tunelo-forward-error"]];
  };

  test("the shared list and tunelo's own port", async () => {
    expect(await blocked(9222)).toEqual([403, "TUNELO_FORWARD_002"]);
    expect(await blocked(2375)).toEqual([403, "TUNELO_FORWARD_002"]);
    expect(await blocked(frontPort)).toEqual([403, "TUNELO_FORWARD_002"]);
  });

  test("a Claude Code IDE lock, a debug port of a running process, a port of a tunelo process, a port the user added", async () => {
    mkdirSync(join(claudeHome, "ide"), { recursive: true });
    writeFileSync(join(claudeHome, "ide", `${appPort}.lock`), "{}");
    expect(await blocked(appPort)).toEqual([403, "TUNELO_FORWARD_002"]);
    rmSync(join(claudeHome, "ide"), { recursive: true });

    const fresh = () => {
      forward = makeForward();
      forward.tunnelConnected(`wss://${TUNNEL_HOST}/`, ["local-forward"]);
    };
    fresh();
    processes = [{ pid: 4242, command: `node --inspect=127.0.0.1:${appPort} server.js` }];
    expect(await blocked(appPort)).toEqual([403, "TUNELO_FORWARD_002"]);

    fresh();
    processes = [];
    listening = [{ port: appPort, pid: 777, name: "tunelo" }];
    expect(await blocked(appPort)).toEqual([403, "TUNELO_FORWARD_002"]);

    fresh();
    listening = [];
    forward.setBlocked([appPort], true, "local");
    expect(await blocked(appPort)).toEqual([403, "TUNELO_FORWARD_002"]);
    forward.setBlocked([appPort], false, "local");
    fresh();
    expect(await blocked(appPort)).toEqual([200, undefined]);
    expect(seen).toHaveLength(1);
  });
});

describe("what the app and the caller see", () => {
  test("the app gets the rest of the path and query, Host localhost:<port>, the body, and no tunelo-* header", async () => {
    const r = await send(`/.tunelo/forward/api/items?q=1`, {
      ...GRANTED,
      "tunelo-local-port": port(),
      "tunelo-access": "tunelo_secret",
      "tunelo-other": "x",
      authorization: "Bearer app-token",
      "content-type": "application/json",
    }, { method: "POST", body: '{"a":1}' });
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello POST /api/items?q=1");
    const got = seen[0];
    expect(got?.headers.host).toBe(`localhost:${appPort}`);
    expect(got?.body).toBe('{"a":1}');
    expect(got?.headers.authorization).toBe("Bearer app-token");
    expect(Object.keys(got?.headers ?? {}).filter((h) => h.startsWith("tunelo-"))).toEqual([]);
    // The app's own tunelo-* headers never reach the caller: it cannot fake a refusal.
    expect(Object.keys(r.headers).filter((h) => h.startsWith("tunelo-"))).toEqual([]);
    expect(r.headers["x-app"]).toBe("yes");
  });

  test("the bare forward path is the app's root, a bare query keeps it", async () => {
    await send("/.tunelo/forward", { ...GRANTED, "tunelo-local-port": port() });
    await send("/.tunelo/forward?x=1", { ...GRANTED, "tunelo-local-port": port() });
    expect(seen.map((s) => s.url)).toEqual(["/", "/?x=1"]);
  });

  test("a redirect to the app itself stays under the forward path; any other is left alone", async () => {
    const cases: [string, string][] = [
      ["/login", "/.tunelo/forward/login"],
      [`http://localhost:${appPort}/a?b=1#c`, "/.tunelo/forward/a?b=1#c"],
      [`http://127.0.0.1:${appPort}/x`, "/.tunelo/forward/x"],
      [`http://127.0.0.1:${appPort + 1}/x`, `http://127.0.0.1:${appPort + 1}/x`],
      ["https://example.com/out", "https://example.com/out"],
      ["next", "next"],
    ];
    for (const [to, expected] of cases) {
      const r = await send(`/.tunelo/forward/redirect?to=${encodeURIComponent(to)}`, { ...GRANTED, "tunelo-local-port": port() });
      expect([r.status, r.headers.location]).toEqual([302, expected]);
    }
  });

  test("GET /ports lists what listens on loopback, without refused ports, names cleaned", async () => {
    listening = [
      { port: 5173, pid: 1, name: "node\u0007" },
      { port: 9222, pid: 2, name: "Chrome" },
      { port: 3000, pid: 3, name: "tunelo" },
      { port: frontPort, pid: process.pid, name: "bun" },
    ];
    const r = await send("/.tunelo/forward/ports", GRANTED);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ports: [{ port: 5173, name: "node" }] });
  });

  test("the log has time-free lines with method, port and path: never a header, a body or the query", async () => {
    await send("/.tunelo/forward/api/me?token=query-secret", {
      ...GRANTED,
      "tunelo-local-port": port(),
      authorization: "Bearer header-secret",
      cookie: "sid=cookie-secret",
    }, { method: "POST", body: "body-secret" });
    await send("/.tunelo/forward/x", { host: TUNNEL_HOST, cookie: "sid=cookie-secret", "tunelo-local-port": port() });
    const all = logs.join("\n");
    expect(all).toContain(`local forward POST :${appPort} /api/me → 200`);
    expect(all).toContain("local forward refused TUNELO_FORWARD_001: GET /x");
    for (const secret of ["query-secret", "header-secret", "cookie-secret", "body-secret", "Bearer", "sid="]) expect(all).not.toContain(secret);
  });
});

describe("limits", () => {
  test("a body over the limit is refused with 413", async () => {
    forward = makeForward({ maxRequestBytes: 10 });
    forward.tunnelConnected(`wss://${TUNNEL_HOST}/`, ["local-forward"]);
    const r = await send("/.tunelo/forward/", { ...GRANTED, "tunelo-local-port": port() }, { method: "POST", body: "x".repeat(1000) });
    expect(r.status).toBe(413);
  });

  test("an app that does not answer in time gets 504", async () => {
    forward = makeForward({ timeoutMs: 200 });
    forward.tunnelConnected(`wss://${TUNNEL_HOST}/`, ["local-forward"]);
    const r = await send("/.tunelo/forward/hang", { ...GRANTED, "tunelo-local-port": port() });
    expect(r.status).toBe(504);
  });
});

describe("helpers", () => {
  test("rewriteLocation keeps other ports, hosts and schemes", () => {
    expect(rewriteLocation("//localhost:80/x", 80)).toBe("/.tunelo/forward/x");
    expect(rewriteLocation("http://localhost/x", 80)).toBe("/.tunelo/forward/x");
    expect(rewriteLocation("https://localhost/x", 80)).toBe("https://localhost/x");
    expect(rewriteLocation("http://[::1]:8080/", 8080)).toBe("/.tunelo/forward/");
    expect(rewriteLocation("ftp://localhost:21/", 21)).toBe("ftp://localhost:21/");
    expect(rewriteLocation("?page=2", 80)).toBe("?page=2");
  });

  test("appPath and loggedPath", () => {
    expect(appPath("/.tunelo/forward")).toBe("/");
    expect(appPath("/.TUNELO/forward/a")).toBe("/a");
    expect(loggedPath("/a/b?token=x#y")).toBe("/a/b");
    expect(loggedPath("/a\nb")).toBe("/ab");
  });

  test("headersForApp drops hop-by-hop headers and those named in Connection", () => {
    const out = headersForApp({ host: "x", connection: "keep-alive, x-private", "x-private": "1", "keep-alive": "5", te: "trailers", "x-ok": "1" }, 3000);
    expect(out).toEqual({ "x-ok": "1", host: "localhost:3000" });
  });
});

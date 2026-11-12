// The control socket runs tunnels and MCP tools with the machine's session
// and must never hand a token to its caller: every command is called here
// and every answer searched for the session's secrets and anything shaped
// like a JWT.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { CONTROL_ROUTES, CONTROL_STREAMS, callControl, serveControl, streamControl } from "../src/control-socket.ts";
import { saveSettings } from "../src/identity/cli-settings.ts";
import { DEV_CUSTOM_SERVER_ENV } from "../src/identity/credentials.ts";
import { identitySession } from "../src/identity/session.ts";
import type { Machine } from "../src/machine.ts";
import { ConfigStore } from "../src/config.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
import { Registration } from "../src/registration-status.ts";
import { TunnelService } from "../src/tunnels/tunnel-service.ts";
import { type FakeTunnelServer, startFakeTunnelServer } from "./support/fake-tunnel-server.ts";
import { fakeJwt } from "./support/fake-idp.ts";
import { waitFor } from "./support/mcp-harness.ts";

const REFRESH = "rt-control-secret";
const ACCESS = fakeJwt("acc_control");
const KEY = "tunelo_control_secret";
const JWT_SHAPE = /eyJ[\w-]{4,}\.[\w-]{4,}\./;

let dir = "";
let stop: () => void = () => undefined;
let server: FakeTunnelServer;
let local: http.Server;
let localPort = 0;
const answers: string[] = [];

let forwardOn = true;
let usageDeletes = 0;
let forwardBlocked: number[] = [];

/** A machine with just what the commands touch. */
function fakeMachine(): Machine {
  const fake = {
    machineInfo: async () => ({ name: "mac", agentVersion: "2.0.0", providers: [], openSessions: 0, maxSessions: 3, memoryMb: 1 }),
    config: {
      get: () => ({ devices: [{ key: "devicekey123456", name: "phone", addedAt: 0 }], trustedDirs: [] }),
      revokeDevice: () => true,
      setTrusted: (d: string) => d,
    },
    dropDevice: () => undefined,
    audit: { write: () => undefined, list: () => [] },
    profiles: {
      list: async () => ({ profiles: [{ id: "", email: "me@example.com", organization: "", plan: "max", signedIn: true, createdAt: 0 }], selectedId: "" }),
      select: (id: string) => {
        if (id === "nope") throw new Error("no such profile");
      },
      prepareTerminal: async () => ({ id: "p1", home: join(dir, "claude-profiles", "p1", "home") }),
      finishTerminal: async () => ({ ok: false, error: "expired" }),
      cancel: async () => undefined,
      remove: async () => undefined,
      refreshUsage: async () => undefined,
    },
    usage: {
      deleteLedger: async () => {
        usageDeletes++;
      },
    },
    localForward: {
      state: () => ({ enabled: forwardOn, available: false, blockedPorts: forwardBlocked }),
      setEnabled: (on: boolean) => {
        forwardOn = on;
        return { enabled: on, available: false, blockedPorts: forwardBlocked };
      },
      setBlocked: (ports: number[], blocked: boolean) => {
        forwardBlocked = blocked ? ports : [];
        return { enabled: forwardOn, available: false, blockedPorts: forwardBlocked };
      },
    },
  };
  // Only the members above are reached by the control routes.
  return fake as unknown as Machine;
}

async function call(method: string, path: string, input?: unknown): Promise<unknown> {
  const out = await callControl(dir, method, path, input).catch((err: Error) => ({ error: err.message }));
  answers.push(JSON.stringify(out));
  return out;
}

beforeAll(async () => {
  // The fake Tunelo server is on loopback: a development server.
  process.env[DEV_CUSTOM_SERVER_ENV] = "1";
  dir = mkdtempSync(join(tmpdir(), "tunelo-control-"));
  server = await startFakeTunnelServer();
  local = http.createServer((_req, res) => res.end("hello"));
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
  const address = local.address();
  localPort = typeof address === "object" && address ? address.port : 0;
  // Signed in for the fake server's own domain (loopback), with a fresh access token on disk.
  await identitySession(dir).adopt(
    { issuer: "https://auth.example", sub: "acc_control", refreshToken: REFRESH, accessToken: ACCESS, accessTokenExpiresAt: Date.now() + 3_600_000 },
    "https://tunnel.example",
  );
  saveSettings({ key: KEY, deviceId: "dev-control" }, dir);
  const registration = new Registration({
    config: new ConfigStore(dir),
    session: identitySession(dir),
    api: {
      register: async () => {
        throw new Error("not reached: the session does not cover Chat");
      },
      claim: async () => undefined,
    },
    publicKey: () => new Uint8Array(32),
    agentVersion: "2.0.0",
    onRegistered: () => undefined,
    log: () => undefined,
  });
  stop = serveControl({ dir, machine: fakeMachine(), registration, tunnels: new TunnelService(dir), mcp: new McpHost(dir, { localWrites: () => true }) });
  await waitFor(() => existsSync(join(dir, "control.json")));
});

afterAll(async () => {
  Reflect.deleteProperty(process.env, DEV_CUSTOM_SERVER_ENV);
  stop();
  await server.close();
  await new Promise<void>((r) => local.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("control socket", () => {
  test("has exactly the commands this test covers", () => {
    expect(Object.keys(CONTROL_ROUTES).sort()).toEqual(
      [
        "GET /apps",
        "GET /audit",
        "GET /claude/profiles",
        "GET /devices",
        "GET /local-forward",
        "GET /status",
        "GET /trust",
        "GET /tunnels",
        "POST /claude/profiles/cancel",
        "POST /claude/profiles/finish",
        "POST /claude/profiles/prepare",
        "POST /claude/profiles/remove",
        "POST /claude/profiles/select",
        "POST /claude/profiles/usage",
        "POST /devices/revoke",
        "POST /local-forward",
        "POST /local-forward/blocked",
        "POST /mcp/call",
        "POST /mcp/tools",
        "POST /registration/retry",
        "POST /restart",
        "POST /streams/alive",
        "POST /trust",
        "POST /totp/enroll",
        "POST /tunnels/close",
        "POST /usage/delete",
      ].sort(),
    );
    expect(Object.keys(CONTROL_STREAMS).sort()).toEqual(["POST /mcp/session", "POST /tunnels/open"]);
  });

  test("refuses a caller without the token of control.json", async () => {
    const { port } = JSON.parse(readFileSync(join(dir, "control.json"), "utf8")) as { port: number };
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/status" }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(403);
  });

  test("a terminal tunnel runs with the service's token, and the stream carries none", async () => {
    const events: { type?: string; url?: string; id?: string }[] = [];
    const stream = await streamControl(dir, "/tunnels/open", { kind: "http", server: server.wsUrl, tunnels: [{ port: localPort }] }, (m) => {
      events.push(m as { type?: string });
      answers.push(JSON.stringify(m));
    });
    await waitFor(() => events.some((e) => e.type === "connected"));
    expect(server.authKeys).toContain(ACCESS);
    const listed = (await call("GET", "/tunnels")) as { tunnels: { id: string }[] };
    expect(listed.tunnels).toHaveLength(1);
    const url = events.find((e) => e.type === "connected")?.url ?? "";
    expect(await (await fetch(url)).text()).toBe("hello");
    await waitFor(() => events.some((e) => e.type === "inspector-entry"));
    stream.close();
    await stream.done;
    await waitFor(() => server.openSockets() === 0);
    expect(((await call("GET", "/tunnels")) as { tunnels: unknown[] }).tunnels).toHaveLength(0);
  });

  test("tunnel.close ends a terminal's tunnel and tells it why", async () => {
    const events: { type?: string; id?: string; reason?: string }[] = [];
    const stream = await streamControl(dir, "/tunnels/open", { kind: "http", server: server.wsUrl, tunnels: [{ port: localPort }] }, (m) => {
      events.push(m as { type?: string });
      answers.push(JSON.stringify(m));
    });
    await waitFor(() => events.some((e) => e.type === "connected"));
    const id = events.find((e) => e.type === "opened")?.id ?? "";
    expect(await call("POST", "/tunnels/close", { id })).toEqual({ closed: true });
    await stream.done;
    expect(events.at(-1)?.type).toBe("closed");
  });

  test("MCP tools run in the service; no answer holds a token", async () => {
    let session = "";
    const stream = await streamControl(dir, "/mcp/session", { server: server.wsUrl }, (m) => {
      session = (m as { session?: string }).session ?? session;
      answers.push(JSON.stringify(m));
    });
    await waitFor(() => session !== "");
    type Result = { content: { text: string }[]; isError?: boolean };
    const called = new Set<string>();
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      called.add(name);
      return (await call("POST", "/mcp/call", { session, group: "tunnel", tool: name, args })) as Result;
    };
    const json = (r: Result) => JSON.parse(r.content[0]?.text ?? "null") as Record<string, unknown>;
    expect(json(await tool("whoami"))).toEqual({ kind: "account", account: "acc_control" });
    await tool("tunnel_status");
    const opened = await tool("open_http_tunnel", { port: localPort, ttl: 60 });
    const tunnelId = String(json(opened).id);
    const url = String(json(opened).url);
    expect(((await call("GET", "/tunnels")) as { mcp: unknown[] }).mcp).toHaveLength(1);
    await (await fetch(`${url}/through-mcp`)).text();
    expect(json(await tool("list_local_tunnels")).tunnels).toHaveLength(1);
    await waitFor(async () => Number(json(await tool("list_tunnel_requests", { tunnel: tunnelId })).total) === 1);
    const [first] = json(await tool("list_tunnel_requests", { tunnel: tunnelId })).requests as { id: string }[];
    expect(json(await tool("get_tunnel_request", { tunnel: tunnelId, id: first?.id })).path).toBe("/through-mcp");
    // Signed in: the machine needs no links; revoking says so.
    expect(json(await tool("list_linked_machines")).links).toEqual([]);
    expect((await tool("revoke_linked_machine", { id: "l1", dry_run: true })).isError).toBe(true);
    expect((await tool("close_local_tunnel_process", { target: "no-such-tunnel" })).isError).toBe(true);
    // Without a ttl a TCP tunnel is refused before anything opens.
    expect((await tool("open_tcp_tunnel", { port: localPort })).isError).toBe(true);
    expect(json(await tool("close_tunnel", { id: tunnelId }))).toEqual({ closed: tunnelId });
    expect((await tool("open_http_tunnel", { port: 0 })).isError).toBe(true);
    expect([...called].sort()).toEqual(
      [
        "close_local_tunnel_process",
        "close_tunnel",
        "get_tunnel_request",
        "list_linked_machines",
        "list_local_tunnels",
        "list_tunnel_requests",
        "open_http_tunnel",
        "open_tcp_tunnel",
        "revoke_linked_machine",
        "tunnel_status",
        "whoami",
      ].sort(),
    );
    await tool("open_http_tunnel", { port: localPort, ttl: 60 });
    stream.close();
    await stream.done;
    // The session ended with its client: its tunnel closed.
    await waitFor(async () => ((await callControl(dir, "GET", "/tunnels")) as { mcp: unknown[] }).mcp.length === 0);
  });

  test("the machine commands answer without tokens", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      await call("GET", "/status");
      await call("GET", "/devices");
      await call("POST", "/devices/revoke", { key: "devicekey" });
      await call("GET", "/trust");
      await call("POST", "/trust", { dir: "/tmp/x", trusted: "true" });
      await call("GET", "/audit");
      expect(await call("GET", "/apps")).toMatchObject({ chat: { status: "sign-in" }, localman: { status: "sign-in" } });
      expect(await call("POST", "/registration/retry")).toEqual({ retrying: true });
      expect(await call("GET", "/claude/profiles")).toMatchObject({ selectedId: "" });
      expect(await call("POST", "/claude/profiles/select", { id: "" })).toMatchObject({ selectedId: "" });
      expect(await call("POST", "/claude/profiles/select", { id: "nope" })).toEqual({ error: "no such profile" });
      expect(await call("POST", "/claude/profiles/prepare")).toMatchObject({ id: "p1" });
      expect(await call("POST", "/claude/profiles/finish", { id: "p1" })).toEqual({ ok: false, error: "expired" });
      expect(await call("POST", "/claude/profiles/cancel", { id: "p1" })).toEqual({ cancelled: true });
      expect(await call("POST", "/claude/profiles/usage", { id: "" })).toMatchObject({ selectedId: "" });
      expect(await call("POST", "/claude/profiles/remove", { id: "p1" })).toMatchObject({ selectedId: "" });
      expect(await call("POST", "/claude/profiles/remove", {})).toMatchObject({ error: expect.any(String) });
      expect(await call("POST", "/usage/delete")).toEqual({ deleted: true });
      expect(usageDeletes).toBe(1);
      expect(await call("GET", "/local-forward")).toEqual({ enabled: true, available: false, blockedPorts: [] });
      expect(await call("POST", "/local-forward", { enabled: false })).toMatchObject({ enabled: false });
      expect(await call("POST", "/local-forward", { enabled: "no" })).toMatchObject({ error: expect.any(String) });
      expect(await call("POST", "/local-forward/blocked", { ports: [8080], blocked: true })).toMatchObject({ blockedPorts: [8080] });
      expect(await call("POST", "/local-forward/blocked", { ports: [70000], blocked: true })).toMatchObject({ error: expect.any(String) });
      await call("POST", "/restart");
      expect(await call("POST", "/streams/alive", { id: "nope" })).toMatchObject({ error: "no such stream" });
      expect(await call("POST", "/devices/revoke", { key: "x" })).toMatchObject({ error: expect.stringContaining("6 characters") });
      expect(await call("POST", "/nope")).toMatchObject({ error: "unknown command POST /nope" });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      exit.mockRestore();
    }
  });

  test("no answer of any command contained a secret or a JWT", () => {
    expect(answers.length).toBeGreaterThan(15);
    for (const text of answers) {
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(JWT_SHAPE);
    }
  });
});

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
import { identitySession } from "../src/identity/session.ts";
import type { Machine } from "../src/machine.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
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

/** A machine with just what the commands touch. */
function fakeMachine(): Machine {
  const fake = {
    openPairing: () => ({ code: "123456", qr: "qr-payload", expiresAt: 0 }),
    machineInfo: async () => ({ name: "mac", agentVersion: "2.0.0", providers: [], openSessions: 0, maxSessions: 3, memoryMb: 1 }),
    config: {
      get: () => ({ devices: [{ key: "devicekey123456", name: "phone", addedAt: 0 }], trustedDirs: [] }),
      revokeDevice: () => true,
      setTrusted: (d: string) => d,
    },
    dropDevice: () => undefined,
    audit: { write: () => undefined, list: () => [] },
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
  stop = serveControl({ dir, machine: fakeMachine(), tunnels: new TunnelService(dir), mcp: new McpHost(dir) });
  await waitFor(() => existsSync(join(dir, "control.json")));
});

afterAll(async () => {
  stop();
  await server.close();
  await new Promise<void>((r) => local.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("control socket", () => {
  test("has exactly the commands this test covers", () => {
    expect(Object.keys(CONTROL_ROUTES).sort()).toEqual(
      [
        "GET /audit",
        "GET /devices",
        "GET /status",
        "GET /trust",
        "GET /tunnels",
        "POST /devices/revoke",
        "POST /mcp/call",
        "POST /pair",
        "POST /restart",
        "POST /trust",
        "POST /tunnels/close",
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
    const tool = (name: string, args: Record<string, unknown> = {}) => call("POST", "/mcp/call", { session, group: "tunnel", tool: name, args });
    await tool("whoami");
    await tool("tunnel_status");
    const opened = (await tool("open_http_tunnel", { port: localPort, ttl: 60 })) as { content: { text: string }[] };
    expect(opened.content[0]?.text).toContain("url");
    expect(((await call("GET", "/tunnels")) as { mcp: unknown[] }).mcp).toHaveLength(1);
    await tool("list_local_tunnels");
    await tool("list_linked_machines");
    expect(((await tool("open_http_tunnel", { port: 0 })) as { isError?: boolean }).isError).toBe(true);
    stream.close();
    await stream.done;
    // The session ended with its client: its tunnel closed.
    await waitFor(async () => ((await callControl(dir, "GET", "/tunnels")) as { mcp: unknown[] }).mcp.length === 0);
  });

  test("the machine commands answer without tokens", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      await call("GET", "/status");
      await call("POST", "/pair");
      await call("GET", "/devices");
      await call("POST", "/devices/revoke", { key: "devicekey" });
      await call("GET", "/trust");
      await call("POST", "/trust", { dir: "/tmp/x", trusted: "true" });
      await call("GET", "/audit");
      await call("POST", "/restart");
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

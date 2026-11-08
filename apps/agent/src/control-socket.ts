// Local control channel between `tunelo <command>` and the running
// service: HTTP on 127.0.0.1 with a random token written to control.json in
// the 0700 config folder, so only this OS user can call it. Only the service
// writes the config; commands ask it to.
//
// No route hands out a token of the account: tunnels and MCP tools run in
// the service, which adds the Bearer itself. `tunelo http|tcp` and
// `tunelo mcp` hold a streaming request open and send their pid; what they
// opened closes when the stream closes or that process is gone (Bun's
// node:http server does not report a client that left a stream).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { Machine } from "./machine.ts";
import type { McpHost } from "./mcp/mcp-host.ts";
import { type TunnelEvent, tunnelSpecSchema } from "./tunnels/tunnel-host.ts";
import { isAlive } from "./tunnels/run-registry.js";
import type { TunnelService } from "./tunnels/tunnel-service.ts";

const controlFile = (configDir: string) => join(configDir, "control.json");
const TOKEN_HEADER = "x-chat-agent-token";
const NOT_RUNNING = "tunelo is not running (start it with `tunelo start`)";
const MAX_BODY_BYTES = 1024 * 1024;
/** Streams send a line this often, so neither side mistakes a quiet tunnel for a dead one. */
const STREAM_PING_MS = 5_000;
/** How often the service checks that the process holding a stream still runs. */
const HOLDER_CHECK_MS = 1_000;
const streamHolder = z.object({ pid: z.number().int().positive().optional() });

/** What the control channel drives. The machine is absent in a tunnel-only service (tests). */
export type ControlTarget = {
  dir: string;
  machine?: Machine;
  tunnels: TunnelService;
  mcp: McpHost;
};

type Route = (target: ControlTarget, input: unknown) => unknown;
type Stream = (target: ControlTarget, input: unknown, send: (message: unknown) => void, end: () => void) => () => void;

const deviceRevoke = z.object({ key: z.string().min(6, "give at least 6 characters of the device key").max(128) });
const trustInput = z.object({ dir: z.string().min(1).max(4096), trusted: z.enum(["true", "false"]).optional() });
const closeInput = z.object({ id: z.string().min(1).max(64) });
const mcpSession = z.object({ server: z.string().min(1).max(512) });
const mcpCall = z.object({
  session: z.string().min(1).max(64),
  group: z.string().min(1).max(64),
  tool: z.string().min(1).max(128),
  args: z.record(z.string(), z.unknown()).optional(),
});

function machineOf(target: ControlTarget): Machine {
  if (!target.machine) throw new Error("this tunelo runs tunnels only");
  return target.machine;
}

/** Every request/response command of the channel. */
export const CONTROL_ROUTES: Readonly<Record<string, Route>> = {
  "POST /pair": (t) => machineOf(t).openPairing(),
  "GET /status": async (t) => {
    const tunnels = t.tunnels.list().length + t.mcp.tunnels().length;
    if (!t.machine) return { tunnels };
    const m = t.machine;
    const info = await m.machineInfo();
    return {
      name: info.name,
      agentVersion: info.agentVersion,
      providers: info.providers.map((p) => ({ id: p.id, version: p.version, login: p.loginState })),
      sessions: `${info.openSessions}/${info.maxSessions}`,
      devices: m.config.get().devices.length,
      memoryMb: info.memoryMb,
      tunnels,
    };
  },
  "GET /devices": (t) =>
    machineOf(t)
      .config.get()
      .devices.map((d) => ({ key: d.key.slice(0, 12), name: d.name, addedAt: new Date(d.addedAt).toISOString() })),
  "POST /devices/revoke": (t, input) => {
    const m = machineOf(t);
    const { key } = deviceRevoke.parse(input);
    const found = m.config.revokeDevice(key);
    m.dropDevice(key);
    m.audit.write({ device: "local", action: "revoke", path: "", detail: key });
    return { revoked: found };
  },
  "POST /restart": () => {
    // The supervisor starts the agent again (launchd KeepAlive, task loop).
    setTimeout(() => process.exit(0), 200);
    return { restarting: true };
  },
  "GET /trust": (t) => machineOf(t).config.get().trustedDirs,
  "POST /trust": (t, input) => {
    const m = machineOf(t);
    const { dir: given, trusted } = trustInput.parse(input);
    const dir = m.config.setTrusted(given, trusted !== "false");
    m.audit.write({ device: "local", action: "project_settings", path: dir, detail: trusted === "false" ? "untrust" : "trust" });
    return { dir, trusted: trusted !== "false" };
  },
  "GET /audit": (t) => machineOf(t).audit.list(50),
  "GET /tunnels": (t) => ({ tunnels: t.tunnels.list(), mcp: t.mcp.tunnels() }),
  "POST /tunnels/close": (t, input) => {
    const { id } = closeInput.parse(input);
    return { closed: t.tunnels.close(id) || t.mcp.closeTunnel(id) };
  },
  "POST /mcp/call": (t, input) => {
    const call = mcpCall.parse(input);
    return t.mcp.call(call.session, call.group, call.tool, call.args ?? {});
  },
};

/** Commands that answer with a stream of JSON lines while the caller stays connected. */
export const CONTROL_STREAMS: Readonly<Record<string, Stream>> = {
  /** `tunelo http|tcp`: the tunnel's events; it closes when the caller leaves. */
  "POST /tunnels/open": (t, input, send, end) => {
    const spec = tunnelSpecSchema.parse(input);
    const id = t.tunnels.open(spec, (event: TunnelEvent) => {
      send(event);
      if (event.type === "failed" || event.type === "closed") end();
    });
    send({ type: "opened", id });
    return () => t.tunnels.close(id, "the terminal left");
  },
  /** `tunelo mcp`: a session whose tunnels close when the caller leaves. */
  "POST /mcp/session": (t, input, send) => {
    const { server } = mcpSession.parse(input);
    const session = t.mcp.open(server);
    send({ session });
    return () => t.mcp.end(session);
  },
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? (JSON.parse(text) as unknown) : {});
      } catch {
        reject(new Error("the request is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => i.message).join("; ");
  return err instanceof Error ? err.message : String(err);
}

function openStream(target: ControlTarget, stream: Stream, input: unknown, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const live = () => !res.writableEnded && !res.destroyed;
  const send = (message: unknown) => {
    if (live()) res.write(`${JSON.stringify(message)}\n`);
  };
  const ping = setInterval(() => send({ type: "ping" }), STREAM_PING_MS);
  let cleanup: (() => void) | undefined;
  let closed = false;
  const holder = streamHolder.safeParse(input);
  const pid = holder.success ? holder.data.pid : undefined;
  const watch = pid
    ? setInterval(() => {
        if (!isAlive(pid)) {
          finish();
          end();
        }
      }, HOLDER_CHECK_MS)
    : undefined;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    clearInterval(watch);
    cleanup?.();
  };
  const end = () => {
    if (live()) res.end();
  };
  res.on("close", finish);
  try {
    cleanup = stream(target, input, send, end);
    if (closed) cleanup();
  } catch (err) {
    send({ type: "failed", message: errorMessage(err) });
    end();
    finish();
  }
}

export function serveControl(target: ControlTarget): () => void {
  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    const given = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ""));
    if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) {
      res.writeHead(403).end();
      return;
    }
    const name = `${req.method} ${req.url}`;
    void (async () => {
      try {
        const input = await readBody(req);
        const stream = CONTROL_STREAMS[name];
        if (stream) {
          openStream(target, stream, input, res);
          return;
        }
        const route = CONTROL_ROUTES[name];
        if (!route) throw new Error(`unknown command ${name}`);
        const out = await route(target, input);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (err) {
        if (res.headersSent) return;
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: errorMessage(err) }));
      }
    })();
  });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeFileSync(controlFile(target.dir), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  });
  return () => {
    server.close();
    server.closeAllConnections?.();
    rmSync(controlFile(target.dir), { force: true });
  };
}

/** Client side, used by the CLI. */
/** The pid the running agent wrote next to its control port. */
export function controlPid(configDir: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(controlFile(configDir), "utf8")) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
}

function controlTarget(configDir: string): { port: number; token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(controlFile(configDir), "utf8")) as { port?: unknown; token?: unknown };
    return typeof parsed.port === "number" && typeof parsed.token === "string" ? { port: parsed.port, token: parsed.token } : null;
  } catch {
    return null;
  }
}

export function callControl(configDir: string, method: string, path: string, input?: unknown): Promise<unknown> {
  const target = controlTarget(configDir);
  if (!target) return Promise.reject(new Error(NOT_RUNNING));
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", [TOKEN_HEADER]: target.token };
    const req = request({ host: "127.0.0.1", port: target.port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => {
        try {
          const out = JSON.parse(body) as { error?: string };
          if (res.statusCode !== 200) reject(new Error(out.error ?? `HTTP ${res.statusCode}`));
          else resolve(out);
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    req.on("error", () => reject(new Error(NOT_RUNNING)));
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

/** True when a service answers on this config folder's control channel. */
export async function controlAnswers(configDir: string): Promise<boolean> {
  try {
    await callControl(configDir, "GET", "/status");
    return true;
  } catch {
    return false;
  }
}

export type ControlStream = {
  close(): void;
  /** Settles when the stream ends: by close(), by the service, or because it stopped. */
  done: Promise<void>;
};

/**
 * Opens a streaming command on behalf of this process (its pid goes with the
 * input). Each JSON line but pings goes to `onMessage`; rejects when no
 * service answers or it refuses the command.
 */
export function streamControl(configDir: string, path: string, input: unknown, onMessage: (message: unknown) => void): Promise<ControlStream> {
  const target = controlTarget(configDir);
  if (!target) return Promise.reject(new Error(NOT_RUNNING));
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", [TOKEN_HEADER]: target.token };
    let settle: () => void = () => undefined;
    const done = new Promise<void>((r) => (settle = r));
    const req = request({ host: "127.0.0.1", port: target.port, method: "POST", path, headers }, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => {
          let message = `HTTP ${res.statusCode}`;
          try {
            message = (JSON.parse(body) as { error?: string }).error ?? message;
          } catch {
            // Not JSON: keep the status.
          }
          reject(new Error(message));
        });
        return;
      }
      resolve({ close: () => req.destroy(), done });
      let buffer = "";
      res.on("data", (c: Buffer) => {
        buffer += c.toString("utf8");
        for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let message: unknown;
          try {
            message = JSON.parse(line) as unknown;
          } catch {
            continue;
          }
          if ((message as { type?: unknown }).type !== "ping") onMessage(message);
        }
      });
      // Not the request's "close": Bun emits it once the response starts.
      res.on("end", settle);
      res.on("close", settle);
    });
    req.on("error", () => {
      reject(new Error(NOT_RUNNING));
      settle();
    });
    const body = typeof input === "object" && input !== null ? { ...input, pid: process.pid } : input;
    req.end(JSON.stringify(body));
  });
}

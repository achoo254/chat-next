// Local control channel between `hda <command>` and the running
// service: HTTP on 127.0.0.1 with a random token written to control.json in
// the 0700 config folder, so only this OS user can call it. Only the service
// writes the config; commands ask it to.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import type { Machine } from "./machine.ts";

const controlFile = (configDir: string) => join(configDir, "control.json");

export function serveControl(machine: Machine): () => void {
  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    const given = Buffer.from(String(req.headers["x-chat-agent-token"] ?? ""));
    if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      void (async () => {
        try {
          const input = body ? (JSON.parse(body) as Record<string, string>) : {};
          const out = await handle(machine, `${req.method} ${req.url}`, input);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
        }
      })();
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeFileSync(controlFile(machine.config.dir), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  });
  return () => {
    server.close();
    rmSync(controlFile(machine.config.dir), { force: true });
  };
}

async function handle(m: Machine, route: string, input: Record<string, string>): Promise<unknown> {
  switch (route) {
    case "POST /pair":
      return m.openPairing();
    case "GET /status": {
      const info = await m.machineInfo();
      return {
        name: info.name,
        agentVersion: info.agentVersion,
        providers: info.providers.map((p) => ({ id: p.id, version: p.version, login: p.loginState })),
        sessions: `${info.openSessions}/${info.maxSessions}`,
        devices: m.config.get().devices.length,
        memoryMb: info.memoryMb,
      };
    }
    case "GET /devices":
      return m.config.get().devices.map((d) => ({ key: d.key.slice(0, 12), name: d.name, addedAt: new Date(d.addedAt).toISOString() }));
    case "POST /devices/revoke": {
      const key = input.key ?? "";
      if (key.length < 6) throw new Error("give at least 6 characters of the device key");
      const found = m.config.revokeDevice(key);
      m.dropDevice(key);
      m.audit.write({ device: "local", action: "revoke", path: "", detail: key });
      return { revoked: found };
    }
    case "POST /restart":
      // The supervisor starts the agent again (launchd KeepAlive, task loop).
      setTimeout(() => process.exit(0), 200);
      return { restarting: true };
    case "GET /trust":
      return m.config.get().trustedDirs;
    case "POST /trust": {
      const dir = m.config.setTrusted(input.dir ?? "", input.trusted !== "false");
      m.audit.write({ device: "local", action: "project_settings", path: dir, detail: input.trusted === "false" ? "untrust" : "trust" });
      return { dir, trusted: input.trusted !== "false" };
    }
    case "GET /audit":
      return m.audit.list(50);
    default:
      throw new Error(`unknown command ${route}`);
  }
}

/** Client side, used by the CLI. */
export function callControl(configDir: string, method: string, path: string, input?: unknown): Promise<unknown> {
  let target: { port: number; token: string };
  try {
    target = JSON.parse(readFileSync(controlFile(configDir), "utf8")) as { port: number; token: string };
  } catch {
    return Promise.reject(new Error("hda is not running (start it with `hda run`)"));
  }
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "x-chat-agent-token": target.token };
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
    req.on("error", () => reject(new Error("hda is not running (start it with `hda run`)")));
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

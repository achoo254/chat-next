// The running service: config, machine key, core, local WebSocket server,
// pairing window and the "needs you" push decision.
import { arch, homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { LoginState, type MachineInfo, MachineInfoSchema, ThreadState, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import {
  type KeyPair,
  type MachineAuth,
  PROTOCOL_VERSION,
  PairingWindow,
  encodeQr,
  fromBase64Url,
  toBase64Url,
} from "@achoo254/chat-remote-protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { ConfigStore } from "./config.ts";
import { AgentCore } from "./core/agent-core.ts";
import { machineKey } from "./keystore.ts";
import { Connection } from "./link/connection.ts";
import { builtinProviders } from "./providers/registry.ts";
import type { AgentProvider, Detected } from "./providers/types.ts";
import { AuditLog } from "./safety/audit-log.ts";
import { createSensitiveCheck } from "./safety/sensitive-paths.ts";
import { AGENT_VERSION } from "./version.ts";

const MAX_CONNECTIONS = 16;
const MAX_HANDSHAKING = 8;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Push only when nobody looked at the machine for this long… */
const PING_FRESH_MS = 15_000;
/** …and the prompt is still waiting after this long. */
const PUSH_DELAY_MS = 20_000;

export type MachineOptions = {
  config?: ConfigStore;
  providers?: AgentProvider[];
  /** Sends a content-free "needs you" push through the chat server. */
  notify?: (thread: ThreadSummary, pending: number) => void;
  log?: (line: string) => void;
};

export class Machine {
  readonly config: ConfigStore;
  readonly core: AgentCore;
  readonly audit: AuditLog;
  readonly isSensitive: (p: string) => boolean;
  private key!: KeyPair;
  private pairing: PairingWindow | undefined;
  private server: WebSocketServer | undefined;
  private connections = new Set<Connection>();
  private lastPing = 0;
  private providers: AgentProvider[];
  private detected = new Map<string, { at: number; value: Detected }>();
  private log: (line: string) => void;

  constructor(private readonly opts: MachineOptions = {}) {
    this.config = opts.config ?? new ConfigStore();
    this.log = opts.log ?? ((l) => console.log(l));
    const dir = this.config.dir;
    this.isSensitive = createSensitiveCheck({ configDir: dir });
    this.audit = new AuditLog(join(dir, "audit.jsonl"));
    this.providers = opts.providers ?? builtinProviders();
    const c = this.config.get();
    this.core = new AgentCore({
      dataDir: join(dir, "data"),
      providers: this.providers,
      audit: this.audit,
      isSensitive: this.isSensitive,
      mcpServers: c.mcpServers,
      maxSessions: c.maxSessions,
      idleMs: c.idleMinutes * 60_000,
      onNeedsInput: (t) => this.maybePush(t),
    });
  }

  async start(port = this.config.get().port ?? 0): Promise<number> {
    this.key = await machineKey(this.config.dir);
    this.core.start();
    const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 8 * 1024 * 1024 });
    this.server = wss;
    wss.on("connection", (ws) => this.accept(ws));
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const addr = wss.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    this.log(`chat-agent ${AGENT_VERSION} listening on ws://127.0.0.1:${actual}`);
    return actual;
  }

  async stop(): Promise<void> {
    for (const c of this.connections) c.close(1001, "shutting down");
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.core.stop();
  }

  get publicKey(): Uint8Array {
    return this.key.publicKey;
  }

  /** `chat-agent pair`: a 10-minute window with a QR payload and a 6-digit code. */
  openPairing(): { code: string; qr: string; expiresAt: number } {
    this.pairing = PairingWindow.open();
    return { code: this.pairing.code, qr: encodeQr(this.key.publicKey, this.pairing.secret), expiresAt: this.pairing.expiresAt };
  }

  /** Cuts every live connection of a device that was just revoked. */
  dropDevice(key: string): void {
    for (const c of this.connections) {
      const k = c.deviceKey;
      if (k && toBase64Url(k).startsWith(key)) c.close(4001, "revoked");
    }
  }

  private auth(): MachineAuth {
    const install = this.config.get().install;
    return {
      machine: this.key,
      deviceStatus: (k) => this.config.deviceStatus(k),
      install: install ? { deviceKey: fromBase64Url(install.deviceKey), secret: fromBase64Url(install.secret) } : undefined,
      pairing: this.pairing,
    };
  }

  private accept(ws: WebSocket): void {
    const handshaking = [...this.connections].filter((c) => !c.isOpen).length;
    if (this.connections.size >= MAX_CONNECTIONS || handshaking >= MAX_HANDSHAKING) {
      ws.close(1013, "busy");
      return;
    }
    const conn = new Connection(
      { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) },
      {
        core: this.core,
        config: this.config,
        audit: this.audit,
        auth: () => this.auth(),
        pairing: () => this.pairing,
        machineInfo: () => this.machineInfo(),
        isSensitive: this.isSensitive,
        onPing: () => (this.lastPing = Date.now()),
        onPaired: (via) => {
          if (via === "install") this.config.update((c) => delete c.install);
          else this.pairing = undefined;
          this.log(`paired a device (${via})`);
        },
      },
    );
    this.connections.add(conn);
    const timer = setTimeout(() => {
      if (!conn.isOpen) conn.close(1008, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return conn.close(1003, "binary only");
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      conn.receive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      conn.close();
      this.connections.delete(conn);
    });
    ws.on("error", () => conn.close());
  }

  private async detect(p: AgentProvider): Promise<Detected> {
    const hit = this.detected.get(p.id);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await p.detect();
    this.detected.set(p.id, { at: Date.now(), value });
    return value;
  }

  async machineInfo(): Promise<MachineInfo> {
    const c = this.config.get();
    const providers = [];
    for (const p of this.providers) {
      const d = await this.detect(p);
      if (!d.installed) continue;
      providers.push({
        id: p.id,
        name: p.name,
        version: d.version ?? "",
        loginState: d.loginState === "ok" ? LoginState.OK : d.loginState === "needs-login" ? LoginState.NEEDS_LOGIN : LoginState.UNKNOWN,
        capabilities: p.capabilities,
        untestedVersion: Boolean(d.untestedVersion),
      });
    }
    return create(MachineInfoSchema, {
      name: c.machineName || hostname(),
      os: platform(),
      arch: arch(),
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      providers,
      home: homedir(),
      recentDirs: this.core.recentDirs(),
      pinnedDirs: c.pinnedDirs,
      openSessions: this.core.openSessions(),
      maxSessions: this.core.limit,
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    });
  }

  private maybePush(thread: ThreadSummary): void {
    setTimeout(() => {
      const now = this.core.list().find((t) => t.id === thread.id);
      if (!now || now.state !== ThreadState.WAITING) return;
      if (Date.now() - this.lastPing < PING_FRESH_MS) return;
      const pending = this.core.list().reduce((n, t) => n + t.pending, 0);
      if (this.opts.notify) this.opts.notify(now, pending);
      else this.log(`needs you: "${now.title}" (${pending} waiting)`);
    }, PUSH_DELAY_MS).unref?.();
  }
}

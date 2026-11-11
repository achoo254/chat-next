// The running service: config, machine key, core, local server (the
// devices' WebSocket, and Localman's requests for localhost under
// `/.tunelo/forward`, tunnels/forward.ts), pairing by the authenticator code
// and the "needs you" push decision.
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { Duplex } from "node:stream";
import { arch, homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { LoginState, type MachineInfo, MachineInfoSchema, ThreadState, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import {
  type KeyPair,
  type MachineAuth,
  PROTOCOL_VERSION,
  TotpPairing,
  base32Encode,
  fromBase64Url,
  generateTotpSecret,
  toBase64Url,
  totpUri,
} from "@achoo254/chat-remote-protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { ConfigStore } from "./config.ts";
import { AgentCore } from "./core/agent-core.ts";
import { machineKey } from "./keystore.ts";
import { Connection, profileListBody, projectListBody } from "./link/connection.ts";
import { ClaudeProfiles, type ProfileList } from "./profiles/service.ts";
import { findClaude, probeUsage } from "./providers/claude/index.ts";
import { builtinProviders } from "./providers/registry.ts";
import type { AgentProvider, Detected } from "./providers/types.ts";
import { logFile } from "./log-tail.ts";
import { startLogRotation } from "./log-rotate.ts";
import type { McpHost } from "./mcp/mcp-host.ts";
import type { SessionMcpLease } from "./mcp/session-tickets.ts";
import { AuditLog } from "./safety/audit-log.ts";
import { DiskAccessWatch, diskAccess, diskAccessSteps, freshDiskAccess, openDiskAccessSettings } from "./safety/disk-access.ts";
import { isCompiled, selfCommand, supervised, underLaunchAgent } from "./service.ts";
import { AgentUpdater } from "./agent-updater.ts";
import { createSensitiveCheck } from "./safety/sensitive-paths.ts";
import { ForwardDenyList } from "./tunnels/forward-deny-ports.ts";
import { LocalForward } from "./tunnels/forward.ts";
import { ForwardSettings } from "./tunnels/forward-settings.ts";
import { AGENT_VERSION } from "./version.ts";
import { attachmentLimitsBody } from "./attachments/uploads.ts";
import { Projects } from "./projects/projects.ts";
import { SessionSecretEnv } from "./sign-in-secrets/secret-env.ts";
import { SecretService } from "./sign-in-secrets/secret-service.ts";
import { RemoteBrowser } from "./remote-browser/remote-browser.ts";
import { ScreenShare } from "./screen-share/screen-share.ts";

const MAX_CONNECTIONS = 16;
const MAX_HANDSHAKING = 8;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Devices ping every 10 s; a silent connection is dropped. */
const IDLE_TIMEOUT_MS = 45_000;
/** Push only when nobody looked at the machine for this long… */
const PING_FRESH_MS = 15_000;
/** …and the prompt is still waiting after this long. */
const PUSH_DELAY_MS = 20_000;
/** Profile changes this close together reach devices as one MachineProfile. */
const ANNOUNCE_DELAY_MS = 50;

export type MachineOptions = {
  config?: ConfigStore;
  providers?: AgentProvider[];
  /** The Claude profiles; built from the config folder when not given. */
  profiles?: ClaudeProfiles;
  /** Sends a content-free "needs you" push through the chat server. */
  notify?: (thread: ThreadSummary, pending: number) => void;
  /** Tells the account's devices, through the chat server, that a device was paired by the authenticator code. */
  notifyPaired?: () => void;
  log?: (line: string) => void;
  /** tunelo's MCP for the sessions this machine opens (its tickets); absent in tests. */
  mcp?: McpHost;
  /** Sign-in secrets; built from the config folder when not given. */
  secrets?: SecretService;
  /** The tunelo browser; built from the config folder when not given. */
  browser?: RemoteBrowser;
  /** The machine's own Screen Sharing (macOS); built when not given. */
  screenShare?: ScreenShare;
};

/** What an authenticator app names the entry; the web page uses the product name, this terminal the feature's. */
export const AUTHENTICATOR_ISSUER = "AI Agent";

export class Machine {
  readonly config: ConfigStore;
  readonly core: AgentCore;
  readonly audit: AuditLog;
  readonly isSensitive: (p: string) => boolean;
  readonly profiles: ClaudeProfiles;
  readonly projects: Projects;
  readonly secrets: SecretService;
  readonly browser: RemoteBrowser;
  readonly screenShare: ScreenShare;
  private readonly updater: AgentUpdater;
  private announcingProjects: ReturnType<typeof setTimeout> | undefined;
  /** Localman's requests for localhost on this machine. */
  readonly localForward: LocalForward;
  private key!: KeyPair;
  /** Pairing by the authenticator code; its failed-attempt count lives only in memory. */
  private readonly pairing: TotpPairing;
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private port = 0;
  private stopRotation: (() => void) | undefined;
  private connections = new Set<Connection>();
  private lastPing = 0;
  private providers: AgentProvider[];
  private detected = new Map<string, { at: number; value: Detected }>();
  private log: (line: string) => void;
  private announcing: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: MachineOptions = {}) {
    this.config = opts.config ?? new ConfigStore();
    this.log = opts.log ?? ((l) => console.log(l));
    const dir = this.config.dir;
    this.isSensitive = createSensitiveCheck({ configDir: dir });
    this.audit = new AuditLog(join(dir, "audit.jsonl"));
    this.secrets = opts.secrets ?? new SecretService({ configDir: dir, audit: this.audit });
    this.browser = opts.browser ?? new RemoteBrowser({ configDir: dir, audit: this.audit, log: this.log });
    this.screenShare = opts.screenShare ?? new ScreenShare({ audit: this.audit, log: this.log });
    this.updater = new AgentUpdater({
      // Only the installed single file replaces itself, and only where something starts it again.
      supported: () => isCompiled() && supervised(dir),
      announce: () => void this.announceInfo(),
      emit: (p) => {
        const value = { phase: p.phase, version: p.version, received: BigInt(p.received), total: BigInt(p.total), message: p.message };
        for (const c of this.connections) if (c.isOpen) c.announce({ case: "agentUpdateProgress", value });
      },
      // Lets the last progress frames out, then exits for the supervisor to start the new file.
      restart: () => setTimeout(() => process.exit(0), 500),
      log: this.log,
    });
    // Sessions kept on the machine are read from its own Claude folder and every profile's.
    this.providers = opts.providers ?? builtinProviders(() => this.profiles.claudeHomes());
    const c = this.config.get();
    this.pairing = new TotpPairing(this.config.totpSecret());
    if (c.totpSecret && !this.pairing.enabled) this.log("authenticator secret in config.json is not valid: set it again from a paired device");
    this.profiles =
      opts.profiles ??
      new ClaudeProfiles({
        configDir: dir,
        audit: this.audit,
        findBinary: findClaude,
        probeUsage: (bin, accountDir) => probeUsage(bin, accountDir),
        inUse: (id) => this.core.profileInUse(id),
        onUsage: (id, usage) => this.core.setProfileUsage(id, usage),
        log: this.log,
      });
    const forwardSettings = new ForwardSettings(dir);
    this.localForward = new LocalForward({
      settings: forwardSettings,
      audit: this.audit,
      log: this.log,
      deny: new ForwardDenyList({
        configDir: dir,
        ownPorts: () => (this.port ? [this.port] : []),
        extraPorts: () => forwardSettings.read().blockedPorts,
        log: this.log,
      }),
    });
    this.core = new AgentCore({
      dataDir: join(dir, "data"),
      providers: this.providers,
      audit: this.audit,
      isSensitive: this.isSensitive,
      isTrusted: (dir) => this.config.isTrusted(dir),
      trust: (dir, device) => {
        const full = this.config.setTrusted(dir, true);
        this.audit.write({ device, action: "project_settings", path: full, detail: "trust" });
      },
      mcpServers: c.mcpServers,
      maxSessions: c.maxSessions,
      idleMs: c.idleMinutes * 60_000,
      onNeedsInput: (t) => this.maybePush(t),
      profile: () => this.profiles.sessionProfile(),
      selectedAccountDir: () => this.profiles.selectedAccountDir(),
      selectedProfileId: () => this.profiles.selectedId(),
      profileAccount: (id) => this.profiles.account(id),
      suggestProfile: (id) => this.profiles.suggestion(id),
      onSessionProfile: () => this.announceProfiles(),
      onProfileUsage: (id, usage) => this.profiles.recordUsage(id, usage),
      ...(opts.mcp ? { sessionMcp: sessionMcpFor(opts.mcp, this.config, this.secrets, this.browser) } : {}),
    });
    this.profiles.listen({ onSelect: () => this.core.followMachineProfile(), onChange: () => this.announceProfiles() });
    this.projects = new Projects({
      config: this.config,
      audit: this.audit,
      isSensitive: this.isSensitive,
      home: homedir(),
      sessionDirs: async () => {
        const count = new Map<string, number>();
        for (const t of this.core.list()) count.set(t.dir, (count.get(t.dir) ?? 0) + 1);
        for (const d of (await this.core.localSessions({ provider: "claude", dir: "", query: "", offset: 0, limit: 1 })).dirs) {
          count.set(d.dir, Math.max(count.get(d.dir) ?? 0, d.sessions));
        }
        return [...count].map(([dir, sessions]) => ({ dir, sessions }));
      },
    });
    this.projects.onChange(() => this.announceProjects());
    // A session waiting for a secret or for the user on the browser shows as waiting for the user,
    // like a prompt in its transcript.
    this.secrets.onEvent((event) => this.outsidePrompts(event.type === "prompt" ? event.prompt.threadId : event.threadId));
    this.browser.onEvent((event) => {
      if (event.type === "takeover") this.outsidePrompts(event.takeover.threadId);
      else if (event.type === "ended") this.outsidePrompts(event.threadId);
      // Devices show "Xem trình duyệt của máy" only while it runs.
      else if (event.type === "running") void this.announceInfo();
    });
    // A turn that ends may have changed files: the project's git status is read again.
    this.core.onStatus((s) => {
      if (s.state === ThreadState.IDLE && this.projects.invalidate(s.dir)) this.announceProjects();
    });
  }

  private outsidePrompts(threadId: string): void {
    if (!threadId) return;
    const secrets = this.secrets.openPrompts().filter((p) => p.threadId === threadId).length;
    this.core.setOutsidePrompts(threadId, secrets + this.browser.waitingIn(threadId));
  }

  /** Every connected device gets the projects again; changes that come together go out as one. */
  private announceProjects(): void {
    if (this.announcingProjects) return;
    this.announcingProjects = setTimeout(() => {
      this.announcingProjects = undefined;
      void this.projects.list().then(
        (list) => {
          const value = projectListBody(list);
          for (const c of this.connections) if (c.isOpen) c.announce({ case: "projectListResult", value });
        },
        (err: unknown) => this.log(`projects: not announced (${(err as Error).message})`),
      );
    }, 1_000);
    this.announcingProjects.unref?.();
  }

  async start(port = this.config.get().port ?? 0): Promise<number> {
    this.key = await machineKey(this.config.dir);
    this.core.start();
    // Saved values are hidden from every output from the start, not only once used.
    void this.secrets.store.loadForRedaction().catch((err: unknown) => this.log(`secrets: ${(err as Error).message}`));
    void this.profiles.cleanLeftovers();
    this.browser.start();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.wss = wss;
    wss.on("connection", (ws) => this.accept(ws));
    const server = createServer((req, res) => {
      if (this.localForward.handle(req, res)) return;
      // Anything else here is the devices' WebSocket.
      res.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" }).end("Upgrade Required");
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Localman's requests are plain HTTP: a WebSocket on that path is not forwarded.
      if (LocalForward.isForwardUpgrade(req)) {
        socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    this.port = actual;
    this.stopRotation = startLogRotation(logFile(this.config.dir), this.log);
    this.updater.start();
    this.log(`tunelo ${AGENT_VERSION} listening on ws://127.0.0.1:${actual}`);
    if (this.diskWatch.start()) for (const line of diskAccessSteps(process.execPath, false)) this.log(line);
    return actual;
  }

  async stop(): Promise<void> {
    this.secrets.close();
    await this.browser.close();
    this.screenShare.stop();
    this.diskWatch.stop();
    this.updater.stop();
    this.stopRotation?.();
    clearTimeout(this.announcing);
    for (const c of this.connections) c.close(1001, "shutting down");
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.profiles.stop();
    clearTimeout(this.announcingProjects);
    this.projects.stop();
    await this.core.stop();
  }

  /** Wired once the machine is registered with the chat server. */
  setNotify(fn: (thread: ThreadSummary, pending: number) => void): void {
    this.opts.notify = fn;
  }

  /** Wired once the machine is registered with the chat server. */
  setNotifyPaired(fn: () => void): void {
    this.opts.notifyPaired = fn;
  }

  get publicKey(): Uint8Array {
    return this.key.publicKey;
  }

  /**
   * `tunelo authenticator`: makes the authenticator secret here, on this
   * machine, so the first device can pair without another paired device. The
   * secret exists only here and in the terminal that asked; the Chat server
   * never sees it. An existing secret is replaced only when asked.
   */
  enrollAuthenticator(replace: boolean): { uri: string; secret: string } {
    const replaced = this.pairing.enabled;
    if (replaced && !replace) {
      throw new Error("this machine already pairs by an authenticator code; run `tunelo authenticator --replace` to make a new one (the old code stops working)");
    }
    const secret = generateTotpSecret();
    this.config.setTotpSecret(secret);
    this.pairing.setSecret(secret);
    this.audit.write({ device: "local", action: "totp_set", path: "", detail: replaced ? "replaced" : "set" });
    this.log("authenticator pairing set from this machine");
    void this.announceInfo();
    return { uri: totpUri({ secret, label: this.config.get().machineName || hostname(), issuer: AUTHENTICATOR_ISSUER }), secret: base32Encode(secret) };
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
    };
  }

  private accept(ws: WebSocket): void {
    const handshaking = [...this.connections].filter((c) => !c.isOpen).length;
    if (this.connections.size >= MAX_CONNECTIONS || handshaking >= MAX_HANDSHAKING) {
      ws.close(1013, "busy");
      return;
    }
    const conn = new Connection(
      { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason), buffered: () => ws.bufferedAmount },
      {
        core: this.core,
        config: this.config,
        audit: this.audit,
        auth: () => this.auth(),
        pairing: this.pairing,
        machineInfo: () => this.machineInfo(),
        isSensitive: this.isSensitive,
        profiles: this.profiles,
        projects: this.projects,
        localForward: this.localForward,
        secrets: this.secrets,
        browser: this.browser,
        screenShare: this.screenShare,
        updater: this.updater,
        openDiskAccessSettings: () => this.openDiskAccessSettings(),
        onPing: () => (this.lastPing = Date.now()),
        onPaired: (via) => {
          if (via === "install") this.config.update((c) => delete c.install);
          this.log(`paired a device (${via})`);
          // Devices already connected see the new one in the machine's device list.
          void this.announceInfo();
          // A device paired from afar by the code: every device of the account
          // hears of it. Not after an install, which the owner ran on this machine.
          if (via === "totp") this.opts.notifyPaired?.();
        },
        onTotpSet: () => {
          this.log("authenticator pairing set from a paired device");
          void this.announceInfo();
        },
      },
    );
    this.connections.add(conn);
    const timer = setTimeout(() => {
      if (!conn.isOpen) conn.close(1008, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    const idle = setInterval(() => {
      if (Date.now() - conn.lastSeen > IDLE_TIMEOUT_MS) conn.close(1001, "idle");
    }, 15_000);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return conn.close(1003, "binary only");
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      conn.receive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      clearInterval(idle);
      conn.close();
      this.connections.delete(conn);
    });
    ws.on("error", () => conn.close());
  }

  /** What a provider reports, for the selected Claude profile; cached a minute. */
  private async detect(p: AgentProvider): Promise<Detected> {
    let accountDir: string | undefined;
    try {
      accountDir = this.profiles.selectedAccountDir();
    } catch {
      accountDir = undefined; // the profiles cannot be read: sessions say so when they open
    }
    const key = `${p.id}\n${accountDir ?? ""}`;
    const hit = this.detected.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await p.detect(accountDir ? { accountDir } : {});
    this.detected.set(key, { at: Date.now(), value });
    return value;
  }

  async machineInfo(): Promise<MachineInfo> {
    const c = this.config.get();
    const forward = this.localForward.state();
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
      devices: c.devices.map((d) => ({ publicKey: fromBase64Url(d.key), name: d.name, addedAt: BigInt(d.addedAt) })),
      settings: { localForward: forward.enabled, localForwardAvailable: forward.available },
      needsFullDiskAccess: diskAccess() === "needed",
      attachments: attachmentLimitsBody(this.core.attachmentLimits),
      secrets: true,
      gitChanges: true,
      browser: { available: this.browser.available(), running: this.browser.running(), clearable: true },
      screenShare: this.screenShare.supported,
      totpEnabled: this.pairing.enabled,
      agentUpdate: this.updater.info(),
    });
  }

  /**
   * Tells every connected device the machine's profile, the profiles' accounts
   * and usage, and where each session stands. Changes that come together go
   * out as one.
   */
  /** Watches for the owner granting Full Disk Access while it is missing. */
  private readonly diskWatch = new DiskAccessWatch({
    check: () => diskAccess(),
    // Only the installed binary can ask a new copy of itself (not tests, not `bun src/cli.ts`).
    checkFresh: () => (isCompiled() ? freshDiskAccess(selfCommand("disk-access")) : Promise.resolve("not-applicable")),
    onGranted: () => {
      this.log("Full Disk Access granted");
      void this.announceInfo();
    },
    onGrantedAfterRestart: () => {
      if (!underLaunchAgent()) {
        this.log("Full Disk Access granted; restart tunelo to use it");
        return;
      }
      // launchd starts the agent again (KeepAlive); devices reconnect and see it.
      this.log("Full Disk Access granted; restarting to use it");
      process.kill(process.pid, "SIGTERM");
    },
  });

  /** macOS: opens Full Disk Access and the binary in Finder on the machine's screen; false elsewhere. */
  openDiskAccessSettings(): boolean {
    if (process.platform !== "darwin") return false;
    openDiskAccessSettings(process.execPath);
    // Asked from a device, maybe after the access was taken away again.
    this.diskWatch.start();
    return true;
  }

  /** Sends the machine's info to every connected device, unasked. */
  private async announceInfo(): Promise<void> {
    try {
      const value = await this.machineInfo();
      for (const c of this.connections) if (c.isOpen) c.announce({ case: "machineInfo", value });
    } catch (err) {
      this.log(`machine info: not announced (${(err as Error).message})`);
    }
  }

  private announceProfiles(): void {
    if (this.announcing) return;
    this.announcing = setTimeout(() => {
      this.announcing = undefined;
      let profiles: ProfileList;
      try {
        profiles = this.profiles.view();
      } catch (err) {
        this.log(`claude profiles: not announced (${(err as Error).message})`);
        return;
      }
      const value = { profiles: profileListBody(profiles), sessions: this.core.profileStates() };
      for (const c of this.connections) if (c.isOpen) c.announce({ case: "machineProfile", value });
    }, ANNOUNCE_DELAY_MS);
    this.announcing.unref?.();
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

/**
 * A new session's MCP: a ticket of `mcp` for the thread, ended with the
 * session; none when the machine turned tunelo's MCP off (`sessionMcp: false`).
 * With `secrets`, the session's commands can read the secrets it was given;
 * with `browser`, it hears what happened in the tunelo browser.
 */
export function sessionMcpFor(
  mcp: McpHost,
  config: ConfigStore,
  secrets?: SecretService,
  browser?: RemoteBrowser,
): (threadId: string) => SessionMcpLease | undefined {
  return (threadId) => {
    if (config.get().sessionMcp === false) return undefined;
    const ticket = mcp.tickets.issue(threadId);
    // The Chat and Localman tool lists, ready by the time claude asks for them.
    mcp.warm();
    let env: SessionSecretEnv | undefined;
    try {
      env = secrets ? new SessionSecretEnv(secrets, { key: ticket, threadId }, join(config.dir, "data")) : undefined;
    } catch {
      // The data folder cannot be written: the session runs without secrets in its commands.
    }
    return {
      ticket,
      configDir: config.dir,
      approveWrite: (claudeName, input) => mcp.approve(ticket, claudeName, input),
      describeWrite: (claudeName, input) => mcp.describeWrite(claudeName, input),
      ...(env ? { secrets: env } : {}),
      ...(browser ? { browserNotices: () => browser.takeNotices(ticket) } : {}),
      release: () => {
        env?.dispose();
        mcp.release(ticket);
      },
    };
  };
}

// The running service: config, machine key, core, local server (the
// devices' WebSocket, and Localman's requests for localhost under
// `/.tunelo/forward`, tunnels/forward.ts), the account's trusted devices
// (device-trust.ts; a device dropped from the list loses its links at once),
// the "needs you" push decision, and the usage hints (usage/notify.ts) to
// connected devices and as a push.
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { Duplex } from "node:stream";
import { arch, homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { LoginState, MacFolderAccess, type MachineInfo, MachineInfoSchema, ThreadKind, ThreadState, type ThreadSummary, TurnState } from "@achoo254/chat-proto/remote/remote";
import { type KeyPair, PROTOCOL_VERSION, toBase64Url } from "@achoo254/chat-remote-protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { ConfigStore, type TrustedDevice, deviceLabel } from "./config.ts";
import { DeviceTrust } from "./device-trust.ts";
import { AgentCore } from "./core/agent-core.ts";
import { machineKey } from "./keystore.ts";
import { AccountsStore } from "./accounts/store.ts";
import { accountListBody, readAccounts } from "./link/accounts-link.ts";
import { Connection, projectListBody } from "./link/connection.ts";
import { builtinProviders, withAccounts, withHistory } from "./providers/registry.ts";
import type { AccountScopeRef, AccountsFacet, AgentProvider, Detected } from "./providers/types.ts";
import { logFile } from "./log-tail.ts";
import { startLogRotation } from "./log-rotate.ts";
import type { McpHost } from "./mcp/mcp-host.ts";
import type { SessionMcpLease, TicketScope } from "./mcp/session-tickets.ts";
import { AuditLog } from "./safety/audit-log.ts";
import { type MacAccess, MacFolders, hasFullDiskAccess, probeInChild } from "./safety/mac-folders.ts";
import { isCompiled, selfCommand, supervised, termHostUnit } from "./service.ts";
import type { TermHostUnit } from "./terminal/host-supervisor.ts";
import { ControlError } from "./terminal/host-link.ts";
import { TerminalService, aiTerminalsOf } from "./terminal/terminal-service.ts";
import { AgentUpdater } from "./agent-updater.ts";
import { createSensitiveCheck } from "./safety/sensitive-paths.ts";
import { ForwardDenyList } from "./tunnels/forward-deny-ports.ts";
import { LocalForward } from "./tunnels/forward.ts";
import { ForwardSettings } from "./tunnels/forward-settings.ts";
import { AGENT_VERSION } from "./version.ts";
import { attachmentLimitsBody } from "./attachments/uploads.ts";
import { Projects } from "./projects/projects.ts";
import { writeCommitMessage } from "./workspace/commit-message.ts";
import { Workspaces } from "./workspace/workspaces.ts";
import { SessionSecretEnv } from "./sign-in-secrets/secret-env.ts";
import { AdvisorKeyStore } from "./advisor/advisor-key-store.ts";
import { redact } from "./mcp/redact.ts";
import { SecretService } from "./sign-in-secrets/secret-service.ts";
import { RemoteBrowser } from "./remote-browser/remote-browser.ts";
import { ScreenShare } from "./screen-share/screen-share.ts";
import { UsageScheduler } from "./usage/scheduler.ts";
import { type UsageHint, UsageNotifier } from "./usage/notify.ts";
import { type RuleSwitches, ruleSwitches } from "./usage/rules.ts";
import { type UsageApi, usageApiOf, usageSuggestionBody } from "./link/usage-link.ts";

const MAX_CONNECTIONS = 16;
/** How long a macOS prompt for a protected folder may wait on the machine's screen before tunelo stops asking. */
const MAC_PROMPT_WAIT_MS = 5 * 60_000;
const MAC_ACCESS: Record<MacAccess, MacFolderAccess> = {
  "not-asked": MacFolderAccess.NOT_ASKED,
  asking: MacFolderAccess.ASKING,
  granted: MacFolderAccess.GRANTED,
  denied: MacFolderAccess.DENIED,
};
const MAX_HANDSHAKING = 8;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Devices ping every 10 s; a silent connection is dropped. */
const IDLE_TIMEOUT_MS = 45_000;
/** Push only when nobody looked at the machine for this long… */
const PING_FRESH_MS = 15_000;
/** …and the prompt is still waiting after this long. */
const PUSH_DELAY_MS = 20_000;
/** Account changes this close together reach devices as one MachineAccounts. */
const ANNOUNCE_DELAY_MS = 50;

export type MachineOptions = {
  config?: ConfigStore;
  providers?: AgentProvider[];
  /** Sends a content-free "needs you" push through the chat server. */
  /** `providerId`: the AI every waiting request belongs to; "" when they belong to several. */
  notify?: (thread: ThreadSummary, pending: number, providerId: string) => void;
  /** Asks the chat server for a content-free "usage hint" push to the account's devices; rejects when it was not sent. */
  notifyUsage?: () => Promise<void>;
  /** Asks the chat server for a content-free "Advisor answered" push; rejects when it was not sent. */
  notifyAdvisor?: () => Promise<void>;
  log?: (line: string) => void;
  /** tunelo's MCP for the sessions this machine opens (its tickets); absent in tests. */
  mcp?: McpHost;
  /** Sign-in secrets; built from the config folder when not given. */
  secrets?: SecretService;
  /** The tunelo browser; built from the config folder when not given. */
  browser?: RemoteBrowser;
  /** The machine's own Screen Sharing (macOS); built when not given. */
  screenShare?: ScreenShare;
  /**
   * The terminal process's supervised unit; the OS one (launchd, systemd,
   * Run entry) when not given. Tests start the terminal process directly.
   */
  termHostUnit?: TermHostUnit;
  /** Environment for finding the terminal process binary (TUNELO_TERM_HOST_BIN); the process's own when not given. */
  env?: NodeJS.ProcessEnv;
};

export class Machine {
  readonly config: ConfigStore;
  readonly core: AgentCore;
  readonly audit: AuditLog;
  readonly isSensitive: (p: string) => boolean;
  /** macOS: the folders macOS protects, entered only once the user agreed on a device. */
  readonly macFolders: MacFolders;
  readonly projects: Projects;
  readonly secrets: SecretService;
  /** Advisor's TypeSafe key, apart from the sign-in secrets (no session reaches it). */
  readonly advisorKeys: AdvisorKeyStore;
  readonly browser: RemoteBrowser;
  readonly screenShare: ScreenShare;
  readonly terminal: TerminalService;
  readonly workspaces: Workspaces;
  /** The usage ledger and its scans of the AIs' transcripts. */
  readonly usage: UsageScheduler;
  /** The hints for running sessions, after each scan. */
  readonly usageNotifier: UsageNotifier;
  /** Usage for the devices' link. */
  private readonly usageApi: UsageApi;
  private readonly updater: AgentUpdater;
  private announcingProjects: ReturnType<typeof setTimeout> | undefined;
  /** Localman's requests for localhost on this machine. */
  readonly localForward: LocalForward;
  private key: KeyPair | undefined;
  /** The account's devices this machine accepts. */
  readonly trust: DeviceTrust;
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
    this.macFolders = new MacFolders({
      platform: process.platform,
      home: homedir(),
      saved: () => this.config.get().macFolders ?? {},
      save: (folder, answer) => {
        this.config.update((c) => (c.macFolders = { ...c.macFolders, [folder]: answer }));
        // The AI's processes run in a sandbox that keeps this folder out: they restart to reach it.
        if (answer === "granted") this.core.macAccessGranted();
      },
      configDir: dir,
      fullDiskAccess: hasFullDiskAccess,
      // A new copy of tunelo tries the folder: a macOS prompt nobody answers holds that copy, never this one.
      probe: (folder) => probeInChild(selfCommand("mac-folder-access"), folder, MAC_PROMPT_WAIT_MS),
      onChange: () => void this.announceInfo(),
      log: (line) => this.log(line),
    });
    this.audit = new AuditLog(join(dir, "audit.jsonl"));
    this.secrets = opts.secrets ?? new SecretService({ configDir: dir, audit: this.audit });
    this.advisorKeys = new AdvisorKeyStore({ configDir: dir, audit: this.audit, log: this.log });
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
    // One store of every AI's accounts; each AI keeps its own list and pick in it.
    this.providers =
      opts.providers ??
      builtinProviders({
        configDir: dir,
        fences: () => this.macFolders.aiFences(),
        accounts: {
          store: new AccountsStore(dir),
          audit: this.audit,
          inUse: (provider, id) => this.core.accountInUse(provider, id),
          busySessions: (provider) => this.core.openSessionsOf(provider).flatMap((s) => (s.busy ? [s.title] : [])),
          onUsage: (provider, id, usage) => {
            this.core.setAccountUsage(provider, id, usage);
            if (this.providerById(provider)?.usage) this.usage.recordQuota(id, usage);
          },
          log: this.log,
        },
      });
    this.usage = new UsageScheduler({
      configDir: dir,
      sources: () => this.providers.flatMap((p) => (p.usage ? [{ provider: p.id, usage: p.usage }] : [])),
      refreshQuota: () => this.refreshAccountUsage(),
      afterScan: async (scan) => {
        await this.usageNotifier.check(scan.read > 0);
      },
      log: this.log,
    });
    this.usageNotifier = new UsageNotifier({
      ledger: this.usage.ledger,
      rules: () => this.usageRules(),
      deliver: (hints, sentAt) => this.deliverUsageHints(hints, sentAt),
      log: this.log,
    });
    this.usageApi = usageApiOf({
      ledger: this.usage.ledger,
      config: this.config,
      audit: this.audit,
      deleteLedger: () => this.usage.deleteLedger(),
      // Advisor's sessions stay out of the user's statistics, as out of every list.
      hiddenSessions: () => this.core.advisorSessionIds(),
    });
    const c = this.config.get();
    this.trust = new DeviceTrust({ config: this.config });
    const forwardSettings = new ForwardSettings(dir);
    this.localForward = new LocalForward({
      settings: forwardSettings,
      audit: this.audit,
      log: this.log,
      deny: new ForwardDenyList({
        configDir: dir,
        ownPorts: () => (this.port ? [this.port] : []),
        extraPorts: () => forwardSettings.read().blockedPorts,
        ideLockDirs: () => this.providers.flatMap((p) => p.ideLockDirs?.() ?? []),
        log: this.log,
      }),
    });
    this.core = new AgentCore({
      dataDir: join(dir, "data"),
      log: this.log,
      providers: this.providers,
      audit: this.audit,
      isSensitive: this.isSensitive,
      assertMacFolder: (dir) => this.macFolders.assert(dir),
      macFolders: this.macFolders,
      isTrusted: (dir) => this.config.isTrusted(dir),
      trust: (dir, device) => {
        const full = this.config.setTrusted(dir, true);
        this.audit.write({ device, action: "project_settings", path: full, detail: "trust" });
      },
      mcpServers: c.mcpServers,
      maxSessions: c.maxSessions,
      idleMs: c.idleMinutes * 60_000,
      onNeedsInput: (t) => this.maybePush(t),
      sessionAccount: (provider) => this.accountsOf(provider)?.sessionAccount() ?? { id: "" },
      selectedScope: (provider) => this.accountsOf(provider)?.selectedScope(),
      selectedAccountId: (provider) => this.accountsOf(provider)?.selectedId(),
      accountInfo: (provider, id) => this.accountsOf(provider)?.account(id),
      suggestAccount: async (provider, id) => this.accountsOf(provider)?.suggestion(id),
      onSessionAccount: () => this.announceAccounts(),
      onAccountUsage: (provider, id, usage) => {
        this.accountsOf(provider)?.recordUsage(id, usage);
        if (this.providerById(provider)?.usage) this.usage.recordQuota(id, usage, "user");
      },
      onSessionId: (provider, sessionId) => this.usage.launched.add(provider, sessionId),
      ...(opts.mcp ? { sessionMcp: sessionMcpFor(opts.mcp, this.config, this.secrets, this.browser) } : {}),
      sessionMcpEnabled: () => this.sessionMcpEnabled(),
      advisorKeySet: () => this.advisorKeys.status().keySet,
      advisorAuto: () => this.config.get().advisorAuto === true,
      // Read when an Advisor thread opens or is asked, long after both are built.
      isKnownFolder: (dir) => this.projects.projectOf(dir) !== undefined,
      gitFailure: (failureId) => this.workspaces.failures.get(failureId),
      // Built after the core; read only when chat takes a thread back from its terminal.
      closeTerminal: async (session) => {
        try {
          await this.terminal.close(session);
        } catch (err) {
          // Gone already (its CLI exited): the core lets the thread go itself.
          if (!(err instanceof ControlError && err.code === "no_such_session")) throw err;
        }
      },
    });
    // Only an answer: a question that failed, ran out of time or was stopped is not worth a push.
    this.core.onAdvisorAnswer((threadId, _clientMsgId, state) => {
      if (state === TurnState.COMPLETED) void this.advisorAnswered(threadId);
    });
    for (const p of withAccounts(this.providers)) {
      p.accounts?.listen({ onSelect: () => this.core.followMachineAccount(p.id), onChange: () => this.announceAccounts() });
    }
    this.terminal = new TerminalService({
      configDir: dir,
      config: this.config,
      audit: this.audit,
      unit: "termHostUnit" in opts ? opts.termHostUnit : termHostUnit(dir),
      // A shell runs each AI's CLI on the account picked on the machine, made ready as for Chat's sessions
      // (Claude: the machine's settings copied in); the default one needs nothing.
      shellEnv: () => Object.assign({}, ...this.providers.map((p) => p.shellEnv?.(this.shellScope(p.id)) ?? {})),
      ai: aiTerminalsOf(this.core),
      log: this.log,
      onAvailability: () => void this.announceInfo(),
      ...(opts.env ? { env: opts.env } : {}),
    });
    this.projects = new Projects({
      config: this.config,
      audit: this.audit,
      isSensitive: this.isSensitive,
      home: homedir(),
      sessionDirs: async () => {
        const count = new Map<string, number>();
        for (const t of this.core.list()) if (t.kind !== ThreadKind.ADVISOR) count.set(t.dir, (count.get(t.dir) ?? 0) + 1);
        for (const p of withHistory(this.providers)) {
          for (const d of (await this.core.localSessions({ provider: p.id, dir: "", query: "", offset: 0, limit: 1 })).dirs) {
            count.set(d.dir, Math.max(count.get(d.dir) ?? 0, d.sessions));
          }
        }
        return [...count].map(([dir, sessions]) => ({ dir, sessions }));
      },
    });
    this.projects.onChange(() => this.announceProjects());
    this.core.onProjectConfig(() => this.announceProjects());
    this.workspaces = new Workspaces({
      folderOf: (id) => this.projects.folderOf(id),
      audit: this.audit,
      isSensitive: this.isSensitive,
      // git's hooks folder for the right panel: absolute, the agent's own, always empty.
      hooksDir: join(dir, "git-empty-hooks"),
    });
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

  private providerById(id: string): AgentProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /** The accounts of an AI; undefined for an AI that keeps none (or one the machine does not know). */
  private accountsOf(provider: string): AccountsFacet | undefined {
    return this.providerById(provider)?.accounts;
  }

  /** Reads the plan usage of every signed-in account of the AIs whose transcripts feed the usage ledger, one after another. */
  private async refreshAccountUsage(): Promise<void> {
    for (const p of this.providers) {
      const accounts = p.accounts;
      if (!p.usage || !accounts?.refreshUsage) continue;
      let view;
      try {
        view = accounts.view();
      } catch {
        continue; // its accounts cannot be read: nothing to refresh
      }
      for (const a of view.accounts) {
        if (a.status !== "ok") continue;
        await accounts.refreshUsage(a.id).catch((err: unknown) => this.log(`usage: plan usage of a ${p.name} account not read (${(err as Error).message})`));
      }
    }
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
          const value = projectListBody(list, (dir) => this.core.projectConfig(dir));
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
    void this.advisorKeys.loadForRedaction().catch((err: unknown) => this.log(`advisor: ${redact((err as Error).message)}`));
    for (const p of this.providers) void p.accounts?.cleanLeftovers?.();
    for (const p of this.providers) p.accounts?.watch?.();
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
    this.terminal.start();
    for (const s of this.core.sessionIds()) this.usage.launched.add(s.provider, s.sessionId);
    this.usage.start();
    this.log(`tunelo ${AGENT_VERSION} listening on ws://127.0.0.1:${actual}`);
    return actual;
  }

  async stop(): Promise<void> {
    this.secrets.close();
    await this.browser.close();
    this.screenShare.stop();
    this.updater.stop();
    // The terminal process and its shells keep running (they outlive the agent).
    this.terminal.stop();
    this.stopRotation?.();
    clearTimeout(this.announcing);
    for (const c of this.connections) c.close(1001, "shutting down");
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.usage.stop();
    for (const p of this.providers) await p.accounts?.stop?.();
    clearTimeout(this.announcingProjects);
    this.projects.stop();
    this.workspaces.stop();
    await this.core.stop();
  }

  /** Wired once the machine is registered with the chat server. */
  setNotify(fn: (thread: ThreadSummary, pending: number, providerId: string) => void): void {
    this.opts.notify = fn;
  }

  /** Wired once the machine is registered with the chat server. */
  setNotifyUsage(fn: () => Promise<void>): void {
    this.opts.notifyUsage = fn;
  }

  /** Wired once the machine is registered with the chat server. */
  setNotifyAdvisor(fn: () => Promise<void>): void {
    this.opts.notifyAdvisor = fn;
  }

  /**
   * A question to Advisor ended: devices following its thread read the
   * answer from the journal; when none follows it now, or none looked at the
   * machine lately (a phone locked meanwhile), one content-free push says
   * Advisor answered.
   */
  private async advisorAnswered(threadId: string): Promise<void> {
    const watched = Date.now() - this.lastPing < PING_FRESH_MS && [...this.connections].some((c) => c.follows(threadId));
    if (watched) return;
    const push = this.opts.notifyAdvisor;
    if (!push) return;
    try {
      await push();
    } catch (err) {
      this.log(`advisor: answer push not sent (${(err as Error).message})`);
    }
  }

  /** The usage rules switched on now (the user's switches over the defaults). */
  private usageRules(): RuleSwitches {
    return ruleSwitches(this.config.get().usageRules);
  }

  /**
   * Usage hints for running sessions: the details to every connected device
   * over the sealed link, and one content-free push through the chat server
   * for the devices not looking. Delivered when either got through.
   */
  private async deliverUsageHints(all: UsageHint[], sentAt: number): Promise<boolean> {
    // Advisor's sessions are hidden from the user: no hint, no push for them (recorded as handled).
    const advisor = this.core.advisorSessionIds();
    const hints = all.filter((h) => !advisor.has(h.sessionId.toLowerCase()));
    if (hints.length === 0) return true;
    let reached = false;
    for (const c of this.connections) {
      if (!c.isOpen) continue;
      for (const h of hints) c.announce({ case: "usageSuggestion", value: usageSuggestionBody({ ...h, notifiedAt: sentAt }) });
      reached = true;
    }
    const push = this.opts.notifyUsage;
    if (push) {
      try {
        await push();
        reached = true;
      } catch (err) {
        this.log(`usage: hint push not sent (${(err as Error).message})`);
      }
    }
    return reached;
  }

  /** The machine's key pair; there once start() loaded it. */
  get keyPair(): KeyPair {
    if (!this.key) throw new Error("the machine key is not loaded yet");
    return this.key;
  }

  get publicKey(): Uint8Array {
    return this.keyPair.publicKey;
  }

  /** The device keys with an open link now, for the heartbeat. */
  connectedDeviceKeys(): Uint8Array[] {
    const seen = new Map<string, Uint8Array>();
    for (const c of this.connections) {
      const k = c.isOpen ? c.deviceKey : undefined;
      if (k) seen.set(toBase64Url(k), k);
    }
    return [...seen.values()];
  }

  /**
   * The owner's devices as Chat just listed them: stored with the time, and
   * compared with the list before. A device that left the list (revoked on
   * the web, or its session ended) loses every link and terminal now; both
   * changes go to the consent log.
   */
  applyTrustedDevices(list: readonly TrustedDevice[]): void {
    const { added, removed } = this.config.syncTrustedDevices(list);
    this.trust.listed(added.map((d) => d.key));
    for (const d of added) {
      this.audit.write({ device: deviceLabel(d.key, d.name), action: "device_added", path: "", detail: d.platform });
      this.log(`new device of the account: ${deviceLabel(d.key, d.name)}`);
    }
    for (const d of removed) {
      this.audit.write({ device: deviceLabel(d.key, d.name), action: "revoke", path: "", detail: "revoked by the account" });
      this.log(`device revoked by the account: ${deviceLabel(d.key, d.name)}`);
      this.dropDevice(d.key);
    }
  }

  /**
   * The machine left the owner's account (removed on the web, or `tunelo
   * logout`): it trusts no device until Chat lists them again, and every link
   * closes now.
   */
  leftAccount(): void {
    const keys = this.config.get().trustedDevices?.list.map((d) => d.key) ?? [];
    this.config.update((c) => {
      c.trustedDevices = { list: [], syncedAt: 0, revoked: c.trustedDevices?.revoked ?? [] };
    });
    for (const c of this.connections) c.close(4001, "the machine left the account");
    for (const k of keys) this.terminal.revokeDevice(k);
  }

  /** Cuts every live connection of a revoked device (whole base64url key), and its terminal links, direct ones included. */
  private dropDevice(key: string): void {
    for (const c of this.connections) {
      const k = c.deviceKey;
      if (k && toBase64Url(k) === key) c.close(4001, "revoked");
    }
    this.terminal.revokeDevice(key);
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
        machineKey: () => this.keyPair,
        trust: this.trust,
        onRefused: (key, verdict) => this.log(`refused a device (${deviceLabel(key)}): ${refusalReason(verdict)}`),
        machineInfo: () => this.machineInfo(),
        isSensitive: this.isSensitive,
        providers: this.providers,
        projects: this.projects,
        localForward: this.localForward,
        secrets: this.secrets,
        browser: this.browser,
        screenShare: this.screenShare,
        updater: this.updater,
        terminal: this.terminal,
        workspaces: this.workspaces,
        commitMessage: (req) =>
          writeCommitMessage(
            { providers: this.providers, staged: (id) => this.workspaces.stagedChanges(id), detect: (p) => this.detect(p), account: (providerId) => this.accountsOf(providerId)?.selectedScope() },
            req,
          ),
        usage: this.usageApi,
        advisorKeys: this.advisorKeys,
        onAdvisorKey: () => this.advisorKeyChanged(),
        advisorAuto: { available: () => this.sessionMcpEnabled(), set: (on, device) => this.setAdvisorAuto(on, device) },
        macFolders: this.macFolders,
        onPing: () => (this.lastPing = Date.now()),
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

  /** The account picked on the machine for this AI; undefined for its own sign-in, or when its accounts cannot be read. */
  private selectedScope(providerId: string): AccountScopeRef | undefined {
    try {
      return this.accountsOf(providerId)?.selectedScope();
    } catch {
      return undefined; // the accounts cannot be read: sessions say so when they open
    }
  }

  /**
   * The account a new terminal runs an AI's CLI on, prepared like a session's.
   * Preparing it may fail (a settings copy the system refused): the picked
   * account still applies, never the AI's own sign-in in its place; only
   * accounts that cannot be read at all leave the shell on its own sign-in.
   */
  private shellScope(providerId: string): AccountScopeRef | undefined {
    try {
      return this.accountsOf(providerId)?.sessionAccount().scope;
    } catch (err) {
      this.log(`terminal: ${providerId} account not prepared (${(err as Error).message})`);
      return this.selectedScope(providerId);
    }
  }

  /** What a provider reports, for the account picked on the machine; cached a minute. */
  private async detect(p: AgentProvider): Promise<Detected> {
    const account = this.selectedScope(p.id);
    const key = `${p.id}\n${account?.dir ?? ""}`;
    const hit = this.detected.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await p.detect(account ? { account } : {});
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
        // Devices also check MachineInfo.terminal before offering it. What the facets give is said from the facets.
        capabilities: { ...p.capabilities, terminal: p.terminal !== undefined, chatTakesTerminal: p.terminal !== undefined, commitMessage: p.writer !== undefined, accounts: p.accounts !== undefined },
        untestedVersion: Boolean(d.untestedVersion),
        defaultModel: d.defaultModel ?? "",
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
      settings: { localForward: forward.enabled, localForwardAvailable: forward.available },
      macFolders: this.macFolders.list().map((f) => ({ path: f.path, access: MAC_ACCESS[f.access] })),
      attachments: attachmentLimitsBody(this.core.attachmentLimits),
      secrets: true,
      gitChanges: true,
      browser: { available: this.browser.available(), running: this.browser.running(), clearable: true },
      screenShare: this.screenShare.supported,
      agentUpdate: this.updater.info(),
      terminal: this.terminal.availability(),
      advisor: { available: this.sessionMcpEnabled(), ...this.advisorStatus() },
    });
  }

  /** Sessions run with tunelo's MCP: the service has one and the machine did not turn it off. */
  private sessionMcpEnabled(): boolean {
    return this.opts.mcp !== undefined && this.config.get().sessionMcp !== false;
  }

  private advisorStatus(): { keySet: boolean; keyFingerprint: string; setByDevice: string; setAt: bigint; auto: boolean } {
    const s = this.advisorKeys.status();
    return { keySet: s.keySet, keyFingerprint: s.fingerprint, setByDevice: s.setByDevice, setAt: BigInt(s.setAt), auto: this.config.get().advisorAuto === true };
  }

  /**
   * Automatic Advisor for every session of the machine (AdvisorSetAuto): kept
   * in the config, every session follows at once, every device hears the
   * machine's info again. Nothing happens when it already is so.
   */
  setAdvisorAuto(on: boolean, device: string): void {
    if ((this.config.get().advisorAuto === true) === on) return;
    this.config.update((c) => {
      if (on) c.advisorAuto = true;
      else delete c.advisorAuto;
    });
    this.core.advisorAutoChanged();
    this.audit.write({ device, action: on ? "advisor_auto_on" : "advisor_auto_off", path: "", detail: "" });
    void this.announceInfo();
  }

  /**
   * Advisor's key was set or removed (from a device, or `tunelo advisor` on
   * the machine): the key is hidden from this process's output from now on
   * and every connected device hears the machine's info again.
   */
  advisorKeyChanged(): void {
    void this.advisorKeys.loadForRedaction().catch((err: unknown) => this.log(`advisor: ${redact((err as Error).message)}`));
    void this.announceInfo();
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

  /**
   * Tells every connected device each AI's accounts, its pick and usage, and
   * where each session stands. Changes that come together go out as one.
   */
  private announceAccounts(): void {
    if (this.announcing) return;
    this.announcing = setTimeout(() => {
      this.announcing = undefined;
      void readAccounts(this.providers, (f) => f.view()).then((reads) => {
        const value = { accounts: accountListBody(reads), sessions: this.core.accountStates() };
        for (const c of this.connections) if (c.isOpen) c.announce({ case: "machineAccounts", value });
      });
    }, ANNOUNCE_DELAY_MS);
    this.announcing.unref?.();
  }

  private maybePush(thread: ThreadSummary): void {
    // Advisor's threads never wait for the user (nothing asks there); never a "needs you" push for one.
    if (thread.kind === ThreadKind.ADVISOR) return;
    setTimeout(() => {
      const now = this.core.list().find((t) => t.id === thread.id);
      if (!now || now.state !== ThreadState.WAITING) return;
      if (Date.now() - this.lastPing < PING_FRESH_MS) return;
      const waiting = this.core.list().filter((t) => t.pending > 0 && t.kind !== ThreadKind.ADVISOR);
      const pending = waiting.reduce((n, t) => n + t.pending, 0);
      const ais = new Set([now.provider, ...waiting.map((t) => t.provider)]);
      if (this.opts.notify) this.opts.notify(now, pending, ais.size === 1 ? now.provider : "");
      else this.log(`needs you: "${now.title}" (${pending} waiting)`);
    }, PUSH_DELAY_MS).unref?.();
  }
}

function refusalReason(verdict: string): string {
  if (verdict === "stale") return "this machine has not reached Chat for over 24 hours";
  if (verdict === "revoked") return "revoked by the account";
  return "not a device of the machine's account";
}

/**
 * A new session's MCP: a ticket of `mcp` for the thread, ended with the
 * session; none when the machine turned tunelo's MCP off (`sessionMcp: false`).
 * With `secrets`, the session's commands can read the secrets it was given;
 * with `browser`, it hears what happened in the tunelo browser. A ticket of
 * scope "advisor-weigh" (the AI's CLI in a terminal) offers advisor_weigh
 * only: no secrets in its commands, no browser notices.
 */
export function sessionMcpFor(
  mcp: McpHost,
  config: ConfigStore,
  secrets?: SecretService,
  browser?: RemoteBrowser,
): (threadId: string, scope?: TicketScope) => SessionMcpLease | undefined {
  return (threadId, scope = "session") => {
    if (config.get().sessionMcp === false) return undefined;
    const ticket = mcp.tickets.issue(threadId, scope);
    if (scope === "advisor-weigh") {
      return {
        ticket,
        configDir: config.dir,
        advisorWeighOnly: true,
        // advisor_weigh is never a write: nothing to approve or describe.
        approveWrite: () => undefined,
        describeWrite: () => Promise.resolve(undefined),
        release: () => mcp.release(ticket),
      };
    }
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
      approveWrite: (exposed, input) => mcp.approve(ticket, exposed, input),
      describeWrite: (exposed, input) => mcp.describeWrite(exposed, input),
      ...(env ? { secrets: env } : {}),
      ...(browser ? { browserNotices: () => browser.takeNotices(ticket) } : {}),
      release: () => {
        env?.dispose();
        mcp.release(ticket);
      },
    };
  };
}

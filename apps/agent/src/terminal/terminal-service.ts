// The machine's terminal, one per agent: it keeps the link to
// tunelo-term-host (started under its own supervised unit on first use),
// grants links to paired devices, routes the terminal process's events and
// relay frames to the device connection that owns each link, and is the one
// writer of the terminal's consent-log lines. Revocations reach the terminal
// process at once (`revoke_device`) and again after every reconnect
// (`set_revoked`, before any grant).
//
// Connections outlive the agent (a direct peer keeps running in the terminal
// process), but a new agent run cannot know them, so it could never close
// them: a client that stopped acknowledging would hold the shared session's
// window for everyone. After every hello the connections the terminal process
// lists and this run does not hold are orphans; those still orphaned after a
// grace period are closed with `conn_close`. Sessions are never touched: the
// device re-links and Attaches with its last offset.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, TerminalAvailability, type TermListResultSchema } from "@achoo254/chat-proto/remote/remote";
import { fromBase64Url, toBase64Url } from "@achoo254/chat-remote-protocol";
import { type ConfigStore, deviceLabel } from "../config.ts";
import { AgentError, type AgentCore, type TerminalSpec } from "../core/agent-core.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import { AGENT_VERSION } from "../version.ts";
import { Grants, TerminalDenied } from "./grants.ts";
import { ControlError, type DaemonAudit, type DaemonEvent, type HelloResult, sessionListSchema } from "./host-link.ts";
import { HostSupervisor, type TermHostUnit, type TerminalAvailabilityState, TerminalUnavailable } from "./host-supervisor.ts";
import { type TerminalPeer, TerminalConnection } from "./terminal-connection.ts";
import { TerminalError } from "./terminal-error.ts";

/** Terminal frames the machine sends over the relay per second, all links together (the relay carries chat too). */
export const RELAY_FRAMES_PER_SECOND = 200;
const RELAY_BURST = 40;
/** Frames one connection may send in a turn before the others get theirs. */
const FLUSH_TURN = 8;
/** Sessions the terminal process keeps at most (docs/terminal-wire.md). */
export const MAX_TERMINAL_SESSIONS = 20;
/** How long a connection left by an earlier agent run may live before this run closes it. */
export const ORPHAN_GRACE_MS = 30_000;

/** A token bucket: `rate` tokens a second, at most `burst` saved. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.at = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) * this.rate) / 1000);
    this.at = t;
  }

  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until the next token. */
  wait(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 1000) / this.rate);
  }
}

/**
 * The threads whose AI a device opens in the terminal (the agent core). The
 * device names a thread only; what runs comes from `launch`. Sessions are
 * named with the terminal process's pid, since its ids start again with a
 * new process.
 */
export interface AiTerminals {
  /** What to run for the thread's AI; throws (an AgentError) when it cannot run there now. */
  launch(threadId: string): Promise<TerminalSpec>;
  sessionOf(threadId: string, pid: number): number | undefined;
  /** "" when no thread's AI runs in it. */
  threadOf(session: number, pid: number): string;
  started(threadId: string, session: number, pid: number): void;
  ended(session: number, pid: number): void;
  /** Only these sessions still run in terminal process `pid`. */
  alive(pid: number, sessions: ReadonlySet<number>): void;
}

/** The core as the terminal sees it. */
export function aiTerminalsOf(core: AgentCore): AiTerminals {
  return {
    launch: (threadId) => core.terminalLaunch(threadId),
    sessionOf: (threadId, pid) => core.terminalSession(threadId, pid),
    threadOf: (session, pid) => core.terminalThread(session, pid),
    started: (threadId, session, pid) => core.terminalStarted(threadId, session, pid),
    ended: (session, pid) => core.terminalEnded(session, pid),
    alive: (pid, sessions) => core.terminalAlive(pid, sessions),
  };
}

export type TerminalServiceOptions = {
  configDir: string;
  config: ConfigStore;
  audit: AuditLog;
  unit: TermHostUnit | undefined;
  /** CLAUDE_CONFIG_DIR of the machine's selected Claude profile; undefined for the default one. */
  claudeConfigDir?: () => string | undefined;
  /** Threads whose AI opens in the terminal; without it TermOpen.ai_session is refused. */
  ai?: AiTerminals;
  log: (line: string) => void;
  /** MachineInfo.terminal changed. */
  onAvailability?: () => void;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  /** Grace before closing connections this run does not hold (default ORPHAN_GRACE_MS; tests shorten it). */
  orphanGraceMs?: number;
};

type Route = { owner: TerminalConnection; link: number };
type ErrorBody = { code: ErrorCode; message: string; reason: ErrorReason; subject: string };

const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/;

export class TerminalService {
  private readonly supervisor: HostSupervisor;
  private readonly grants: Grants;
  private readonly routes = new Map<number, Route>();
  private readonly owners = new Set<TerminalConnection>();
  private readonly budget = new TokenBucket(RELAY_FRAMES_PER_SECOND, RELAY_BURST);
  private readonly backlog = new Set<TerminalConnection>();
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  /** Audit lines written for this terminal process (pid) up to this seq. */
  private auditPid = 0;
  private auditSeq = 0;
  private hostPid = 0;
  /** Connections listed by the last hello that this run does not hold; closed when the grace ends. */
  private orphans = new Set<number>();
  private orphanTimer: ReturnType<typeof setTimeout> | undefined;
  /** A thread's AI being opened, so two devices asking at once share one terminal. */
  private readonly aiOpening = new Map<string, Promise<number>>();
  /** The folder each session opened in (the terminal process does not keep it). */
  private readonly cwds = new Map<number, string>();

  constructor(private readonly opts: TerminalServiceOptions) {
    this.supervisor = new HostSupervisor({
      configDir: opts.configDir,
      agentVersion: AGENT_VERSION,
      unit: opts.unit,
      revoked: () => this.revokedKeys(),
      onEvent: (e) => this.onEvent(e),
      onRelay: (conn, frame) => {
        const r = this.routes.get(conn);
        if (r) r.owner.output(r.link, frame);
      },
      onHello: (hello) => this.findOrphans(hello),
      onReady: (hello) => this.onReady(hello),
      onDown: () => {
        this.opts.log("terminal: lost the terminal process");
        for (const owner of this.owners) owner.hostDown();
      },
      onAvailability: () => opts.onAvailability?.(),
      log: opts.log,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.execPath ? { execPath: opts.execPath } : {}),
    });
    this.grants = new Grants({
      isPaired: (k) => opts.config.deviceStatus(k) === "paired",
      call: (cmd, params) => this.supervisor.link.call(cmd, params),
      denied: (k, why) => this.write(toBase64Url(k), `denied (${why})`),
    });
  }

  /** Joins a terminal process that kept running across an agent restart. */
  start(): void {
    this.supervisor.attachExisting();
  }

  /** The agent stops; the terminal process and its shells keep running. */
  stop(): void {
    clearTimeout(this.drainTimer);
    clearTimeout(this.orphanTimer);
    this.orphans.clear();
    this.supervisor.stop();
  }

  availability(): TerminalAvailability {
    const state: TerminalAvailabilityState = this.supervisor.availability();
    return state === "available"
      ? TerminalAvailability.AVAILABLE
      : state === "missing"
        ? TerminalAvailability.MISSING
        : TerminalAvailability.INCOMPATIBLE;
  }

  /** The terminal part of one device connection. */
  connection(peer: TerminalPeer): TerminalConnection {
    const owner = new TerminalConnection(this, peer);
    this.owners.add(owner);
    return owner;
  }

  /** The device connection closed. */
  forget(owner: TerminalConnection): void {
    owner.close();
    this.owners.delete(owner);
    this.backlog.delete(owner);
  }

  /** Revoked keys as the terminal process takes them (whole 32-byte keys only). */
  private revokedKeys(): string[] {
    return this.opts.config.get().revoked.filter(isDeviceKey);
  }

  /** A device was just revoked (its whole key): its terminal links close now. */
  revokeDevice(key: string): void {
    if (!isDeviceKey(key) || !this.supervisor.link.isReady) return; // set_revoked carries it on the next connect
    this.supervisor.link.call("revoke_device", { deviceKey: key }).then(
      (r) => {
        const closed = (r as { closed?: unknown }).closed;
        if (typeof closed === "number" && closed > 0) this.opts.log(`terminal: revocation closed ${closed} link(s)`);
      },
      (err: unknown) => this.opts.log(`terminal: revocation not delivered now (${(err as Error).message}); sent again on reconnect`),
    );
  }

  assertPaired(deviceKey: Uint8Array | undefined): void {
    if (deviceKey && this.opts.config.deviceStatus(deviceKey) === "paired") return;
    if (deviceKey) this.write(toBase64Url(deviceKey), "denied (not paired)");
    throw new TerminalDenied("this device is not paired with the machine");
  }

  ensure(): Promise<void> {
    return this.supervisor.ensureRunning();
  }

  call(cmd: string, params: Record<string, unknown>): Promise<unknown> {
    return this.supervisor.link.call(cmd, params);
  }

  async list(): Promise<MessageInitShape<typeof TermListResultSchema>> {
    await this.ensure();
    const sessions = sessionListSchema.parse(await this.call("list", {}));
    const live = new Set(sessions.map((s) => s.session));
    for (const session of this.cwds.keys()) if (!live.has(session)) this.cwds.delete(session);
    return {
      maxSessions: MAX_TERMINAL_SESSIONS,
      sessions: sessions.map((s) => ({
        session: s.session,
        title: s.title,
        cols: s.cols,
        rows: s.rows,
        createdAt: BigInt(s.createdAt),
        attached: s.attached,
        exited: s.exited !== undefined,
        exitCode: s.exited?.code ?? 0,
        exitSignal: s.exited?.signal ?? 0,
        threadId: this.opts.ai?.threadOf(s.session, this.hostPid) ?? "",
        cwd: this.cwds.get(s.session) ?? "",
      })),
    };
  }

  async open(cols: number, rows: number, cwd: string): Promise<number> {
    await this.ensure();
    let claude: string | undefined;
    try {
      claude = this.opts.claudeConfigDir?.();
    } catch (err) {
      // The profiles cannot be read: the shell starts with the user's own environment.
      this.opts.log(`terminal: Claude profile not applied (${(err as Error).message})`);
    }
    const r = await this.call("open", { cols, rows, cwd, ...(claude ? { env: { CLAUDE_CONFIG_DIR: claude } } : {}) });
    const session = (r as { session?: unknown }).session;
    if (typeof session !== "number") throw new Error("the terminal process did not name the session");
    this.cwds.set(session, cwd);
    return session;
  }

  /**
   * The thread's AI in its own CLI: the session already running it, or a new
   * one running what the core picked for the thread (a device never names a
   * program, its arguments, folder or environment).
   */
  async openAi(threadId: string, cols: number, rows: number): Promise<number> {
    const ai = this.opts.ai;
    if (!ai) throw new TerminalError(ErrorCode.INVALID, ErrorReason.UNSUPPORTED_REQUEST, "this machine does not open an AI in the terminal");
    const opening = this.aiOpening.get(threadId);
    if (opening) return opening;
    const run = (async () => {
      await this.ensure();
      const running = ai.sessionOf(threadId, this.hostPid);
      if (running !== undefined) return running;
      const { shell, args, cwd, env: vars } = await ai.launch(threadId);
      const withVars = Object.keys(vars).length > 0 ? { env: vars } : {};
      const r = await this.call("open", { cols, rows, shell, args, cwd, ...withVars });
      const session = (r as { session?: unknown }).session;
      if (typeof session !== "number") throw new Error("the terminal process did not name the session");
      this.cwds.set(session, cwd);
      ai.started(threadId, session, this.hostPid);
      return session;
    })();
    this.aiOpening.set(threadId, run);
    try {
      return await run;
    } finally {
      this.aiOpening.delete(threadId);
    }
  }

  async close(session: number): Promise<void> {
    await this.ensure();
    await this.call("close", { session });
    this.cwds.delete(session);
    // "Kết thúc" of a thread's AI: chat may write again even if no exit event comes.
    this.opts.ai?.ended(session, this.hostPid);
  }

  async resize(session: number, cols: number, rows: number): Promise<void> {
    await this.ensure();
    await this.call("resize", { session, cols, rows });
  }

  /** Grants a new terminal connection to the device and routes its events to `owner`'s link. */
  async grant(deviceKey: Uint8Array | undefined, owner: TerminalConnection, link: number): Promise<number> {
    if (!deviceKey) throw new TerminalDenied("the device's link is not open");
    const conn = await this.grants.grant(deviceKey);
    this.routes.set(conn, { owner, link });
    return conn;
  }

  /** A link ended: no more routing; `tell` closes it in the terminal process too. */
  release(conn: number, tell: boolean): void {
    this.routes.delete(conn);
    if (tell && this.supervisor.link.isReady) this.call("conn_close", { conn }).catch(() => undefined); // already gone there
  }

  relay(conn: number, frame: Uint8Array): boolean {
    return this.supervisor.link.relay(conn, frame);
  }

  takeToken(): boolean {
    return this.budget.take();
  }

  /** `owner` holds output: it is sent as the budget and its socket allow. */
  wake(owner: TerminalConnection): void {
    this.backlog.add(owner);
    if (!this.drainTimer) this.scheduleDrain(this.budget.wait());
  }

  private scheduleDrain(ms: number): void {
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drain();
    }, Math.max(1, ms));
    this.drainTimer.unref?.();
  }

  /** Turns of at most FLUSH_TURN frames per connection, until the budget is spent or only full sockets are left. */
  private drain(): void {
    let budgetBound = false;
    while (this.backlog.size > 0 && !budgetBound) {
      let moved = false;
      for (const owner of [...this.backlog]) {
        const r = owner.flush(FLUSH_TURN);
        if (r === "socket") continue;
        moved = true;
        if (r === "done") this.backlog.delete(owner);
        else if (this.budget.wait() > 0) {
          budgetBound = true;
          break;
        }
      }
      if (!moved) break;
    }
    // A full socket is looked at again shortly; it has no event to wait on.
    if (this.backlog.size > 0) this.scheduleDrain(budgetBound ? this.budget.wait() : 5);
  }

  /** What a refused request says to the device. */
  errorBody(err: unknown): ErrorBody {
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    if (err instanceof TerminalError) return { code: err.code, message, reason: err.reason, subject: err.subject };
    if (err instanceof AgentError) return { code: err.code, message, reason: err.reason, subject: err.subject };
    if (err instanceof TerminalUnavailable) return { code: ErrorCode.INVALID, message, reason: ErrorReason.TERMINAL_UNAVAILABLE, subject: "" };
    if (err instanceof TerminalDenied) return { code: ErrorCode.INVALID, message, reason: ErrorReason.ACCESS_DENIED, subject: "" };
    if (err instanceof ControlError) {
      switch (err.code) {
        case "session_limit":
          return { code: ErrorCode.INVALID, message, reason: ErrorReason.TERMINAL_SESSION_LIMIT, subject: "" };
        case "no_such_session":
          return { code: ErrorCode.NOT_FOUND, message, reason: ErrorReason.TERMINAL_SESSION_NOT_FOUND, subject: "" };
        case "no_such_conn":
          return { code: ErrorCode.NOT_FOUND, message, reason: ErrorReason.UNSPECIFIED, subject: "" };
        case "revoked":
          return { code: ErrorCode.INVALID, message, reason: ErrorReason.ACCESS_DENIED, subject: "" };
        case "bad_request":
          return { code: ErrorCode.INVALID, message, reason: ErrorReason.UNSPECIFIED, subject: "" };
        default:
          return { code: ErrorCode.INTERNAL, message, reason: ErrorReason.UNSPECIFIED, subject: "" };
      }
    }
    if (!this.supervisor.link.isReady) return { code: ErrorCode.INVALID, message, reason: ErrorReason.TERMINAL_UNAVAILABLE, subject: "" };
    return { code: ErrorCode.INTERNAL, message, reason: ErrorReason.UNSPECIFIED, subject: "" };
  }

  /** Why a link that could not open ends (TermStatus.reason). */
  closeReason(err: unknown): string {
    if (err instanceof TerminalDenied || (err instanceof ControlError && err.code === "revoked")) return "revoked";
    if (err instanceof ControlError && err.code === "no_such_conn") return "closed";
    return "unavailable";
  }

  /**
   * This run holds `conn`: it is routed to a link, or its grant is on the way
   * (Grants clears that only as the grant resolves, and the route is set in
   * the same turn, so no timer runs in between).
   */
  private holds(conn: number): boolean {
    return this.routes.has(conn) || this.grants.isGranting(conn);
  }

  /** After a hello: every listed connection this run does not hold becomes an orphan (a minor 0 terminal process lists none). */
  private findOrphans(hello: HelloResult): void {
    clearTimeout(this.orphanTimer);
    this.orphanTimer = undefined;
    this.orphans = new Set((hello.connections ?? []).map((c) => c.conn).filter((conn) => !this.holds(conn)));
    if (this.orphans.size === 0) return;
    const grace = this.opts.orphanGraceMs ?? ORPHAN_GRACE_MS;
    this.opts.log(`terminal: ${this.orphans.size} connection(s) left by an earlier agent run; closing them in ${Math.round(grace / 1000)} s`);
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = undefined;
      this.closeOrphans();
    }, grace);
    this.orphanTimer.unref?.();
  }

  /** Closes the orphans still orphaned. Without a link they wait for the next hello, which lists them again. */
  private closeOrphans(): void {
    if (!this.supervisor.link.isReady) return;
    const closing = [...this.orphans].filter((conn) => !this.holds(conn));
    this.orphans.clear();
    for (const conn of closing) {
      this.call("conn_close", { conn }).then(
        () => this.opts.log(`terminal: closed connection ${conn} left by an earlier agent run`),
        (err: unknown) => {
          // no_such_conn: it ended by itself meanwhile.
          if (!(err instanceof ControlError && err.code === "no_such_conn")) this.opts.log(`terminal: could not close connection ${conn} (${(err as Error).message})`);
        },
      );
    }
  }

  private onReady(hello: HelloResult): void {
    this.hostPid = hello.pid;
    this.opts.log(`terminal: connected (terminal process ${hello.daemonVersion}, ${hello.sessions.length} session(s))`);
    this.opts.ai?.alive(hello.pid, new Set(hello.sessions.filter((s) => s.exited === undefined).map((s) => s.session)));
    this.audit(hello.pendingAudit);
  }

  private onEvent(e: DaemonEvent): void {
    switch (e.event) {
      case "audit":
        return this.audit([e]);
      case "session_exit":
        // The attached links get the Exit frame; a thread's AI that exited lets chat write again.
        this.opts.ai?.ended(e.session, this.hostPid);
        return;
      case "signal":
      case "conn_state": {
        if (e.event === "signal" && e.kind === "end" && e.reason === "dtls_failed") {
          // A peer whose DTLS fingerprint did not match the signed offer.
          this.write(this.routeKey(e.conn), `dtls_failed conn ${e.conn}`);
        }
        const r = this.routes.get(e.conn);
        if (e.event === "conn_state" && e.state === "closed") {
          this.routes.delete(e.conn);
          this.orphans.delete(e.conn);
        }
        r?.owner.event(r.link, e);
        return;
      }
    }
  }

  private routeKey(conn: number): string | undefined {
    const r = this.routes.get(conn);
    const key = r?.owner.deviceKey();
    return key ? toBase64Url(key) : undefined;
  }

  /** Writes the terminal process's audit events once each (by seq), then acknowledges them. */
  private audit(events: readonly DaemonAudit[]): void {
    if (this.hostPid !== this.auditPid) {
      this.auditPid = this.hostPid;
      this.auditSeq = 0;
    }
    let top = 0;
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (e.seq <= this.auditSeq) continue;
      this.write(e.deviceKey, auditDetail(e), e.at);
      this.auditSeq = e.seq;
      top = e.seq;
    }
    if (top > 0) this.call("ack_audit", { upTo: top }).catch((err: unknown) => this.opts.log(`terminal: audit not acknowledged (${(err as Error).message})`));
  }

  private write(deviceKey: string | undefined, detail: string, at?: number): void {
    const name = deviceKey ? this.opts.config.get().devices.find((d) => d.key === deviceKey)?.name : undefined;
    this.opts.audit.write({ device: deviceKey ? deviceLabel(deviceKey, name) : "unknown", action: "terminal", path: "", detail, ...(at ? { at } : {}) });
  }
}

/** The consent-log detail of a terminal process's audit event: ids and kind, never content. */
export function auditDetail(e: DaemonAudit): string {
  const conn = e.conn !== undefined ? ` conn ${e.conn}` : "";
  if (e.kind === "denied") return `denied (revoked)${conn}`;
  return `${e.kind} session ${e.session ?? 0}${conn}`;
}

function isDeviceKey(key: string): boolean {
  if (!DEVICE_KEY.test(key)) return false;
  try {
    return fromBase64Url(key).length === 32;
  } catch {
    return false;
  }
}

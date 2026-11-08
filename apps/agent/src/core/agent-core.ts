// The agent core: threads (chat windows), their AI sessions, the journal,
// permission prompts, the session limit and idle parking. Knows nothing about
// the network or which AI runs; adapters plug in through AgentProvider.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  type Answers,
  type Cursor,
  Decision,
  ErrorCode,
  type Item,
  PromptState,
  Role,
  ThreadState,
  type ThreadSummary,
  ThreadSummarySchema,
  type ThreadInfo,
  ThreadInfoSchema,
  TodoState,
  ToolKind,
  TurnState,
} from "@achoo254/chat-proto/remote/remote";
import { type Resume, resumeFrom } from "@achoo254/chat-remote-protocol";
import type { AuditLog } from "../safety/audit-log.ts";
import { mentionsSensitive } from "../safety/sensitive-paths.ts";
import type {
  AgentProvider,
  ApprovalAnswer,
  ApprovalRequest,
  AskUser,
  ProviderEvent,
  ProviderInfo,
  ProviderSession,
  QuestionAnswer,
  QuestionRequest,
  ToolKind as Kind,
} from "../providers/types.ts";
import { buildHandoff, gitChanges } from "../threads/handoff.ts";
import { gitBranch } from "../safety/dirs.ts";
import { type ItemBody, Journal } from "../threads/journal.ts";
import type { SessionMcpLease } from "../mcp/session-tickets.ts";

export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Segment = { provider: string; model: string; sessionId?: string; startedSeq: string };

type ThreadMeta = {
  id: string;
  title: string;
  dir: string;
  provider: string;
  model: string;
  projectSettings: boolean;
  createdAt: number;
  updatedAt: number;
  segments: Segment[];
  /** Picked on a device; unset follows the machine's own AI settings. */
  effort?: string;
  permissionMode?: string;
  /** The mode the machine's own settings started the last session in. */
  machineMode?: string;
  /** The AI account profile the last session opened with; unset for the default one. */
  profileId?: string;
  /** Last statusline data, kept so a parked or restarted thread still shows it. */
  info?: Omit<ProviderInfo, "rateLimits" | "account">;
};

/** Last statusline data of one AI account profile. */
type AccountState = { rateLimits?: ProviderInfo["rateLimits"]; account?: ProviderInfo["account"] };

type Pending = {
  itemId: string;
  kind: "approval" | "question";
  sensitive: boolean;
  resolve: (a: ApprovalAnswer | QuestionAnswer) => void;
};

type Thread = {
  meta: ThreadMeta;
  journal: Journal;
  session?: ProviderSession;
  starting?: Promise<ProviderSession>;
  queued: boolean;
  outbox: string[];
  running: boolean;
  turnItem?: string;
  turnCount: number;
  lastActive: number;
  pending: Map<string, Pending>;
  textItems: Map<string, string>;
  dirtyText: Set<string>;
  flushTimer?: ReturnType<typeof setTimeout>;
  usage?: { tokens: number; window: number };
  info: Omit<ProviderInfo, "rateLimits" | "account">;
  clientMsgIds: Set<string>;
  /** The open session has not reported its permission mode yet. */
  modeUnseen: boolean;
};

export type CoreOptions = {
  dataDir: string;
  providers: AgentProvider[];
  audit: AuditLog;
  isSensitive: (path: string) => boolean;
  /** Project settings load only in folders the owner trusted on the machine. */
  isTrusted?: (dir: string) => boolean;
  mcpServers?: Record<string, unknown>;
  maxSessions?: number;
  idleMs?: number;
  /** Called when a thread starts waiting for the user. */
  onNeedsInput?: (thread: ThreadSummary) => void;
  /** The AI account profile a new session opens with; the default one when unset. Throws when it cannot tell. */
  profile?: () => { id: string; accountDir?: string };
  /** The account folder of the selected profile, only looked up (for checking its sign-in). */
  selectedAccountDir?: () => string | undefined;
  /** tunelo's own MCP for a new session of the thread `threadId`; none when it is off. */
  sessionMcp?: (threadId: string) => SessionMcpLease | undefined;
  /** A session reported plan usage for its profile ("" for the default one). */
  onProfileUsage?: (profileId: string, rateLimits: NonNullable<ProviderInfo["rateLimits"]>) => void;
  now?: () => number;
};

const KIND: Record<Kind, ToolKind> = {
  read: ToolKind.READ,
  edit: ToolKind.EDIT,
  shell: ToolKind.SHELL,
  search: ToolKind.SEARCH,
  web: ToolKind.WEB,
  mcp: ToolKind.MCP,
  subagent: ToolKind.SUBAGENT,
  todo: ToolKind.TODO,
  other: ToolKind.OTHER,
};

const TEXT_FLUSH_MS = 50;

export class AgentCore {
  readonly epoch: bigint;
  private threads = new Map<string, Thread>();
  private listeners = new Set<(threadId: string, items: Item[]) => void>();
  private statusListeners = new Set<(summary: ThreadSummary) => void>();
  private infoListeners = new Set<(threadId: string) => void>();
  /** Plan usage and account of each AI account profile ("" for the default one), shared by its threads. */
  private accounts = new Map<string, AccountState>();
  /** The latest command list any session reported, for threads that have none yet. */
  private lastCommands: NonNullable<ProviderInfo["commands"]> = [];
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: CoreOptions) {
    this.maxSessions = opts.maxSessions ?? 3;
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    mkdirSync(join(opts.dataDir, "threads"), { recursive: true, mode: 0o700 });
    this.epoch = this.bumpEpoch();
    this.loadThreads();
  }

  // --- lifecycle -----------------------------------------------------------

  private get stateFile(): string {
    return join(this.opts.dataDir, "state.json");
  }

  /** Bumps the epoch and restores machine-wide statusline data. */
  private bumpEpoch(): bigint {
    let state: {
      epoch?: number;
      /** Before profiles: the one account of the machine. */
      rateLimits?: ProviderInfo["rateLimits"];
      account?: ProviderInfo["account"];
      accounts?: Record<string, AccountState>;
      commands?: ProviderInfo["commands"];
    } = {};
    try {
      state = JSON.parse(readFileSync(this.stateFile, "utf8")) as typeof state;
    } catch {
      // first start
    }
    const epoch = (state.epoch ?? 0) + 1;
    this.accounts = new Map(Object.entries(state.accounts ?? {}));
    if (!state.accounts && (state.rateLimits || state.account)) {
      this.accounts.set("", { ...(state.rateLimits ? { rateLimits: state.rateLimits } : {}), ...(state.account ? { account: state.account } : {}) });
    }
    this.lastCommands = state.commands ?? [];
    writeFileSync(this.stateFile, JSON.stringify({ epoch, accounts: Object.fromEntries(this.accounts), commands: this.lastCommands }), { mode: 0o600 });
    return BigInt(epoch);
  }

  private saveState(): void {
    const state = { epoch: Number(this.epoch), accounts: Object.fromEntries(this.accounts), commands: this.lastCommands };
    writeFileSync(this.stateFile, JSON.stringify(state), { mode: 0o600 });
  }

  /** Loads threads and repairs what a crash left: open prompts expire, open turns end. */
  private loadThreads(): void {
    const root = join(this.opts.dataDir, "threads");
    for (const id of readdirSync(root)) {
      const dir = join(root, id);
      try {
        const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as ThreadMeta;
        const journal = new Journal(join(dir, "journal.jsonl"));
        journal.load();
        const t = this.newThread(meta, journal);
        for (const item of journal.all()) {
          const b = item.body;
          if ((b.case === "approval" || b.case === "question") && b.value.state === PromptState.PENDING) {
            journal.update(item.id, (body) => {
              if (body.case === "approval" || body.case === "question") body.value.state = PromptState.EXPIRED;
            });
          } else if (b.case === "turn" && b.value.state === TurnState.RUNNING) {
            journal.update(item.id, (body) => {
              if (body.case === "turn") body.value.state = TurnState.INTERRUPTED;
            });
          } else if (b.case === "text" && b.value.partial) {
            journal.update(item.id, (body) => {
              if (body.case === "text") body.value.partial = false;
            });
          }
        }
        this.threads.set(id, t);
      } catch {
        // unreadable thread folder: skip it rather than fail the agent
      }
    }
  }

  start(): void {
    this.idleTimer = setInterval(() => void this.parkIdle(), Math.min(30_000, this.idleMs));
    this.idleTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    await Promise.all([...this.threads.values()].map((t) => this.park(t)));
  }

  onItems(fn: (threadId: string, items: Item[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called with a thread id whenever its ThreadInfo may have changed. */
  onInfo(fn: (threadId: string) => void): () => void {
    this.infoListeners.add(fn);
    return () => this.infoListeners.delete(fn);
  }

  /** The statusline data of a thread, for devices. */
  info(threadId: string): ThreadInfo {
    const t = this.thread(threadId);
    const profileId = t.meta.profileId ?? "";
    const { rateLimits: r, account } = this.accounts.get(profileId) ?? {};
    const win = (w?: { utilization: number; resetsAt: number }) => (w ? { utilization: w.utilization, resetsAt: BigInt(w.resetsAt) } : undefined);
    const fiveHour = win(r?.fiveHour);
    const sevenDay = win(r?.sevenDay);
    return create(ThreadInfoSchema, {
      threadId,
      permissionMode: t.info.permissionMode ?? "",
      gitBranch: gitBranch(t.meta.dir).branch,
      linesAdded: t.info.linesAdded ?? 0,
      linesRemoved: t.info.linesRemoved ?? 0,
      commands: t.info.commands?.length ? t.info.commands : this.lastCommands,
      effort: t.info.effort ?? "",
      permissionModes: this.permissionModes(t),
      profileId,
      ...(account ? { account } : {}),
      ...(r ? { rateLimits: { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } } : {}),
    });
  }

  onStatus(fn: (summary: ThreadSummary) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  // --- queries -------------------------------------------------------------

  list(): ThreadSummary[] {
    return [...this.threads.values()].map((t) => this.summary(t)).sort((a, b) => Number(b.updatedAt - a.updatedAt));
  }

  /** True when an open session runs with this AI account profile. */
  profileInUse(profileId: string): boolean {
    return [...this.threads.values()].some((t) => (t.session || t.starting) && (t.meta.profileId ?? "") === profileId);
  }

  /** Usage read outside a session (a refresh): shown on the profile's threads. */
  setProfileUsage(profileId: string, rateLimits: NonNullable<ProviderInfo["rateLimits"]>): void {
    this.accounts.set(profileId, { ...this.accounts.get(profileId), rateLimits });
    this.saveState();
    this.notifyProfile(profileId);
  }

  private notifyProfile(profileId: string): void {
    for (const t of this.threads.values()) {
      if ((t.meta.profileId ?? "") !== profileId) continue;
      for (const fn of this.infoListeners) fn(t.meta.id);
    }
  }

  openSessions(): number {
    return [...this.threads.values()].filter((t) => t.session || t.starting).length;
  }

  get limit(): number {
    return this.maxSessions;
  }

  subscribe(threadId: string, cursor: Cursor | undefined): { resume: Resume; items: Item[] } {
    const t = this.thread(threadId);
    const resume = resumeFrom(t.journal.bounds(this.epoch), cursor ? { epoch: cursor.epoch, seq: cursor.seq } : undefined);
    if (resume.kind === "reset") return { resume, items: [] };
    return { resume, items: t.journal.since(resume.fromSeq - 1n) };
  }

  /** Every item of the thread, for a device that was told to reset. */
  snapshot(threadId: string): Item[] {
    return this.thread(threadId).journal.all();
  }

  lastSeq(threadId: string): bigint {
    return this.thread(threadId).journal.bounds(this.epoch).lastSeq;
  }

  fullItem(threadId: string, itemId: string): Item {
    const item = this.thread(threadId).journal.get(itemId);
    if (!item) throw new AgentError(ErrorCode.NOT_FOUND, "no such item");
    return item;
  }

  recentDirs(limit = 10): string[] {
    const seen: string[] = [];
    for (const s of this.list()) if (!seen.includes(s.dir)) seen.push(s.dir);
    return seen.slice(0, limit);
  }

  // --- commands ------------------------------------------------------------

  async create(req: {
    provider: string;
    model: string;
    dir: string;
    text: string;
    consent: { sensitive: boolean; projectSettings: boolean };
    device: string;
  }): Promise<ThreadSummary> {
    const provider = this.provider(req.provider || "claude");
    const dir = resolve(req.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AgentError(ErrorCode.INVALID, "folder not found");
    if (!req.text.trim()) throw new AgentError(ErrorCode.INVALID, "empty message");
    const sensitive = this.opts.isSensitive(dir);
    if (sensitive && !req.consent.sensitive) throw new AgentError(ErrorCode.NEEDS_CONSENT, "sensitive folder");
    const detected = await provider.detect(this.detectOptions());
    if (!detected.installed) throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `${provider.name} is not installed`);
    if (detected.loginState === "needs-login") throw new AgentError(ErrorCode.NEEDS_LOGIN, `${provider.name} needs sign-in`);

    if (req.consent.projectSettings && !(this.opts.isTrusted?.(dir) ?? false)) {
      throw new AgentError(ErrorCode.INVALID, `this folder's .claude settings are not trusted on the machine; run there: tunelo trust "${dir}"`);
    }
    if (sensitive) this.opts.audit.write({ device: req.device, action: "open_sensitive", path: dir, detail: "" });
    if (req.consent.projectSettings) {
      this.opts.audit.write({ device: req.device, action: "project_settings", path: dir, detail: provider.id });
    }
    const id = randomUUID();
    const folder = join(this.opts.dataDir, "threads", id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const meta: ThreadMeta = {
      id,
      title: req.text.trim().split("\n")[0]?.slice(0, 80) ?? "",
      dir,
      provider: provider.id,
      model: req.model,
      projectSettings: req.consent.projectSettings,
      createdAt: this.now(),
      updatedAt: this.now(),
      segments: [{ provider: provider.id, model: req.model, startedSeq: "1" }],
    };
    const t = this.newThread(meta, new Journal(join(folder, "journal.jsonl")));
    this.threads.set(id, t);
    this.saveMeta(t);
    await this.send(id, req.text, "");
    return this.summary(t);
  }

  async send(threadId: string, text: string, clientMsgId: string): Promise<void> {
    const t = this.thread(threadId);
    if (!text.trim()) throw new AgentError(ErrorCode.INVALID, "empty message");
    if (clientMsgId) {
      if (t.clientMsgIds.has(clientMsgId)) return;
      t.clientMsgIds.add(clientMsgId);
    }
    this.put(t, `user:${randomUUID()}`, { case: "text", value: { role: Role.USER, text, clientMsgId } });
    t.turnCount += 1;
    t.turnItem = `turn:${t.turnCount}:${randomUUID().slice(0, 8)}`;
    this.put(t, t.turnItem, { case: "turn", value: { state: TurnState.RUNNING } });
    t.running = true;
    t.lastActive = this.now();
    t.outbox.push(text);
    this.touch(t);
    await this.ensureSession(t);
  }

  respond(threadId: string, itemId: string, expectedRevision: number, answer: { decision?: Decision; answers?: Answers }, device: string): void {
    const t = this.thread(threadId);
    const p = t.pending.get(itemId);
    const item = t.journal.get(itemId);
    if (!p || !item || item.revision !== expectedRevision) throw new AgentError(ErrorCode.STALE, "this prompt changed or was answered");
    t.pending.delete(itemId);
    if (p.kind === "approval") {
      let decision = answer.decision ?? Decision.DENY;
      if (decision === Decision.ALLOW_SESSION && p.sensitive) decision = Decision.ALLOW;
      this.update(t, itemId, (b) => {
        if (b.case === "approval") {
          b.value.state = PromptState.ANSWERED;
          b.value.decision = decision;
        }
      });
      if (p.sensitive && decision !== Decision.DENY && item.body.case === "approval") {
        this.opts.audit.write({ device, action: "approve_sensitive", path: t.meta.dir, detail: `${item.body.value.name} ${item.body.value.summary}` });
      }
      p.resolve({ decision: decision === Decision.ALLOW ? "allow" : decision === Decision.ALLOW_SESSION ? "allow-session" : "deny" });
    } else {
      const values = (answer.answers?.answers ?? []).map((a) => a.values);
      this.update(t, itemId, (b) => {
        if (b.case === "question") {
          b.value.state = PromptState.ANSWERED;
          if (answer.answers) b.value.answers = answer.answers;
        }
      });
      p.resolve({ answers: values });
    }
    this.touch(t);
  }

  async interrupt(threadId: string): Promise<void> {
    const t = this.thread(threadId);
    this.cancelPending(t);
    t.outbox = [];
    if (t.session) await t.session.interrupt();
    else if (t.running) this.endTurn(t, TurnState.INTERRUPTED, 0);
  }

  async close(threadId: string): Promise<void> {
    const t = this.thread(threadId);
    await this.park(t);
    this.touch(t);
  }

  async setModel(threadId: string, model: string): Promise<void> {
    const t = this.thread(threadId);
    const from = t.meta.model;
    if (from === model) return;
    if (t.session?.setModel) await t.session.setModel(model);
    t.meta.model = model;
    const seg = t.meta.segments.at(-1);
    if (seg) seg.model = model;
    this.saveMeta(t);
    this.put(t, `model:${randomUUID()}`, { case: "modelChange", value: { from: from || "default", to: model } });
    this.touch(t);
  }

  /** Effort for the rest of the session; "" goes back to the AI's default. */
  async setEffort(threadId: string, effort: string): Promise<void> {
    const t = this.thread(threadId);
    if (effort !== "" && !this.provider(t.meta.provider).capabilities.effortLevels.includes(effort)) {
      throw new AgentError(ErrorCode.INVALID, `unknown effort "${effort}"`);
    }
    if (t.session?.setEffort) await t.session.setEffort(effort);
    if (effort === "") delete t.meta.effort;
    else t.meta.effort = effort;
    t.info.effort = effort;
    this.saveMeta(t);
    for (const fn of this.infoListeners) fn(t.meta.id);
  }

  /** Modes a device may pick: the AI's safe ones, plus bypass only when the machine itself starts there. */
  /** The permission mode the thread's session reported last; undefined for an unknown thread. */
  permissionMode(threadId: string): string | undefined {
    return this.threads.get(threadId)?.info.permissionMode;
  }

  private permissionModes(t: Thread): string[] {
    const modes = [...this.provider(t.meta.provider).capabilities.permissionModes];
    if (t.meta.machineMode === "bypassPermissions") modes.push("bypassPermissions");
    return modes;
  }

  async setPermissionMode(threadId: string, mode: string, device: string): Promise<void> {
    const t = this.thread(threadId);
    if (!this.permissionModes(t).includes(mode)) throw new AgentError(ErrorCode.INVALID, `permission mode "${mode}" is not allowed from a device`);
    if (t.session?.setPermissionMode) await t.session.setPermissionMode(mode);
    t.meta.permissionMode = mode;
    t.info.permissionMode = mode;
    this.saveMeta(t);
    this.opts.audit.write({ device, action: "permission_mode", path: t.meta.dir, detail: mode });
    for (const fn of this.infoListeners) fn(t.meta.id);
  }

  /** Hands the thread to another AI: summary + changed files as its first message. */
  async switchProvider(threadId: string, providerId: string, model: string): Promise<void> {
    const t = this.thread(threadId);
    const target = this.provider(providerId);
    if (target.id === t.meta.provider) throw new AgentError(ErrorCode.INVALID, "already on this AI");
    const detected = await target.detect(this.detectOptions());
    if (!detected.installed) throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `${target.name} is not installed`);
    if (detected.loginState === "needs-login") throw new AgentError(ErrorCode.NEEDS_LOGIN, `${target.name} needs sign-in`);
    if (t.running) await this.interrupt(threadId);
    this.cancelPending(t);
    await this.park(t);
    const from = this.provider(t.meta.provider).name;
    const git = await gitChanges(t.meta.dir);
    const summary = buildHandoff({ from, to: target.name, dir: t.meta.dir, items: t.journal.all(), gitStat: git.stat });
    t.meta.provider = target.id;
    t.meta.model = model;
    t.meta.segments.push({ provider: target.id, model, startedSeq: String(this.lastSeq(threadId) + 1n) });
    this.saveMeta(t);
    this.put(t, `handoff:${randomUUID()}`, {
      case: "agentHandoff",
      value: { from: from, to: target.name, summary, filesChanged: git.files },
    });
    t.turnCount += 1;
    t.turnItem = `turn:${t.turnCount}:${randomUUID().slice(0, 8)}`;
    this.put(t, t.turnItem, { case: "turn", value: { state: TurnState.RUNNING } });
    t.running = true;
    t.outbox.push(summary);
    this.touch(t);
    await this.ensureSession(t);
  }

  // --- sessions ------------------------------------------------------------

  /** The sign-in to check before a new session: that of the selected profile. */
  private detectOptions(): { accountDir?: string } {
    let dir: string | undefined;
    try {
      dir = this.opts.selectedAccountDir?.();
    } catch (err) {
      throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, (err as Error).message);
    }
    return dir ? { accountDir: dir } : {};
  }

  private async ensureSession(t: Thread): Promise<void> {
    if (t.session) return this.flushOutbox(t);
    if (t.starting) return;
    if (this.openSessions() >= this.maxSessions) {
      const victim = this.idleVictim(t);
      if (!victim) {
        // Starts when a session frees up; the device sees the QUEUED state.
        t.queued = true;
        this.touch(t);
        return;
      }
      await this.park(victim);
      this.touch(victim);
    }
    t.queued = false;
    const provider = this.provider(t.meta.provider);
    const seg = t.meta.segments.at(-1);
    const askUser = ((req: ApprovalRequest | QuestionRequest, signal: AbortSignal) => this.ask(t, req, signal)) as AskUser;
    // A new session takes the profile selected now; an open one keeps its own.
    // When the selection cannot be read, the turn fails: never another account quietly.
    let profile: { id: string; accountDir?: string };
    try {
      profile = this.opts.profile?.() ?? { id: "" };
    } catch (err) {
      const message = `the Claude account picked on this machine cannot be used: ${(err as Error).message}`.slice(0, 500);
      this.put(t, `error:${randomUUID()}`, { case: "error", value: { message } });
      this.endTurn(t, TurnState.FAILED, 0);
      throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, message);
    }
    if (profile.id) t.meta.profileId = profile.id;
    else delete t.meta.profileId;
    const policy = {
      dir: t.meta.dir,
      mcpServers: this.opts.mcpServers ?? {},
      projectSettings: t.meta.projectSettings,
      isSensitive: this.opts.isSensitive,
      ...(t.meta.model ? { model: t.meta.model } : {}),
      ...(t.meta.effort ? { effort: t.meta.effort } : {}),
      ...(t.meta.permissionMode ? { permissionMode: t.meta.permissionMode } : {}),
      ...(t.meta.machineMode === "bypassPermissions" ? { allowBypass: true } : {}),
      ...(profile.accountDir ? { accountDir: profile.accountDir } : {}),
    };
    // Its ticket lives as long as this session.
    const lease = provider.capabilities.sessionMcp ? this.opts.sessionMcp?.(t.meta.id) : undefined;
    const withMcp = lease ? { ...policy, sessionMcp: { ticket: lease.ticket, configDir: lease.configDir, approveWrite: lease.approveWrite, describeWrite: lease.describeWrite } } : policy;
    t.modeUnseen = true;
    t.starting = provider.start({ policy: withMcp, askUser, ...(seg?.sessionId ? { resumeId: seg.sessionId } : {}) });
    try {
      t.session = await t.starting;
    } catch (err) {
      lease?.release();
      this.put(t, `error:${randomUUID()}`, { case: "error", value: { message: (err as Error).message.slice(0, 500) } });
      this.endTurn(t, TurnState.FAILED, 0);
      throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, (err as Error).message);
    } finally {
      delete t.starting;
    }
    void this.consume(t, t.session).finally(() => lease?.release());
    await this.flushOutbox(t);
  }

  private async flushOutbox(t: Thread): Promise<void> {
    const s = t.session;
    if (!s) return;
    while (t.outbox.length) {
      const text = t.outbox.shift();
      if (text !== undefined) await s.send(text);
    }
  }

  /** The open, idle session used longest ago, to make room. */
  private idleVictim(except: Thread): Thread | undefined {
    return [...this.threads.values()]
      .filter((x) => x !== except && x.session && !x.running && x.pending.size === 0)
      .sort((a, b) => a.lastActive - b.lastActive)[0];
  }

  private async park(t: Thread): Promise<void> {
    const s = t.session;
    if (!s) return;
    delete t.session;
    this.cancelPending(t);
    await s.close();
    void this.dequeue();
  }

  private async parkIdle(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    for (const t of this.threads.values()) {
      if (t.session && !t.running && t.pending.size === 0 && t.lastActive < cutoff) {
        await this.park(t);
        this.touch(t);
      }
    }
  }

  private async dequeue(): Promise<void> {
    const next = [...this.threads.values()].filter((t) => t.queued).sort((a, b) => a.lastActive - b.lastActive)[0];
    if (!next) return;
    try {
      await this.ensureSession(next);
    } catch {
      // still no room
    }
  }

  private async consume(t: Thread, session: ProviderSession): Promise<void> {
    for await (const e of session.events) this.handle(t, e);
    if (t.session === session) {
      delete t.session;
      if (t.running) this.endTurn(t, TurnState.FAILED, 0);
      this.cancelPending(t);
      this.touch(t);
    }
  }

  private handle(t: Thread, e: ProviderEvent): void {
    t.lastActive = this.now();
    switch (e.type) {
      case "session": {
        const seg = t.meta.segments.at(-1);
        if (seg && seg.sessionId !== e.sessionId) {
          seg.sessionId = e.sessionId;
          this.saveMeta(t);
        }
        return;
      }
      case "text-delta": {
        const id = this.textItem(t, e.blockId, e.role);
        const item = t.journal.get(id);
        if (item?.body.case === "text") item.body.value.text += e.text;
        t.dirtyText.add(id);
        t.flushTimer ??= setTimeout(() => this.flushText(t), TEXT_FLUSH_MS);
        return;
      }
      case "text": {
        const id = this.textItem(t, e.blockId, e.role);
        t.dirtyText.delete(id);
        this.update(t, id, (b) => {
          if (b.case === "text") {
            b.value.text = e.text;
            b.value.partial = false;
          }
        });
        return;
      }
      case "tool-start":
        this.put(t, `tool:${e.toolId}`, {
          case: "toolCall",
          value: { toolId: e.toolId, kind: KIND[e.kind], name: e.name, summary: e.summary, input: e.input, sensitive: mentionsSensitive(`${e.summary} ${e.input}`, this.opts.isSensitive, { cwd: t.meta.dir }) },
        });
        return;
      case "tool-end":
        this.put(t, `result:${e.toolId}`, { case: "toolResult", value: { toolId: e.toolId, ok: e.ok, output: e.output } });
        return;
      case "diff":
        this.put(t, `diff:${e.toolId}`, {
          case: "diff",
          value: { toolId: e.toolId, path: e.path, unified: e.unified, added: e.added, removed: e.removed },
        });
        return;
      case "todo":
        this.put(t, "todo", {
          case: "todo",
          value: {
            entries: e.entries.map((x) => ({
              text: x.text,
              state: x.state === "done" ? TodoState.DONE : x.state === "in-progress" ? TodoState.IN_PROGRESS : TodoState.PENDING,
            })),
          },
        });
        return;
      case "subagent": {
        const id = `sub:${e.toolId}`;
        const prev = t.journal.get(id);
        const description = e.description || (prev?.body.case === "subagent" ? prev.body.value.description : "");
        this.put(t, id, { case: "subagent", value: { toolId: e.toolId, description, done: e.done } });
        return;
      }
      case "status":
        this.put(t, `status:${randomUUID()}`, { case: "status", value: { text: e.text } });
        return;
      case "info": {
        const { type: _type, rateLimits, account, ...rest } = e;
        // The first mode a session reports, with no device pick, is the machine's own.
        if (rest.permissionMode && t.modeUnseen) {
          t.modeUnseen = false;
          if (!t.meta.permissionMode) t.meta.machineMode = rest.permissionMode;
        }
        Object.assign(t.info, rest);
        this.saveMeta(t);
        if (rest.commands?.length) this.lastCommands = rest.commands;
        if (rateLimits || rest.commands?.length) this.saveState();
        if (rateLimits || account) {
          const profileId = t.meta.profileId ?? "";
          const prev = this.accounts.get(profileId);
          this.accounts.set(profileId, { ...prev, ...(rateLimits ? { rateLimits } : {}), ...(account ? { account } : {}) });
          this.saveState();
          if (rateLimits) this.opts.onProfileUsage?.(profileId, rateLimits);
          this.notifyProfile(profileId);
        } else {
          for (const fn of this.infoListeners) fn(t.meta.id);
        }
        return;
      }
      case "usage":
        t.usage = { tokens: e.contextTokens, window: e.contextWindow };
        return;
      case "compaction":
        this.put(t, `compact:${randomUUID()}`, { case: "compaction", value: { tokensBefore: BigInt(e.tokensBefore) } });
        return;
      case "turn-end":
        this.flushText(t);
        this.endTurn(
          t,
          e.state === "completed" ? TurnState.COMPLETED : e.state === "interrupted" ? TurnState.INTERRUPTED : TurnState.FAILED,
          e.durationMs,
        );
        return;
      case "error":
        this.put(t, `error:${randomUUID()}`, { case: "error", value: { message: e.message } });
        return;
    }
  }

  private textItem(t: Thread, blockId: string, role: "assistant" | "thinking"): string {
    let id = t.textItems.get(blockId);
    if (!id) {
      id = `text:${blockId}`;
      t.textItems.set(blockId, id);
      this.put(t, id, { case: "text", value: { role: role === "assistant" ? Role.ASSISTANT : Role.THINKING, text: "", partial: true } });
    }
    return id;
  }

  private flushText(t: Thread): void {
    if (t.flushTimer) clearTimeout(t.flushTimer);
    delete t.flushTimer;
    for (const id of t.dirtyText) this.update(t, id, () => undefined);
    t.dirtyText.clear();
  }

  private endTurn(t: Thread, state: TurnState, durationMs: number): void {
    if (t.turnItem) {
      const usage = t.usage;
      this.update(t, t.turnItem, (b) => {
        if (b.case === "turn") {
          b.value.state = state;
          b.value.durationMs = BigInt(Math.max(0, durationMs));
          if (usage) {
            b.value.contextTokens = BigInt(usage.tokens);
            b.value.contextWindow = BigInt(usage.window);
          }
        }
      });
    }
    t.running = false;
    delete t.turnItem;
    this.touch(t);
    void this.dequeue();
  }

  // --- prompts -------------------------------------------------------------

  private ask(t: Thread, req: ApprovalRequest | QuestionRequest, signal: AbortSignal): Promise<ApprovalAnswer | QuestionAnswer> {
    const itemId = `ask:${req.toolId || randomUUID()}`;
    if (req.kind === "approval") {
      // The core checks too, so an adapter that misses a path cannot unlock "allow for the session".
      req = { ...req, sensitive: req.sensitive || mentionsSensitive(`${req.summary} ${req.input}`, this.opts.isSensitive, { cwd: t.meta.dir }) };
      this.put(t, itemId, {
        case: "approval",
        value: {
          toolId: req.toolId,
          kind: KIND[req.toolKind],
          name: req.name,
          summary: req.summary,
          input: req.input,
          sensitive: req.sensitive,
          reason: req.reason ?? "",
          state: PromptState.PENDING,
        },
      });
    } else {
      this.put(t, itemId, {
        case: "question",
        value: {
          questions: req.questions.map((q) => ({ question: q.question, header: q.header, options: q.options, multiSelect: q.multiSelect })),
          state: PromptState.PENDING,
        },
      });
    }
    return new Promise((resolveAnswer) => {
      const deny = req.kind === "approval" ? ({ decision: "deny" } as const) : ({ cancelled: true } as const);
      t.pending.set(itemId, { itemId, kind: req.kind, sensitive: req.kind === "approval" && req.sensitive, resolve: resolveAnswer });
      signal.addEventListener("abort", () => {
        if (!t.pending.has(itemId)) return;
        t.pending.delete(itemId);
        this.update(t, itemId, (b) => {
          if (b.case === "approval" || b.case === "question") b.value.state = PromptState.CANCELLED;
        });
        resolveAnswer(deny);
        this.touch(t);
      });
      const summary = this.touch(t);
      this.opts.onNeedsInput?.(summary);
    });
  }

  private cancelPending(t: Thread): void {
    for (const p of t.pending.values()) {
      this.update(t, p.itemId, (b) => {
        if (b.case === "approval" || b.case === "question") b.value.state = PromptState.CANCELLED;
      });
      p.resolve(p.kind === "approval" ? { decision: "deny" } : { cancelled: true });
    }
    t.pending.clear();
  }

  // --- helpers -------------------------------------------------------------

  private newThread(meta: ThreadMeta, journal: Journal): Thread {
    return {
      meta,
      journal,
      queued: false,
      outbox: [],
      running: false,
      turnCount: 0,
      lastActive: meta.updatedAt,
      pending: new Map(),
      textItems: new Map(),
      dirtyText: new Set(),
      clientMsgIds: new Set(),
      modeUnseen: false,
      info: (meta.info ??= {}),
    };
  }

  private thread(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw new AgentError(ErrorCode.NOT_FOUND, "no such thread");
    return t;
  }

  private provider(id: string): AgentProvider {
    const p = this.opts.providers.find((x) => x.id === id);
    if (!p) throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `unknown AI "${id}"`);
    return p;
  }

  private put(t: Thread, id: string, body: ItemBody): Item {
    const item = t.journal.put(id, body, { provider: t.meta.provider, model: t.meta.model, now: this.now() });
    for (const fn of this.listeners) fn(t.meta.id, [item]);
    return item;
  }

  private update(t: Thread, id: string, change: (b: Item["body"]) => void): void {
    const item = t.journal.update(id, change);
    if (item) for (const fn of this.listeners) fn(t.meta.id, [item]);
  }

  private saveMeta(t: Thread): void {
    writeFileSync(join(this.opts.dataDir, "threads", t.meta.id, "meta.json"), JSON.stringify(t.meta), { mode: 0o600 });
  }

  private touch(t: Thread): ThreadSummary {
    t.meta.updatedAt = this.now();
    this.saveMeta(t);
    const s = this.summary(t);
    for (const fn of this.statusListeners) fn(s);
    return s;
  }

  private summary(t: Thread): ThreadSummary {
    const state = t.queued
      ? ThreadState.QUEUED
      : t.pending.size
        ? ThreadState.WAITING
        : t.running
          ? ThreadState.RUNNING
          : ThreadState.IDLE;
    return create(ThreadSummarySchema, {
      id: t.meta.id,
      title: t.meta.title,
      dir: t.meta.dir,
      provider: t.meta.provider,
      model: t.meta.model,
      state,
      pending: t.pending.size,
      updatedAt: BigInt(t.meta.updatedAt),
      open: Boolean(t.session || t.starting),
    });
  }
}

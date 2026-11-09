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
  ErrorReason,
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
  HistoryEntry,
  LocalSession,
  ProviderEvent,
  ProviderInfo,
  ProviderSession,
  QuestionAnswer,
  QuestionRequest,
  SessionPage,
  SessionQuery,
  ToolKind as Kind,
} from "../providers/types.ts";
import { buildHandoff, gitChanges } from "../threads/handoff.ts";
import { gitBranch } from "../safety/dirs.ts";
import { previewLine } from "./preview.ts";
import { type ItemBody, Journal } from "../threads/journal.ts";
import type { SessionMcpLease } from "../mcp/session-tickets.ts";

/** A refusal devices can say in the user's language: `reason` (+ `subject`) is stable, `message` is English. */
export class AgentError extends Error {
  readonly reason: ErrorReason;
  readonly subject: string;

  constructor(
    readonly code: ErrorCode,
    message: string,
    detail: { reason?: ErrorReason; subject?: string } = {},
  ) {
    super(message);
    this.reason = detail.reason ?? ErrorReason.UNSPECIFIED;
    this.subject = detail.subject ?? "";
  }
}

/** Longest ThreadRespond.deny_message accepted. */
export const DENY_MESSAGE_MAX = 4000;

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
  /**
   * Allow rules the user gave "for the session" on this thread (the AI's own
   * rule syntax), handed back whenever its session opens again: after a
   * profile switch, parking or a restart of the service. Cleared when the
   * thread moves to another AI.
   */
  sessionRules?: string[];
  /**
   * How far the AI's own transcript of the session (`sessionId`) is in the
   * journal: what was appended after `end` came from elsewhere (a terminal,
   * an IDE) and is read in before the thread goes on.
   */
  history?: { sessionId: string; end: number };
};

/** A session kept on the machine, as devices see it (LocalSession in the protocol). */
export type LocalSessionView = LocalSession & { threadId: string; busyElsewhere: boolean; sensitive: boolean };

/** What the user agreed to on the device before a session opens (Consent in the protocol). */
export type ConsentGiven = { sensitive: boolean; projectSettings: boolean; trustProject?: boolean };

/** Longest tool output kept from a transcript read back (live output is kept whole). */
const HISTORY_OUTPUT_MAX = 64 * 1024;

/** At most this many session allow rules per thread; the oldest go first. */
const SESSION_RULES_MAX = 200;

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
  /** The idle session is closing to open again on the machine's profile. */
  switching?: Promise<void>;
  /** This turn already reported running out of usage. */
  limitSeen: boolean;
  /** Another profile with room, offered after this session's profile ran out. */
  suggestion?: ProfileSuggestion;
  /** One line of the last user or AI text (ThreadSummary.preview). */
  preview: string;
  /** The tool call running now, for "Running: <tool>". */
  runningTool?: { toolId: string; name: string };
};

/** Another AI account profile with usage left (see ThreadInfo.profile_suggestion). */
export type ProfileSuggestion = { id: string; email: string; remaining: number };

/** Where one thread stands against the machine's profile (see MachineProfile.sessions). */
export type SessionProfileState = { threadId: string; profileId: string; switchPending: boolean };

export type CoreOptions = {
  dataDir: string;
  providers: AgentProvider[];
  audit: AuditLog;
  isSensitive: (path: string) => boolean;
  /** Project settings load only in folders the owner trusted (on the machine, or from a device with consent). */
  isTrusted?: (dir: string) => boolean;
  /** Trusts a folder for a device that asked with consent; writes the consent log. */
  trust?: (dir: string, device: string) => void;
  mcpServers?: Record<string, unknown>;
  maxSessions?: number;
  idleMs?: number;
  /** Called when a thread starts waiting for the user. */
  onNeedsInput?: (thread: ThreadSummary) => void;
  /** The AI account profile a new session opens with; the default one when unset. Throws when it cannot tell. */
  profile?: () => { id: string; accountDir?: string };
  /** The account folder of the selected profile, only looked up (for checking its sign-in). */
  selectedAccountDir?: () => string | undefined;
  /**
   * The machine's profile ("" for the default one), only looked up; undefined
   * when it cannot be told. Every session follows it: unset, sessions keep
   * the profile they opened with.
   */
  selectedProfileId?: () => string | undefined;
  /** Who a profile is signed in as, from what the machine keeps. */
  profileAccount?: (profileId: string) => ProviderInfo["account"] | undefined;
  /** Another profile with room, for a session whose profile ran out of usage. */
  suggestProfile?: (exhaustedId: string) => Promise<ProfileSuggestion | undefined>;
  /** A session finished moving to the machine's profile. */
  onSessionProfile?: (threadId: string) => void;
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
        t.preview = lastPreview(journal.all());
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
    // A session moving to another profile opens first, then closes with the rest.
    await Promise.all([...this.threads.values()].map((t) => t.switching));
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
    const machineProfileId = this.machineProfile();
    const profileId = this.profileOf(t, machineProfileId);
    const switchPending = this.switchPending(t, machineProfileId);
    const nextAccount = switchPending && machineProfileId !== undefined ? this.accountOf(machineProfileId) : undefined;
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
      machineProfileId: machineProfileId ?? "",
      profileSwitchPending: switchPending,
      ...(nextAccount ? { nextAccount } : {}),
      ...(t.suggestion ? { profileSuggestion: { profileId: t.suggestion.id, email: t.suggestion.email, remaining: t.suggestion.remaining } } : {}),
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
    return [...this.threads.values()].some((t) => (t.session || t.starting || t.switching) && (t.meta.profileId ?? "") === profileId);
  }

  // --- the machine's profile -----------------------------------------------

  /** The machine's profile; undefined when unknown (or sessions do not follow one). */
  private machineProfile(): string | undefined {
    try {
      return this.opts.selectedProfileId?.();
    } catch {
      return undefined;
    }
  }

  private isOpen(t: Thread): boolean {
    return Boolean(t.session || t.starting || t.switching);
  }

  /** The profile a thread runs with; a parked one opens with the machine's next. */
  private profileOf(t: Thread, machineProfileId = this.machineProfile()): string {
    if (!this.isOpen(t) && machineProfileId !== undefined) return machineProfileId;
    return t.meta.profileId ?? "";
  }

  /** An open session on another profile than the machine's: it moves when it can. */
  private switchPending(t: Thread, machineProfileId = this.machineProfile()): boolean {
    return machineProfileId !== undefined && this.isOpen(t) && (t.meta.profileId ?? "") !== machineProfileId;
  }

  private accountOf(profileId: string): ProviderInfo["account"] | undefined {
    return this.accounts.get(profileId)?.account ?? this.opts.profileAccount?.(profileId);
  }

  /** Every thread and the profile it runs with, for devices. */
  profileStates(): SessionProfileState[] {
    const machineProfileId = this.machineProfile();
    return [...this.threads.values()].map((t) => ({
      threadId: t.meta.id,
      profileId: this.profileOf(t, machineProfileId),
      switchPending: this.switchPending(t, machineProfileId),
    }));
  }

  /**
   * The machine's profile changed: idle sessions restart on it now (resumed,
   * same conversation), busy ones when their turn ends, parked ones open with
   * it. Devices hear about every thread.
   */
  followMachineProfile(): void {
    const machineProfileId = this.machineProfile();
    for (const t of this.threads.values()) {
      if (t.suggestion && t.suggestion.id === machineProfileId) delete t.suggestion;
      void this.follow(t);
      for (const fn of this.infoListeners) fn(t.meta.id);
    }
  }

  /**
   * Moves an open, idle session to the machine's profile: closes it and opens
   * it again resumed (same session id, model, effort, permission mode, folder;
   * a new MCP ticket). Without room or a session id to resume it stays
   * parked and opens on the machine's profile next time. Never touches a
   * session in the middle of a turn or waiting for an answer.
   */
  private async follow(t: Thread): Promise<void> {
    const target = this.machineProfile();
    const s = t.session;
    if (target === undefined || !s || t.switching || t.starting || t.running || t.pending.size > 0) return;
    if ((t.meta.profileId ?? "") === target) return;
    t.switching = (async () => {
      delete t.session;
      await s.close();
      const seg = t.meta.segments.at(-1);
      if (!seg?.sessionId || this.openSessions() >= this.maxSessions) return;
      try {
        await this.openSession(t);
      } catch {
        // the thread shows the error; it opens again with the next message
      }
    })();
    try {
      await t.switching;
    } finally {
      delete t.switching;
    }
    delete t.suggestion;
    this.touch(t);
    for (const fn of this.infoListeners) fn(t.meta.id);
    this.opts.onSessionProfile?.(t.meta.id);
    if (!t.session) void this.dequeue();
    // The machine may have switched again meanwhile.
    void this.follow(t);
  }

  /** Usage read outside a session (a refresh): shown on the profile's threads. */
  setProfileUsage(profileId: string, rateLimits: NonNullable<ProviderInfo["rateLimits"]>): void {
    this.accounts.set(profileId, { ...this.accounts.get(profileId), rateLimits });
    this.saveState();
    this.notifyProfile(profileId);
  }

  private notifyProfile(profileId: string): void {
    const machineProfileId = this.machineProfile();
    for (const t of this.threads.values()) {
      if (this.profileOf(t, machineProfileId) !== profileId) continue;
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
    // Turns added elsewhere (a terminal, an IDE) show with the rest; an open
    // session opens again so the AI reads them too.
    if (this.syncHistory(t) > 0 && t.session) void this.park(t).then(() => this.touch(t));
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

  /** The thread's working directory. */
  threadDir(threadId: string): string {
    return this.thread(threadId).meta.dir;
  }

  fullItem(threadId: string, itemId: string): Item {
    const item = this.thread(threadId).journal.get(itemId);
    if (!item) throw new AgentError(ErrorCode.NOT_FOUND, "no such item", { reason: ErrorReason.ITEM_NOT_FOUND });
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
    consent: ConsentGiven;
    device: string;
  }): Promise<ThreadSummary> {
    const provider = this.provider(req.provider || "claude");
    const dir = resolve(req.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AgentError(ErrorCode.INVALID, "folder not found", { reason: ErrorReason.FOLDER_NOT_FOUND, subject: dir });
    if (!req.text.trim()) throw new AgentError(ErrorCode.INVALID, "empty message", { reason: ErrorReason.EMPTY_MESSAGE });
    await this.admit(provider, dir, req.consent, req.device);
    const t = this.addThread({
      title: req.text.trim().split("\n")[0]?.slice(0, 80) ?? "",
      dir,
      provider: provider.id,
      model: req.model,
      projectSettings: req.consent.projectSettings,
    });
    await this.send(t.meta.id, req.text, "");
    return this.summary(t);
  }

  /**
   * The checks every session opening in `dir` goes through, in this order:
   * the sensitive folder's consent, the AI installed and signed in, then the
   * project settings' trust (trusted now when the device asked to). Logs
   * what was agreed to.
   */
  private async admit(provider: AgentProvider, dir: string, consent: ConsentGiven, device: string): Promise<void> {
    const sensitive = this.opts.isSensitive(dir);
    if (sensitive && !consent.sensitive) throw new AgentError(ErrorCode.NEEDS_CONSENT, "sensitive folder", { reason: ErrorReason.SENSITIVE_FOLDER, subject: dir });
    const detected = await provider.detect(this.detectOptions());
    this.assertReady(provider, detected);

    const trustNow = consent.projectSettings && !(this.opts.isTrusted?.(dir) ?? false);
    if (trustNow) {
      // Trusting a sensitive folder (home, a disk root) from a device would trust everything under it.
      if (sensitive || !this.opts.trust) {
        throw new AgentError(ErrorCode.INVALID, `this folder's .claude settings are trusted on the machine only; run there: tunelo trust "${dir}"`, {
          reason: ErrorReason.TRUST_ON_MACHINE,
          subject: dir,
        });
      }
      if (!consent.trustProject) {
        throw new AgentError(ErrorCode.INVALID, `this folder's .claude settings are not trusted on the machine; run there: tunelo trust "${dir}"`, {
          reason: ErrorReason.PROJECT_SETTINGS_UNTRUSTED,
          subject: dir,
        });
      }
      this.opts.trust(dir, device);
    }
    if (sensitive) this.opts.audit.write({ device, action: "open_sensitive", path: dir, detail: "" });
    if (consent.projectSettings) {
      this.opts.audit.write({ device, action: "project_settings", path: dir, detail: provider.id });
    }
  }

  /** A new, parked thread with an empty journal. */
  private addThread(init: Pick<ThreadMeta, "title" | "dir" | "provider" | "model" | "projectSettings"> & { sessionId?: string }): Thread {
    const id = randomUUID();
    const folder = join(this.opts.dataDir, "threads", id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const { sessionId, ...rest } = init;
    const meta: ThreadMeta = {
      id,
      ...rest,
      createdAt: this.now(),
      updatedAt: this.now(),
      segments: [{ provider: init.provider, model: init.model, ...(sessionId ? { sessionId } : {}), startedSeq: "1" }],
    };
    const t = this.newThread(meta, new Journal(join(folder, "journal.jsonl")));
    this.threads.set(id, t);
    this.saveMeta(t);
    return t;
  }

  // --- sessions kept on the machine ------------------------------------------

  /** The AI's sessions on the machine, with the thread that holds each one. */
  localSessions(req: { provider: string } & SessionQuery): Omit<SessionPage, "sessions"> & { sessions: LocalSessionView[] } {
    const history = this.provider(req.provider || "claude").history;
    if (!history) return { sessions: [], total: 0, dirs: [] };
    const page = history.list({ dir: req.dir, query: req.query, offset: req.offset, limit: req.limit });
    return { ...page, sessions: page.sessions.map((s) => this.localView(s)) };
  }

  private localView(s: LocalSession): LocalSessionView {
    const holder = this.holder(s.sessionId);
    return {
      ...s,
      threadId: holder?.meta.id ?? "",
      // Open in a session of this machine's own: that is here, not elsewhere.
      busyElsewhere: s.busy && !(holder && this.isOpen(holder)),
      sensitive: this.opts.isSensitive(s.dir),
    };
  }

  /** The thread whose AI session this is, if any. */
  private holder(sessionId: string): Thread | undefined {
    const id = sessionId.toLowerCase();
    for (const t of this.threads.values()) {
      if (t.meta.segments.some((seg) => seg.sessionId?.toLowerCase() === id)) return t;
    }
    return undefined;
  }

  /**
   * A session kept on the machine as a thread: its transcript (the newest
   * part of a long one) goes into the journal, and the next message resumes
   * the same session in its folder. A session a thread holds already gives
   * that thread, brought up to date.
   */
  async openLocal(req: { provider: string; sessionId: string; consent: ConsentGiven; openAnyway: boolean; device: string }): Promise<ThreadSummary> {
    const provider = this.provider(req.provider || "claude");
    const found = provider.history?.find(req.sessionId);
    if (!provider.history || !found) {
      throw new AgentError(ErrorCode.NOT_FOUND, "no such session on this machine", { reason: ErrorReason.SESSION_NOT_FOUND, subject: req.sessionId });
    }
    const view = this.localView(found);
    if (view.busyElsewhere && !req.openAnyway) {
      throw new AgentError(ErrorCode.INVALID, "this session seems open elsewhere on the machine", { reason: ErrorReason.SESSION_OPEN_ELSEWHERE, subject: found.dir });
    }
    const held = this.holder(found.sessionId);
    if (held) {
      this.syncHistory(held);
      return this.summary(held);
    }
    const dir = resolve(found.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AgentError(ErrorCode.INVALID, "folder not found", { reason: ErrorReason.FOLDER_NOT_FOUND, subject: dir });
    await this.admit(provider, dir, req.consent, req.device);
    const t = this.addThread({
      title: found.title.slice(0, 80),
      dir,
      provider: provider.id,
      model: "",
      projectSettings: req.consent.projectSettings,
      sessionId: found.sessionId,
    });
    this.syncHistory(t);
    return this.touch(t);
  }

  /**
   * Reads into the journal what the AI's transcript of the thread's session
   * got since the journal last caught up: turns typed in a terminal or an
   * IDE on the session. Never during a turn of this machine's own. Returns
   * how many items came in.
   */
  private syncHistory(t: Thread): number {
    if (t.running || t.starting || t.switching) return 0;
    const seg = t.meta.segments.at(-1);
    const history = this.opts.providers.find((p) => p.id === t.meta.provider)?.history;
    if (!history || !seg?.sessionId) return 0;
    const mark = t.meta.history?.sessionId === seg.sessionId ? t.meta.history.end : undefined;
    let end: number | undefined;
    try {
      end = history.end(seg.sessionId);
    } catch {
      return 0;
    }
    if (end === undefined || (mark !== undefined && end === mark)) return 0;
    // Cut short (rewritten): nothing to add, start from its new end.
    const read = mark !== undefined && end < mark ? { entries: [], end } : history.read(seg.sessionId, mark ?? "recent");
    if (!read) return 0;
    // Without a mark (a thread from before marks) the journal may hold what the transcript has: skip equal texts.
    const added = this.importHistory(t, read.entries, mark === undefined);
    t.meta.history = { sessionId: seg.sessionId, end: read.end };
    this.saveMeta(t);
    return added;
  }

  /** The transcript holds everything the thread did so far: later appends come from elsewhere. */
  private markHistory(t: Thread): void {
    const seg = t.meta.segments.at(-1);
    const history = this.opts.providers.find((p) => p.id === t.meta.provider)?.history;
    if (!history || !seg?.sessionId) return;
    try {
      const end = history.end(seg.sessionId);
      if (end !== undefined) t.meta.history = { sessionId: seg.sessionId, end };
    } catch {
      // unreadable now: the next look reads from the last mark
    }
  }

  private importHistory(t: Thread, entries: HistoryEntry[], skipEqualTexts: boolean): number {
    const texts = new Map<string, number>();
    if (skipEqualTexts) {
      for (const item of t.journal.all()) {
        if (item.body.case === "text") {
          const key = `${item.body.value.role}:${item.body.value.text}`;
          texts.set(key, (texts.get(key) ?? 0) + 1);
        }
      }
    }
    const items: Item[] = [];
    for (const e of entries) {
      const entry = historyItem(e, t.meta.dir, this.opts.isSensitive);
      const prev = t.journal.get(entry.id);
      // The same item seen live or read before; a subagent may have finished, a todo list changed since.
      if (prev && !(e.type === "todo" || (e.type === "subagent" && e.done && prev.body.case === "subagent" && !prev.body.value.done))) continue;
      if (e.type === "subagent" && prev?.body.case === "subagent") entry.body = { case: "subagent", value: { ...prev.body.value, done: true } };
      if (entry.body.case === "text") {
        const key = `${entry.body.value.role ?? Role.UNSPECIFIED}:${entry.body.value.text ?? ""}`;
        const n = texts.get(key) ?? 0;
        if (n > 0) {
          texts.set(key, n - 1);
          continue;
        }
      }
      items.push(t.journal.put(entry.id, entry.body, { provider: t.meta.provider, model: t.meta.model, now: e.at || this.now() }));
    }
    if (items.length === 0) return 0;
    for (const fn of this.listeners) fn(t.meta.id, items);
    t.preview = lastPreview(t.journal.all());
    this.touch(t);
    return items.length;
  }

  async send(threadId: string, text: string, clientMsgId: string): Promise<void> {
    const t = this.thread(threadId);
    if (!text.trim()) throw new AgentError(ErrorCode.INVALID, "empty message", { reason: ErrorReason.EMPTY_MESSAGE });
    if (clientMsgId) {
      if (t.clientMsgIds.has(clientMsgId)) return;
      t.clientMsgIds.add(clientMsgId);
    }
    t.limitSeen = false;
    // Turns typed elsewhere since come first; an open session opens again so the AI reads them.
    if (!t.running && this.syncHistory(t) > 0 && t.session) await this.park(t);
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

  respond(
    threadId: string,
    itemId: string,
    expectedRevision: number,
    answer: { decision?: Decision; answers?: Answers; denyMessage?: string },
    device: string,
  ): void {
    const t = this.thread(threadId);
    const p = t.pending.get(itemId);
    const item = t.journal.get(itemId);
    if (!p || !item || item.revision !== expectedRevision) {
      throw new AgentError(ErrorCode.STALE, "this prompt changed or was answered", { reason: ErrorReason.PROMPT_STALE });
    }
    const denyMessage = (answer.denyMessage ?? "").trim();
    if (denyMessage && (p.kind !== "approval" || (answer.decision ?? Decision.DENY) !== Decision.DENY)) {
      throw new AgentError(ErrorCode.INVALID, "a message goes with a denial only", { reason: ErrorReason.DENY_MESSAGE_INVALID });
    }
    if (denyMessage.length > DENY_MESSAGE_MAX) {
      throw new AgentError(ErrorCode.INVALID, `the message is longer than ${DENY_MESSAGE_MAX} characters`, { reason: ErrorReason.DENY_MESSAGE_INVALID });
    }
    t.pending.delete(itemId);
    if (p.kind === "approval") {
      let decision = answer.decision ?? Decision.DENY;
      if (decision === Decision.ALLOW_SESSION && p.sensitive) decision = Decision.ALLOW;
      this.update(t, itemId, (b) => {
        if (b.case === "approval") {
          b.value.state = PromptState.ANSWERED;
          b.value.decision = decision;
          if (denyMessage) b.value.denyMessage = denyMessage;
        }
      });
      if (p.sensitive && decision !== Decision.DENY && item.body.case === "approval") {
        this.opts.audit.write({ device, action: "approve_sensitive", path: t.meta.dir, detail: `${item.body.value.name} ${item.body.value.summary}` });
      }
      if (decision === Decision.ALLOW) p.resolve({ decision: "allow" });
      else if (decision === Decision.ALLOW_SESSION) p.resolve({ decision: "allow-session" });
      else p.resolve(denyMessage ? { decision: "deny", message: denyMessage } : { decision: "deny" });
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
      throw new AgentError(ErrorCode.INVALID, `unknown effort "${effort}"`, { reason: ErrorReason.UNKNOWN_EFFORT, subject: effort });
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
    if (!this.permissionModes(t).includes(mode)) {
      throw new AgentError(ErrorCode.INVALID, `permission mode "${mode}" is not allowed from a device`, {
        reason: ErrorReason.PERMISSION_MODE_NOT_ALLOWED,
        subject: mode,
      });
    }
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
    if (target.id === t.meta.provider) throw new AgentError(ErrorCode.INVALID, "already on this AI", { reason: ErrorReason.SAME_AI });
    this.assertReady(target, await target.detect(this.detectOptions()));
    if (t.running) await this.interrupt(threadId);
    this.cancelPending(t);
    await this.park(t);
    const from = this.provider(t.meta.provider).name;
    const git = await gitChanges(t.meta.dir);
    const summary = buildHandoff({ from, to: target.name, dir: t.meta.dir, items: t.journal.all(), gitStat: git.stat });
    t.meta.provider = target.id;
    t.meta.model = model;
    // Another AI: rules in the old one's syntax mean nothing there.
    delete t.meta.sessionRules;
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

  /** The AI is installed and signed in, or the refusal says which is missing. */
  private assertReady(provider: AgentProvider, detected: { installed: boolean; loginState: string }): void {
    if (!detected.installed) {
      throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `${provider.name} is not installed`, { reason: ErrorReason.AI_NOT_INSTALLED, subject: provider.name });
    }
    if (detected.loginState === "needs-login") {
      throw new AgentError(ErrorCode.NEEDS_LOGIN, `${provider.name} needs sign-in`, { reason: ErrorReason.AI_NEEDS_LOGIN, subject: provider.name });
    }
  }

  /** The sign-in to check before a new session: that of the selected profile. */
  private detectOptions(): { accountDir?: string } {
    let dir: string | undefined;
    try {
      dir = this.opts.selectedAccountDir?.();
    } catch (err) {
      const why = (err as Error).message;
      throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, why, { reason: ErrorReason.PROFILE_UNUSABLE, subject: why.slice(0, 300) });
    }
    return dir ? { accountDir: dir } : {};
  }

  private async ensureSession(t: Thread): Promise<void> {
    // Moving to the machine's profile: the message goes to the session it opens.
    if (t.switching) await t.switching;
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
    await this.openSession(t);
  }

  /** Opens the thread's session (resumed when it had one) on the machine's profile and sends what waits. */
  private async openSession(t: Thread): Promise<void> {
    const provider = this.provider(t.meta.provider);
    const seg = t.meta.segments.at(-1);
    const askUser = ((req: ApprovalRequest | QuestionRequest, signal: AbortSignal) => this.ask(t, req, signal)) as AskUser;
    // A session opens on the machine's profile now; an open one moves to it when idle.
    // When the selection cannot be read, the turn fails: never another account quietly.
    let profile: { id: string; accountDir?: string };
    try {
      profile = this.opts.profile?.() ?? { id: "" };
    } catch (err) {
      const why = (err as Error).message;
      const message = `the Claude account picked on this machine cannot be used: ${why}`.slice(0, 500);
      this.put(t, `error:${randomUUID()}`, { case: "error", value: { message } });
      this.endTurn(t, TurnState.FAILED, 0);
      throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, message, { reason: ErrorReason.PROFILE_UNUSABLE, subject: why.slice(0, 300) });
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
      ...(t.meta.sessionRules?.length ? { sessionRules: [...t.meta.sessionRules] } : {}),
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
      const why = (err as Error).message;
      this.put(t, `error:${randomUUID()}`, { case: "error", value: { message: why.slice(0, 500) } });
      this.endTurn(t, TurnState.FAILED, 0);
      throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, why, { reason: ErrorReason.AI_START_FAILED, subject: why.slice(0, 300) });
    } finally {
      delete t.starting;
    }
    void this.consume(t, t.session, profile.id).finally(() => lease?.release());
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

  /** Events of one session; usage and account it reports belong to the profile it opened with. */
  private async consume(t: Thread, session: ProviderSession, profileId: string): Promise<void> {
    for await (const e of session.events) this.handle(t, e, profileId);
    if (t.session === session) {
      delete t.session;
      if (t.running) this.endTurn(t, TurnState.FAILED, 0);
      this.cancelPending(t);
      this.touch(t);
    }
  }

  private handle(t: Thread, e: ProviderEvent, profileId: string): void {
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
      case "tool-end":
      case "diff":
      case "todo": {
        const entry = historyItem(e, t.meta.dir, this.opts.isSensitive);
        this.put(t, entry.id, entry.body);
        return;
      }
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
      case "session-rules": {
        const rules = [...(t.meta.sessionRules ?? [])];
        for (const rule of e.rules) if (!rules.includes(rule)) rules.push(rule);
        t.meta.sessionRules = rules.slice(-SESSION_RULES_MAX);
        this.saveMeta(t);
        return;
      }
      case "limit-reached":
        if (t.limitSeen) return;
        t.limitSeen = true;
        void this.suggest(t, profileId);
        return;
    }
  }

  /** The session's profile ran out: offer another one with room (a hint for devices, never a switch). */
  private async suggest(t: Thread, profileId: string): Promise<void> {
    let suggestion: ProfileSuggestion | undefined;
    try {
      suggestion = await this.opts.suggestProfile?.(profileId);
    } catch {
      return;
    }
    // Already moved on (or the machine moved there): nothing to offer.
    if (!suggestion || this.profileOf(t) !== profileId || this.machineProfile() === suggestion.id) return;
    t.suggestion = suggestion;
    for (const fn of this.infoListeners) fn(t.meta.id);
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
    delete t.runningTool;
    this.markHistory(t);
    // A turn that went through: the profile has room again.
    if (state === TurnState.COMPLETED && t.suggestion && !t.limitSeen) {
      delete t.suggestion;
      for (const fn of this.infoListeners) fn(t.meta.id);
    }
    this.touch(t);
    void this.dequeue();
    // The machine switched profile during the turn: move now.
    void this.follow(t);
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
      limitSeen: false,
      preview: "",
      info: (meta.info ??= {}),
    };
  }

  private thread(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw new AgentError(ErrorCode.NOT_FOUND, "no such thread", { reason: ErrorReason.THREAD_NOT_FOUND });
    return t;
  }

  private provider(id: string): AgentProvider {
    const p = this.opts.providers.find((x) => x.id === id);
    if (!p) throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `unknown AI "${id}"`, { reason: ErrorReason.UNKNOWN_AI, subject: id });
    return p;
  }

  private put(t: Thread, id: string, body: ItemBody): Item {
    const item = t.journal.put(id, body, { provider: t.meta.provider, model: t.meta.model, now: this.now() });
    for (const fn of this.listeners) fn(t.meta.id, [item]);
    this.notePreview(t, item);
    return item;
  }

  private update(t: Thread, id: string, change: (b: Item["body"]) => void): void {
    const item = t.journal.update(id, change);
    if (!item) return;
    for (const fn of this.listeners) fn(t.meta.id, [item]);
    this.notePreview(t, item);
  }

  /**
   * Keeps the thread's preview line and running tool. Devices hear of it with
   * the thread list event when a tool starts or ends and when a text is
   * complete (not on every streamed piece); the turn's end tells the rest.
   */
  private notePreview(t: Thread, item: Item): void {
    const b = item.body;
    if (b.case === "text") {
      const line = previewOf(item);
      if (line !== undefined) t.preview = line;
      if (!b.value.partial && b.value.role === Role.ASSISTANT) this.announce(t);
    } else if (b.case === "toolCall" && t.running) {
      t.runningTool = { toolId: b.value.toolId, name: b.value.name };
      this.announce(t);
    } else if (b.case === "toolResult" && t.runningTool?.toolId === b.value.toolId) {
      delete t.runningTool;
      this.announce(t);
    }
  }

  /** The thread list event, without counting as activity (no new updated_at). */
  private announce(t: Thread): void {
    const s = this.summary(t);
    for (const fn of this.statusListeners) fn(s);
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
      open: this.isOpen(t),
      preview: t.preview,
      previewTool: t.running ? (t.runningTool?.name ?? "") : "",
    });
  }
}

/** The preview line of a user or AI text item; undefined for anything else (thinking, empty text). */
function previewOf(item: Item): string | undefined {
  const b = item.body;
  if (b.case !== "text" || (b.value.role !== Role.USER && b.value.role !== Role.ASSISTANT)) return undefined;
  const line = previewLine(b.value.text);
  return line === "" ? undefined : line;
}

/** The preview of a loaded thread: its last user or AI text. */
function lastPreview(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const line = item ? previewOf(item) : undefined;
    if (line !== undefined) return line;
  }
  return "";
}

/**
 * The journal item of a tool call, result, diff or todo list, live or read
 * back from a transcript, and of what only transcripts give (user messages,
 * whole texts, finished subagents, compactions). Ids match between the two.
 */
function historyItem(e: HistoryEntry | Extract<ProviderEvent, { type: "tool-start" | "tool-end" | "diff" | "todo" }>, dir: string, isSensitive: (p: string) => boolean): { id: string; body: ItemBody } {
  switch (e.type) {
    case "user":
      return { id: e.id, body: { case: "text", value: { role: Role.USER, text: e.text } } };
    case "text":
      return { id: `text:${e.blockId}`, body: { case: "text", value: { role: e.role === "assistant" ? Role.ASSISTANT : Role.THINKING, text: e.text } } };
    case "tool-start":
      return {
        id: `tool:${e.toolId}`,
        body: {
          case: "toolCall",
          value: { toolId: e.toolId, kind: KIND[e.kind], name: e.name, summary: e.summary, input: e.input, sensitive: mentionsSensitive(`${e.summary} ${e.input}`, isSensitive, { cwd: dir }) },
        },
      };
    case "tool-end": {
      // A transcript read back keeps a bounded copy; a live result is kept whole.
      const output = "at" in e && e.output.length > HISTORY_OUTPUT_MAX ? e.output.slice(0, HISTORY_OUTPUT_MAX) : e.output;
      return { id: `result:${e.toolId}`, body: { case: "toolResult", value: { toolId: e.toolId, ok: e.ok, output } } };
    }
    case "diff":
      return { id: `diff:${e.toolId}`, body: { case: "diff", value: { toolId: e.toolId, path: e.path, unified: e.unified, added: e.added, removed: e.removed } } };
    case "todo":
      return {
        id: "todo",
        body: {
          case: "todo",
          value: {
            entries: e.entries.map((x) => ({
              text: x.text,
              state: x.state === "done" ? TodoState.DONE : x.state === "in-progress" ? TodoState.IN_PROGRESS : TodoState.PENDING,
            })),
          },
        },
      };
    case "subagent":
      return { id: `sub:${e.toolId}`, body: { case: "subagent", value: { toolId: e.toolId, description: e.description, done: e.done } } };
    case "compaction":
      return { id: `compact:at:${e.at}`, body: { case: "compaction", value: { tokensBefore: BigInt(e.tokensBefore) } } };
  }
}

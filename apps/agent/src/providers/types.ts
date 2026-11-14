// Adapter contract. The agent core (link, journal, permissions, consent log,
// session limits, push) never knows which AI runs; each AI is an adapter that
// maps its own events and tool names onto these shapes.
//
// Every adapter must: run the official CLI the user installed, use the
// user's own login or key, never read or forward credentials, and route
// every permission through `askUser`.

import type { SessionMcp } from "../mcp/session-tickets.ts";

export type ToolKind = "read" | "edit" | "shell" | "search" | "web" | "mcp" | "subagent" | "todo" | "other";

export type ProviderCapabilities = {
  interrupt: boolean;
  resume: boolean;
  sessionAllow: boolean;
  questions: boolean;
  todo: boolean;
  contextUsage: boolean;
  compaction: boolean;
  diff: boolean;
  /** Takes images with a message (ProviderSession.send). */
  images: boolean;
  models: { id: string; name: string }[];
  /** Reasoning effort levels, lowest first; empty when the AI has none. */
  effortLevels: string[];
  /** Permission modes a device may pick; never one that skips every prompt. */
  permissionModes: string[];
  /**
   * The AI's mode that skips every prompt, in its own name. A device may
   * pick it only for a thread whose machine starts sessions there; unset
   * when the AI has none.
   */
  bypassModeId?: string;
  /** Sessions take tunelo's own MCP (and its ticket). */
  sessionMcp?: boolean;
};

export type LoginState = "ok" | "needs-login" | "unknown";

export type Detected = {
  installed: boolean;
  version?: string;
  loginState: LoginState;
  untestedVersion?: boolean;
  /** The model the AI's own settings on the machine pick for a session that picks none; unset when they pick none. */
  defaultModel?: string;
};

export type TodoEntry = { text: string; state: "pending" | "in-progress" | "done" };

export type SlashCommand = { name: string; description: string; argumentHint: string; builtin: boolean };

export type RateWindow = { utilization: number; resetsAt: number };

/** Who the AI is signed in as, from the CLI itself; never a credential. */
export type AccountInfo = { email: string; organization: string; plan: string };

/**
 * The account of an AI a session, a check or a CLI runs with, as the AI's
 * accounts facet hands it out: its id and the folder the adapter keeps it in
 * (Claude: CLAUDE_CONFIG_DIR). Unset everywhere for the AI's own sign-in.
 */
export type AccountScopeRef = { id: string; dir: string };

/** Statusline data; each field present only when it changed or is known. */
export type ProviderInfo = {
  permissionMode?: string;
  /** The session's reasoning effort; "" for the AI's default. */
  effort?: string;
  commands?: SlashCommand[];
  linesAdded?: number;
  linesRemoved?: number;
  rateLimits?: { fiveHour?: RateWindow; sevenDay?: RateWindow };
  /** Machine-wide, like rateLimits. */
  account?: AccountInfo;
};

/**
 * What an AI reports about a finished turn. Tokens and round trips are the
 * turn's own; `apiMsTotal` and `costUsdTotal` are the session's running
 * totals so far (the core takes the turn's share), cost at API prices and
 * only an estimate.
 */
export type TurnStats = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  numTurns: number;
  apiMsTotal: number;
  costUsdTotal: number;
};

export type ProviderEvent =
  | ({ type: "info" } & ProviderInfo)
  /** The adapter's own session id, kept for resume. */
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; blockId: string; role: "assistant" | "thinking"; text: string }
  | { type: "text"; blockId: string; role: "assistant" | "thinking"; text: string }
  | { type: "tool-start"; toolId: string; kind: ToolKind; name: string; summary: string; input: string }
  | { type: "tool-end"; toolId: string; ok: boolean; output: string }
  /** `parentToolId`: an edit made inside that subagent. */
  | { type: "diff"; toolId: string; path: string; unified: string; added: number; removed: number; parentToolId?: string }
  | { type: "todo"; entries: TodoEntry[] }
  | { type: "subagent"; toolId: string; description: string; done: boolean }
  | { type: "status"; text: string }
  | { type: "usage"; contextTokens: number; contextWindow: number }
  /**
   * Output tokens one reply of the AI (`messageId`) produced so far, counted
   * as they stream (the count of that reply only, growing). Optional: an AI
   * that does not stream them shows no count.
   */
  | { type: "output-tokens"; messageId: string; tokens: number }
  | { type: "compaction"; tokensBefore: number }
  | { type: "turn-end"; state: "completed" | "interrupted" | "failed"; durationMs: number; stats?: TurnStats }
  | { type: "error"; message: string; needsLogin?: boolean }
  /**
   * The user allowed a tool for the whole session: the allow rules it added,
   * in the AI's own rule syntax (Claude: "Bash(npm test:*)"). The core keeps
   * them with the thread and hands them back whenever the session opens again.
   */
  | { type: "session-rules"; rules: string[] }
  /** The account's plan usage ran out (rejected for its rate limit); resetsAt in Unix milliseconds, 0 when unknown. */
  | { type: "limit-reached"; resetsAt: number };

export type ApprovalRequest = {
  kind: "approval";
  toolId: string;
  toolKind: ToolKind;
  name: string;
  summary: string;
  input: string;
  /** Touches a sensitive path; never offered "allow for the session". */
  sensitive: boolean;
  reason?: string;
  /** Sign-in secrets the command reads, with the site each belongs to ("" when the session holds none of that name). */
  secrets?: { name: string; origin: string }[];
};

export type Question = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};

export type QuestionRequest = { kind: "question"; toolId: string; questions: Question[] };

/** A denial may carry what the user tells the AI instead; it reads it as the tool's answer. */
export type ApprovalAnswer = { decision: "allow" | "allow-session" } | { decision: "deny"; message?: string };
/** One entry per question: chosen labels or free text. */
export type QuestionAnswer = { answers: string[][] } | { cancelled: true };

export type AskUser = {
  (req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
  (req: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer>;
};

export type SessionPolicy = {
  /** Absolute working directory. */
  dir: string;
  /** MCP servers the user enabled on this machine (adapter-specific config). */
  mcpServers: Record<string, unknown>;
  /** Load the folder's own agent configuration (settings, hooks, permission rules, skills, commands). */
  projectSettings: boolean;
  /** Tells whether a path is sensitive (for the approval card label). */
  isSensitive: (path: string) => boolean;
  model?: string;
  /** Picked from a device; unset keeps the machine's own settings. */
  effort?: string;
  permissionMode?: string;
  /** The machine's own settings start sessions in the AI's bypass mode, so a device may return to it. */
  allowBypass?: boolean;
  /** The account picked on the machine for this AI; unset for its own sign-in. */
  account?: AccountScopeRef;
  /** tunelo's own MCP for this session (its ticket ends with the session). */
  sessionMcp?: SessionMcp;
  /**
   * Allow rules the user gave "for the session" before (session-rules
   * events), so a session opened again (another profile, after parking, after
   * a restart) does not ask again. Allow rules only: never a mode or a folder.
   */
  sessionRules?: string[];
};

export type DetectOptions = {
  /** Check the sign-in of this account instead of the AI's own one. */
  account?: AccountScopeRef;
};

/** An image going with a message, to an AI whose capabilities say `images`. */
export type ImageInput = { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: Uint8Array };

export interface ProviderSession {
  readonly events: AsyncIterable<ProviderEvent>;
  /** `text` may be empty when images go. */
  send(text: string, images?: readonly ImageInput[]): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  setModel?(model: string): Promise<void>;
  setEffort?(effort: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
}

/** A session the AI keeps on this machine, whatever started it (a terminal, an IDE, an app, tunelo). */
export type LocalSession = {
  sessionId: string;
  /** The working directory the session started in, as its transcript records it. */
  dir: string;
  title: string;
  /** Unix milliseconds of the transcript's last change. */
  updatedAt: number;
  /** User messages and AI replies; 0 when not counted. */
  messages: number;
  /** What started it, as the transcript says; "" when unknown. */
  entrypoint: string;
  /** Changed in the last minute, or a running process of the AI says it holds it. */
  busy: boolean;
};

export type SessionQuery = {
  /** Only sessions started in this folder or below it; "" for all. */
  dir: string;
  /** Words that must all appear in the title, the first message or the folder. */
  query: string;
  offset: number;
  limit: number;
};

/**
 * A session's liveness as its AI can tell it: "busy" while a turn runs,
 * "idle" once it went quiet, "unknown" when it cannot tell (no record).
 * `since`: Unix milliseconds of the last activity seen; `tool`: the tool
 * running now, by its name, when known; `via`: what told it. `held`: a
 * running process of the AI holds the session open, busy or idle (a terminal
 * left open on it); absent when none does or the AI cannot tell. It never
 * changes `state`: an idle held session is still "idle". `turnOpen`: the
 * transcript ends inside a turn (a tool call without its result, a request
 * without its answer) however long ago; absent when the AI cannot tell.
 */
export type Liveness = { state: "busy" | "idle" | "unknown"; since?: number; tool?: string; held?: boolean; turnOpen?: boolean; via: "transcript" | "process" | "api" };

export type SessionPage = { sessions: LocalSession[]; total: number; dirs: { dir: string; sessions: number }[] };

/**
 * One past entry of a session as the AI's own transcript keeps it. Ids are
 * stable: the same entry read twice (or seen live) has the same id.
 */
export type HistoryEntry = { at: number } & (
  | { type: "user"; id: string; text: string }
  | Extract<ProviderEvent, { type: "text" | "tool-start" | "tool-end" | "diff" | "todo" | "subagent" | "compaction" }>
);

/** Where a session's transcript ends now; read() continues from such a position. */
export type HistoryRead = { entries: HistoryEntry[]; end: number };

/** The AI's own record of its sessions on this machine. */
export interface SessionHistory {
  /** Brings what tells busy sessions apart up to date before list() or find(); quick, never fails. */
  prime?(): Promise<void>;
  list(q: SessionQuery): SessionPage;
  find(sessionId: string): LocalSession | undefined;
  /** Where the transcript ends now; undefined when there is none. */
  end(sessionId: string): number | undefined;
  /**
   * Entries from position `from` to the end. "recent" reads the newest part
   * only (a long session is cut at a user message). Undefined when there is
   * no transcript.
   */
  read(sessionId: string, from: number | "recent"): HistoryRead | undefined;
  /**
   * The AI's own files of the session, to move to the trash when its thread
   * is deleted: only files of that session, inside the AI's own folders;
   * empty when there are none.
   */
  sessionFiles?(sessionId: string): string[];
  /**
   * Shells and subagents the AI started in the background in the session and
   * that its record does not show finished: a count, from the record only
   * (whether anything still holds the session is holds()). 0 when none or no
   * record. Never fails.
   */
  backgroundTasks?(sessionId: string): number;
  /** Whether a running process of the AI holds the session, as of the last prime(). Never fails. */
  holds?(sessionId: string): boolean;
  /**
   * Whether the session is running a turn right now, wherever it runs (a
   * terminal, an IDE, another app, or this machine's own session: telling
   * those apart is the core's job), and whether a running process of the AI
   * holds it open (as of the last prime()). Each AI tells it its own way;
   * never fails.
   */
  liveness?(sessionId: string): Promise<Liveness>;
}

/** What a thread's session needs to open in the AI's own CLI, as the core knows it. */
export type TerminalLaunch = {
  /** Absolute working directory. */
  dir: string;
  /** The session to resume; unset starts a new one. */
  resumeId?: string;
  /** The account picked on the machine for this AI; unset for its own sign-in. */
  account?: AccountScopeRef;
  model?: string;
  /** One of the AI's own permission modes (never one that skips every prompt). */
  permissionMode?: string;
};

/** The program the terminal process runs for a TerminalLaunch: argv, never a shell line. */
export type TerminalCommand = {
  file: string;
  args: string[];
  /** Environment the AI needs; only names the terminal process accepts (see ShellEnv). */
  env: Record<string, string>;
  /** The new session's id, when the CLI lets the caller pick it (so the thread knows it at once). */
  sessionId?: string;
};

/** The AI's own CLI in a terminal of the machine, for users who prefer it to the chat view. */
export interface TerminalRunner {
  /** The command for `req`; undefined when the CLI is not installed. Throws on a value it refuses. */
  command(req: TerminalLaunch): Promise<TerminalCommand | undefined>;
}

/** One transcript file the AI keeps on the machine, as found on disk now. */
export type UsageFile = { path: string; dev: number; ino: number; size: number; mtimeMs: number };

/**
 * One API call of the AI as its transcript records it: numbers and names
 * only, never a message, a tool's input or its result. `key` is the AI's own
 * id of the call (the same call copied into another transcript keeps it).
 * Token counts the AI does not record are absent.
 */
export type UsageTurn = {
  key: string;
  sessionId: string;
  /** A subagent's call (its transcript sits under the session's subagents). */
  subagent: boolean;
  agentId?: string;
  /** Unix milliseconds. */
  at: number;
  model: string;
  /** The working directory of this call. */
  cwd: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  /** Names of the tools the call used; for a skill, the skill's name. */
  tools: string[];
};

/** What a read saw of the transcript's records, to tell whether its format changed. */
export type UsageLineStats = {
  /** Records of the AI's replies read. */
  records: number;
  /** Of those, records that carry token counts. */
  withUsage: number;
  parseErrors: number;
  /** Lines longer than the reader takes, skipped without being kept. */
  overCap: number;
  /** Kinds of reply content the reader does not know, by kind. */
  unknownTypes: Record<string, number>;
};

/** `end`: the byte after the last whole line read; a line still being written is left for the next read. */
export type UsageRead = { turns: UsageTurn[]; end: number; stats: UsageLineStats };

/** The AI's token usage as its own transcripts on the machine record it. */
export interface UsageSource {
  /** Every transcript file, each once (links are not followed). */
  files(): Promise<UsageFile[]>;
  /**
   * The calls recorded in `file` from byte `from` on; `onChunk` hears the
   * bytes of each piece read (a caller may free memory between pieces of a
   * large file).
   */
  read(file: UsageFile, from: number, onChunk?: (bytes: number) => void): Promise<UsageRead>;
}

/**
 * Environment a plain shell of the machine's terminal takes so the AI's own
 * CLI typed there uses the account picked on the machine. Only names the
 * terminal process accepts (apps/term-host: its fixed list).
 */
export type ShellEnv = Partial<Record<"CLAUDE_CONFIG_DIR", string>>;

export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** For a plain shell, the environment of the account picked on the machine (unset: the AI's own sign-in). */
  shellEnv?(account: AccountScopeRef | undefined): ShellEnv;
  /** Several accounts of the AI kept on the machine, one picked; absent when the AI has none to switch. */
  readonly accounts?: AccountsFacet;
  /**
   * Files of the AI's IDE integrations that name local ports the AI's IDE
   * extension listens on (Claude: ~/.claude/ide/*.lock), so tunnels never
   * forward them. Absent when the AI keeps none.
   */
  ideLockDirs?(): string[];
  detect(opts?: DetectOptions): Promise<Detected>;
  start(opts: { policy: SessionPolicy; resumeId?: string; askUser: AskUser }): Promise<ProviderSession>;
  /** Sessions the AI keeps on the machine; absent when it keeps none tunelo can read. */
  readonly history?: SessionHistory;
  /** Its CLI opens in the machine's terminal; absent when it has none. */
  readonly terminal?: TerminalRunner;
  /** Token usage from the AI's own transcripts; absent when it keeps none tunelo can read. */
  readonly usage?: UsageSource;
  /** Writes a short text in one go (a commit message); absent when the AI cannot. */
  readonly writer?: TextWriter;
  /**
   * The AI's slash commands and skills in a folder, as a session there would
   * offer them, without starting a turn (a thread whose session has not opened
   * yet, e.g. one run in the terminal). Absent when the AI cannot tell.
   */
  listCommands?(req: CommandsRequest): Promise<SlashCommand[]>;
}

export type CommandsRequest = {
  /** Absolute working directory. */
  dir: string;
  /** With the folder's own configuration (its skills and commands), as the thread's session loads it. */
  projectSettings: boolean;
  /** The account picked on the machine for this AI; unset for its own sign-in. */
  account?: AccountScopeRef;
};

export type WriteRequest = {
  /** Everything the AI reads: it gets no tool, no project setting and no file. */
  prompt: string;
  /** One of the AI's models; unset: the AI's own pick for short writing. */
  model?: string;
  /** The account picked on the machine for this AI; unset for its own sign-in. */
  account?: AccountScopeRef;
  timeoutMs: number;
};

/** One answer to one prompt, saving no session. Throws with the AI's own error when it fails. */
export interface TextWriter {
  write(req: WriteRequest): Promise<string>;
}

// --- accounts ------------------------------------------------------------------

export type AccountStatus = "ok" | "needs-sign-in" | "error";

/** Plan usage last read for an account; `updatedAt` in Unix milliseconds. */
export type AccountUsage = { fiveHour?: RateWindow | undefined; sevenDay?: RateWindow | undefined; updatedAt: number };

/** One account of an AI as devices see it; never a credential. */
export type AiAccountInfo = {
  /** "" for the AI's own sign-in on the machine. */
  id: string;
  /** A name when there is no email to show; may be "". */
  label: string;
  email: string;
  organization: string;
  plan: string;
  status: AccountStatus;
  /** Unix milliseconds; 0 for the AI's own sign-in. */
  createdAt: number;
  /** Unix milliseconds the sign-in ends; 0 when unknown. */
  loginExpiresAt: number;
  usage?: AccountUsage;
};

/** Every account of one AI, its own sign-in first, and the one picked ("" for its own). */
export type AccountsView = { accounts: AiAccountInfo[]; selectedId: string };

/** Another account of the same AI with usage left, for a session whose account ran out. */
export type AccountSuggestion = { id: string; email: string; remaining: number };

export type SignInError = "code-rejected" | "duplicate" | "expired" | "cancelled" | "busy" | "sign-in-on-machine" | "failed";
export type SignInStart = { ok: true; attemptId: string; url: string; expiresAt: number } | { ok: false; error: SignInError };
export type SignInOutcome = { ok: true; id: string; email: string; organization: string } | { ok: false; error: SignInError };

export type AccountsListener = {
  /** The AI's picked account changed (picked, or unselected by a removal): its sessions move to it. */
  onSelect?: (id: string) => void;
  /** What devices see of the accounts changed (picked, added, removed, usage read). */
  onChange?: () => void;
};

/**
 * The accounts of one AI on the machine. Each AI keeps its own list and its
 * own pick; nothing here touches another AI's sessions. Methods that read the
 * kept list throw an AccountError ("damaged") when it cannot be read, rather
 * than run on another account.
 */
export interface AccountsFacet {
  /** Every account, asking the AI's CLI where what is kept is old. */
  list(): Promise<AccountsView>;
  /** Every account from what is kept, without asking the CLI (for announcing a change). */
  view(): AccountsView;
  /** The picked account ("" for the AI's own sign-in); undefined when the list cannot be read. */
  selectedId(): string | undefined;
  /** The picked account, only looked up (checking its sign-in); undefined for the AI's own. Throws when unreadable. */
  selectedScope(): AccountScopeRef | undefined;
  /** What a session opening now runs with, made ready for it. Throws when unreadable. */
  sessionAccount(): { id: string; scope?: AccountScopeRef };
  /** Who an account is signed in as, from what is kept; undefined when unknown. */
  account(id: string): AccountInfo | undefined;
  /** Usage a session or a refresh reported for an account. */
  recordUsage(id: string, usage: NonNullable<ProviderInfo["rateLimits"]>): void;
  /** For a session whose account ran out: another one with room, or undefined. */
  suggestion(exhaustedId: string): Promise<AccountSuggestion | undefined>;
  select(id: string, device: string): Promise<void>;
  remove(id: string, device: string, options?: { force?: boolean }): Promise<void>;
  /** Reads an account's plan usage now; absent when the AI cannot tell it outside a session. */
  refreshUsage?(id: string): Promise<void>;
  /** A new account signs in from a device (a link, then a pasted code). */
  readonly signIn?: {
    begin(): Promise<SignInStart>;
    code(attemptId: string, code: string): Promise<SignInOutcome>;
    cancel(attemptId: string): Promise<void>;
  };
  /** Keeps the account the AI is signed in as now as a saved one. */
  captureCurrent?(device: string): Promise<void>;
  /** Who hears about changes (the machine); one listener, the last set. */
  listen(listener: AccountsListener): void;
  /** Leftovers of an unfinished sign-in a crash left: cleaned at start. */
  cleanLeftovers?(): Promise<void>;
  /** The service is stopping: a sign-in in progress ends. */
  stop?(): Promise<void>;
}

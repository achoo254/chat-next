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
  /** Sessions take tunelo's own MCP (and its ticket). */
  sessionMcp?: boolean;
};

export type LoginState = "ok" | "needs-login" | "unknown";

export type Detected = { installed: boolean; version?: string; loginState: LoginState; untestedVersion?: boolean };

export type TodoEntry = { text: string; state: "pending" | "in-progress" | "done" };

export type SlashCommand = { name: string; description: string; argumentHint: string; builtin: boolean };

export type RateWindow = { utilization: number; resetsAt: number };

/** Who the AI is signed in as, from the CLI itself; never a credential. */
export type AccountInfo = { email: string; organization: string; plan: string };

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
  /** Load the project's own agent settings and hooks. */
  projectSettings: boolean;
  /** Tells whether a path is sensitive (for the approval card label). */
  isSensitive: (path: string) => boolean;
  model?: string;
  /** Picked from a device; unset keeps the machine's own settings. */
  effort?: string;
  permissionMode?: string;
  /** The machine's own settings start sessions in bypassPermissions, so a device may return to it. */
  allowBypass?: boolean;
  /** The AI's config folder of the account picked on the machine (Claude: CLAUDE_CONFIG_DIR); unset for its default. */
  accountDir?: string;
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
  /** Check the sign-in of this account folder instead of the AI's default one. */
  accountDir?: string;
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
 * running now, by its name, when known; `via`: what told it.
 */
export type Liveness = { state: "busy" | "idle" | "unknown"; since?: number; tool?: string; via: "transcript" | "process" | "api" };

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

/** The AI's own record of its sessions on this machine (Claude: ~/.claude/projects). */
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
   * Whether the session is running a turn right now, wherever it runs (a
   * terminal, an IDE, another app, or this machine's own session: telling
   * those apart is the core's job). Each AI tells it its own way; never fails.
   */
  liveness?(sessionId: string): Promise<Liveness>;
}

export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  detect(opts?: DetectOptions): Promise<Detected>;
  start(opts: { policy: SessionPolicy; resumeId?: string; askUser: AskUser }): Promise<ProviderSession>;
  /** Sessions the AI keeps on the machine; absent when it keeps none tunelo can read. */
  readonly history?: SessionHistory;
}

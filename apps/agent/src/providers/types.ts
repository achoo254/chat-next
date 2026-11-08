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
  images: boolean;
  models: { id: string; name: string }[];
  /** Reasoning effort levels, lowest first; empty when the AI has none. */
  effortLevels: string[];
  /** Permission modes a device may pick; never one that skips every prompt. */
  permissionModes: string[];
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

export type ProviderEvent =
  | ({ type: "info" } & ProviderInfo)
  /** The adapter's own session id, kept for resume. */
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; blockId: string; role: "assistant" | "thinking"; text: string }
  | { type: "text"; blockId: string; role: "assistant" | "thinking"; text: string }
  | { type: "tool-start"; toolId: string; kind: ToolKind; name: string; summary: string; input: string }
  | { type: "tool-end"; toolId: string; ok: boolean; output: string }
  | { type: "diff"; toolId: string; path: string; unified: string; added: number; removed: number }
  | { type: "todo"; entries: TodoEntry[] }
  | { type: "subagent"; toolId: string; description: string; done: boolean }
  | { type: "status"; text: string }
  | { type: "usage"; contextTokens: number; contextWindow: number }
  | { type: "compaction"; tokensBefore: number }
  | { type: "turn-end"; state: "completed" | "interrupted" | "failed"; durationMs: number }
  | { type: "error"; message: string; needsLogin?: boolean };

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
};

export type Question = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};

export type QuestionRequest = { kind: "question"; toolId: string; questions: Question[] };

export type ApprovalAnswer = { decision: "allow" | "allow-session" | "deny" };
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
};

export type DetectOptions = {
  /** Check the sign-in of this account folder instead of the AI's default one. */
  accountDir?: string;
};

export interface ProviderSession {
  readonly events: AsyncIterable<ProviderEvent>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  setModel?(model: string): Promise<void>;
  setEffort?(effort: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  detect(opts?: DetectOptions): Promise<Detected>;
  start(opts: { policy: SessionPolicy; resumeId?: string; askUser: AskUser }): Promise<ProviderSession>;
}

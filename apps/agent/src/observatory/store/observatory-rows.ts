// The rows of the Observatory tables as the agent sees them (camelCase,
// NULL as null, flags as booleans); observatory-table-specs.ts maps each
// onto its table (schema-v1.ts). A read returns every field; a write gives
// the key and the NOT NULL columns, and leaves out what its source does not
// know (the merge of observatory-table-specs.ts decides what the stored row
// keeps).

/** A write of `R`: the fields in `Required`, any of the others. */
export type RowWrite<R, Required extends keyof R> = Pick<R, Required> & { [P in Exclude<keyof R, Required>]?: R[P] | undefined };

export type SessionSource = "sdk" | "terminal" | "cli";

export type SessionRow = {
  sessionId: string;
  /** The session this one continues after /clear. */
  previousSessionId: string | null;
  /** The link to the previous session was inferred (paired by time), not reported by Claude Code. */
  previousSessionInferred: boolean | null;
  /** usage/repo-key.ts's key of the working directory. */
  projectKey: string | null;
  /** The working directory, home folder as `~`. */
  cwd: string | null;
  source: SessionSource;
  /** An internal tag (the Advisor's sessions), left out of statistics. */
  internalLabel: string | null;
  startedAt: number;
  endedAt: number | null;
  mainModel: string | null;
};

export type PromptRow = {
  promptId: string;
  sessionId: string;
  at: number;
  length: number | null;
  excerpt: string | null;
  /** The project of the event that wrote the excerpt (the session's when null). */
  projectKey: string | null;
};

export type ToolCallRow = {
  toolUseId: string;
  sessionId: string;
  promptId: string | null;
  agentId: string | null;
  at: number;
  toolName: string | null;
  /** The office room of the call (docs/office-wire.md part 4), lower case: `library`, `work`, `qa`, `post`… */
  officeRoom: string | null;
  mcpServer: string | null;
  /** The file or domain the call touched, as the ingest extracted it. */
  target: string | null;
  durationMs: number | null;
  inputBytes: number | null;
  outputBytes: number | null;
  success: boolean | null;
  error: string | null;
  content: string | null;
  /** The project of the event that wrote the content (the session's when null). */
  projectKey: string | null;
};

export type SubagentRow = {
  agentId: string;
  sessionId: string;
  promptId: string | null;
  agentType: string | null;
  startedAt: number;
  endedAt: number | null;
  model: string | null;
  totalTokens: number | null;
  toolCount: number | null;
};

export type ApiRequestRow = {
  dedupeKey: string;
  sessionId: string;
  promptId: string | null;
  agentId: string | null;
  at: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  querySource: string | null;
};

export type InstructionLoadedRow = {
  sessionId: string;
  /** The load's place among the session's loads (0, 1, …): the same file loads again for the same reason after a compaction. */
  seq: number;
  at: number;
  filePath: string;
  memoryType: string | null;
  loadReason: string;
};

export type GitOpRow = { sessionId: string; promptId: string | null; at: number; sha: string | null; branch: string | null; kind: string };

export type ContentSettingRow = { projectKey: string; storeContent: boolean; updatedAt: number };

export type DailyRollupRow = {
  day: string;
  projectKey: string;
  model: string;
  sessions: number;
  prompts: number;
  toolCalls: number;
  toolFailures: number;
  subagents: number;
  apiRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  costUsd: number;
  gitOps: number;
};

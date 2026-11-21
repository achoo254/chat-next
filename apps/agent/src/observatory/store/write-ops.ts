// The writes the store takes, one kind per table, and how each runs. A
// batch of them runs in one transaction (ObservatoryStore.write): writing
// row by row, each its own commit, measured about a hundred times slower.
import type {
  ApiRequestRow,
  ContentSettingRow,
  GitOpRow,
  InstructionLoadedRow,
  PromptRow,
  RowWrite,
  SessionRow,
  SubagentRow,
  ToolCallRow,
} from "./observatory-rows.ts";
import {
  API_REQUESTS,
  CONTENT_SETTINGS,
  GIT_OPS,
  INSTRUCTIONS_LOADED,
  PROMPTS,
  SESSIONS,
  SUBAGENTS,
  TOOL_CALLS,
  type TableSpec,
} from "./observatory-table-specs.ts";
import { type LooseRow, encodeRow, writeSql } from "./row-codec.ts";
import type { SqliteConnection } from "./sqlite-driver.ts";
import { ObservatoryInvalidWrite } from "./store-errors.ts";

export type SessionWrite = RowWrite<SessionRow, "sessionId" | "source" | "startedAt">;
export type PromptWrite = RowWrite<PromptRow, "promptId" | "sessionId" | "at">;
export type ToolCallWrite = RowWrite<ToolCallRow, "toolUseId" | "sessionId" | "at">;
export type SubagentWrite = RowWrite<SubagentRow, "sessionId" | "agentId" | "startedAt">;
export type ApiRequestWrite = RowWrite<ApiRequestRow, "dedupeKey" | "sessionId" | "at">;
export type InstructionLoadedWrite = RowWrite<InstructionLoadedRow, "sessionId" | "seq" | "at" | "filePath" | "loadReason">;
export type GitOpWrite = RowWrite<GitOpRow, "sessionId" | "at" | "kind">;

/**
 * One write: kinds with an upsert key merge into the row of their key, the
 * others keep the first copy of a duplicate (observatory-table-specs.ts), so
 * writing the same event twice (a retried batch, a second source) is harmless.
 */
export type WriteOp =
  | { kind: "session"; row: SessionWrite }
  | { kind: "prompt"; row: PromptWrite }
  | { kind: "toolCall"; row: ToolCallWrite }
  | { kind: "subagent"; row: SubagentWrite }
  | { kind: "apiRequest"; row: ApiRequestWrite }
  | { kind: "instructionLoaded"; row: InstructionLoadedWrite }
  | { kind: "gitOp"; row: GitOpWrite }
  | { kind: "contentSetting"; row: ContentSettingRow };

function put<R>(db: SqliteConnection, spec: TableSpec<R>, row: LooseRow<R>): void {
  db.run(writeSql(spec), encodeRow(spec, row));
}

/**
 * Content is not stored for a session whose project has it switched off
 * (content_settings), whatever order the writes come in: a write still
 * queued from before the switch, or a late source, brings its excerpt or
 * content here and it is dropped; the stored row keeps NULL (clearContent
 * removed what was there). A session not stored yet has no known project, so
 * its content passes until clearContent runs again.
 */
function contentBlocked(db: SqliteConnection, sessionId: string): boolean {
  return (
    db.all(
      `SELECT 1 AS blocked FROM sessions s JOIN content_settings cs ON cs.project_key = s.project_key
       WHERE s.session_id = ? AND cs.store_content = 0`,
      [sessionId],
    ).length > 0
  );
}

/** Runs one write; the caller holds the transaction. */
export function applyWriteOp(db: SqliteConnection, op: WriteOp): void {
  switch (op.kind) {
    case "session":
      return put(db, SESSIONS, op.row);
    case "prompt": {
      const blocked = op.row.excerpt != null && contentBlocked(db, op.row.sessionId);
      return put(db, PROMPTS, blocked ? { ...op.row, excerpt: undefined } : op.row);
    }
    case "toolCall": {
      const blocked = op.row.content != null && contentBlocked(db, op.row.sessionId);
      return put(db, TOOL_CALLS, blocked ? { ...op.row, content: undefined } : op.row);
    }
    case "subagent":
      return put(db, SUBAGENTS, op.row);
    case "apiRequest":
      return put(db, API_REQUESTS, op.row);
    case "instructionLoaded":
      return put(db, INSTRUCTIONS_LOADED, op.row);
    case "gitOp":
      return put(db, GIT_OPS, op.row);
    case "contentSetting":
      return put(db, CONTENT_SETTINGS, op.row);
    default: {
      // Unreachable for typed callers; a malformed op from elsewhere fails its batch.
      const unknown: never = op;
      throw new ObservatoryInvalidWrite(`unknown Observatory write: ${JSON.stringify(unknown).slice(0, 80)}`);
    }
  }
}

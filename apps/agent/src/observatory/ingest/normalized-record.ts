// What the normalizer makes of one filtered record: the writes it implies on
// its own, and the facts a write depends on another record for, which the
// ingest's join state (ingest-joins.ts) completes: a tool's duration from its
// Pre and Post, the /clear pair of two sessions, the place of an instruction
// load among the session's loads, the branch of a commit Claude Code did not
// describe.
import type { SessionSource } from "../store/observatory-rows.ts";
import type { SessionWrite, WriteOp } from "../store/write-ops.ts";

/** One end of a tool call: its PreToolUse (start) or PostToolUse / PostToolUseFailure (end). */
export type ToolEdge = { toolUseId: string; sessionId: string; at: number; hasDuration: boolean };

/** One half of a /clear: the session ended with reason `clear`, or the one started with source `clear`, in folder `cwd`. */
export type ClearHalf = { sessionId: string; cwd: string; at: number; source: SessionSource };

/** An InstructionsLoaded event; its `seq` comes from the join state. */
export type InstructionLoad = { sessionId: string; at: number; filePath: string; memoryType?: string | undefined; loadReason: string };

/** A `git commit` whose tool response had no gitOperation: the branch is read from the repository of `cwd` (with `~`). */
export type UndescribedCommit = { sessionId: string; toolUseId: string; promptId?: string | undefined; at: number; cwd: string };

/**
 * - stored: the record's writes are in `ops` (and the join facts);
 * - known: an event the normalizer knows that has no table (Stop, PostToolBatch…);
 * - unknown-event: an event it does not know: counted, nothing written;
 * - missing-key: the key its table needs is absent: counted, nothing written.
 */
export type NormalizeOutcome = "stored" | "known" | "unknown-event" | "missing-key";

export type NormalizedRecord = {
  outcome: NormalizeOutcome;
  /** The session the record belongs to. */
  sessionId?: string;
  /**
   * The session row as this record knows it (hook records only: OpenTelemetry
   * does not know the session's source or folder). Written before the
   * record's other writes, every time: an upsert on its key costs little, and
   * the row is then back after a wipe or a write the writer had to drop.
   */
  session?: SessionWrite;
  ops: WriteOp[];
  toolStart?: ToolEdge;
  toolEnd?: ToolEdge;
  clearEnded?: ClearHalf;
  clearStarted?: ClearHalf;
  instruction?: InstructionLoad;
  undescribedCommit?: UndescribedCommit;
  /** Field names the normalizer does not know for this event. */
  unknownFields: string[];
  /** Fields present with an unexpected type (treated as absent). */
  mistypedFields: string[];
};

export function emptyNormalized(outcome: NormalizeOutcome, sessionId?: string): NormalizedRecord {
  return { outcome, ...(sessionId ? { sessionId } : {}), ops: [], unknownFields: [], mistypedFields: [] };
}

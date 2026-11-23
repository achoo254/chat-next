// The ingest's memory across records, for the writes one record cannot make
// alone. Everything here is bounded (bounded-map.ts) and lost on restart;
// the store's keys stay the guarantee against duplicates, this only adds what
// a join brings:
// - a tool call's duration from its PreToolUse and PostToolUse when the hook
//   did not tell it (either may arrive first);
// - the link of a session to the one it continues after /clear: Claude Code
//   gives no field for it, so a SessionEnd(reason=clear) and a
//   SessionStart(source=clear) in the same folder within CLEAR_PAIR_MS are
//   paired, flagged as inferred (a certain link in the store always wins);
// - an instruction load's `seq` (instruction-load-seq.ts): its place among
//   the loads of the same file for the same reason in the session, continued
//   from the loads already stored, so it survives a restart;
// - a commit Claude Code did not describe, written once per tool call;
// - a tool call's measures (duration, sizes): OpenTelemetry's are exact, the
//   hooks' sizes estimates, so once OpenTelemetry measured a call the hooks'
//   values for it are left out, whichever source came first;
// - a change of a session's permission mode or main model: the value each
//   record shows is compared with the latest one seen before it (a record
//   older than that one is ignored, so sources arriving out of order do not
//   make changes up); the first value seen after a start is no change.
import type { RecordOrigin } from "../privacy/filtered-record.ts";
import type { ToolCallWrite, WriteOp } from "../store/write-ops.ts";
import { BoundedMap } from "./bounded-map.ts";
import { InstructionLoadSeq, type StoredLoads } from "./instruction-load-seq.ts";
import type { ClearHalf, InstructionLoad, SessionValue, ToolEdge, UndescribedCommit } from "./normalized-record.ts";
import { sessionEventOp } from "./session-event-write.ts";

/** The longest time between the two halves of a /clear (hooks run apart; the spool's clock is the hook process's). */
export const CLEAR_PAIR_MS = 30_000;
const MAX_ENTRIES = 20_000;
const MEASURES = ["durationMs", "inputBytes", "outputBytes"] as const;
type Measure = (typeof MEASURES)[number];

type ToolTimes = { sessionId: string; startAt?: number; endAt?: number; endHasDuration?: boolean };

export class IngestJoins {
  private readonly tools = new BoundedMap<string, ToolTimes>(MAX_ENTRIES);
  /** The measures OpenTelemetry gave for each tool call. */
  private readonly measured = new BoundedMap<string, ReadonlySet<Measure>>(MAX_ENTRIES);
  private readonly clearEnds = new BoundedMap<string, ClearHalf[]>(1_000);
  private readonly clearStarts = new BoundedMap<string, ClearHalf[]>(1_000);
  /** Sessions already given a link, and sessions already used as the previous one. */
  private readonly linked = new BoundedMap<string, true>(MAX_ENTRIES);
  private readonly commits = new BoundedMap<string, true>(MAX_ENTRIES);
  /** The latest permission mode and main model seen per session. */
  private readonly latest = new BoundedMap<string, { at: number; value: string }>(MAX_ENTRIES);
  private readonly loadSeq: InstructionLoadSeq;

  /** `storedLoads` reads the instruction loads already stored (instruction-load-seq.ts); none by default. */
  constructor(storedLoads: StoredLoads = () => []) {
    this.loadSeq = new InstructionLoadSeq(storedLoads);
  }

  /** `op` as written: a hook's tool call write without the measures OpenTelemetry already gave for the call. */
  preferMeasured(op: WriteOp, fromOtel: boolean): WriteOp {
    if (op.kind !== "toolCall") return op;
    const id = op.row.toolUseId;
    if (fromOtel) {
      const given = MEASURES.filter((m) => op.row[m] !== undefined);
      if (given.length > 0) this.measured.set(id, new Set([...(this.measured.get(id) ?? []), ...given]));
      return op;
    }
    const known = this.measured.get(id);
    if (!known) return op;
    const row: ToolCallWrite = { ...op.row };
    for (const m of known) row[m] = undefined;
    return { kind: "toolCall", row };
  }

  /** A tool call's start; the duration write when its end came first without one. */
  toolStarted(edge: ToolEdge): WriteOp[] {
    const t = this.tools.get(edge.toolUseId) ?? { sessionId: edge.sessionId };
    t.startAt = Math.min(t.startAt ?? edge.at, edge.at);
    this.tools.set(edge.toolUseId, t);
    return this.duration(edge.toolUseId, t);
  }

  /** A tool call's end; the duration write when it told none and its start is known. */
  toolEnded(edge: ToolEdge): WriteOp[] {
    const t = this.tools.get(edge.toolUseId) ?? { sessionId: edge.sessionId };
    t.endAt = Math.max(t.endAt ?? edge.at, edge.at);
    t.endHasDuration = (t.endHasDuration ?? false) || edge.hasDuration;
    this.tools.set(edge.toolUseId, t);
    return this.duration(edge.toolUseId, t);
  }

  private duration(toolUseId: string, t: ToolTimes): WriteOp[] {
    if (t.endHasDuration === true || t.startAt === undefined || t.endAt === undefined || t.endAt < t.startAt) return [];
    return [{ kind: "toolCall", row: { toolUseId, sessionId: t.sessionId, at: t.startAt, durationMs: t.endAt - t.startAt } }];
  }

  /** A session ended by /clear: the link write when the new session's start is already here. */
  clearEnded(end: ClearHalf): WriteOp[] {
    if (this.linked.has(`prev:${end.sessionId}`)) return [];
    const start = this.closest(this.clearStarts, end.cwd, end.at, (s) => s.sessionId !== end.sessionId && !this.linked.has(`next:${s.sessionId}`));
    if (!start) {
      this.remember(this.clearEnds, end);
      return [];
    }
    return this.link(end, start);
  }

  /** A session started by /clear: the link write when the ended session is already here. */
  clearStarted(start: ClearHalf): WriteOp[] {
    if (this.linked.has(`next:${start.sessionId}`)) return [];
    const end = this.closest(this.clearEnds, start.cwd, start.at, (e) => e.sessionId !== start.sessionId && !this.linked.has(`prev:${e.sessionId}`));
    if (!end) {
      this.remember(this.clearStarts, start);
      return [];
    }
    return this.link(end, start);
  }

  private remember(halves: BoundedMap<string, ClearHalf[]>, half: ClearHalf): void {
    const list = (halves.get(half.cwd) ?? []).filter((h) => Math.abs(h.at - half.at) <= CLEAR_PAIR_MS * 10 && h.sessionId !== half.sessionId);
    halves.set(half.cwd, [...list, half].slice(-20));
  }

  private closest(halves: BoundedMap<string, ClearHalf[]>, cwd: string, at: number, ok: (h: ClearHalf) => boolean): ClearHalf | undefined {
    let best: ClearHalf | undefined;
    for (const h of halves.get(cwd) ?? []) {
      if (!ok(h) || Math.abs(h.at - at) > CLEAR_PAIR_MS) continue;
      if (!best || Math.abs(h.at - at) < Math.abs(best.at - at)) best = h;
    }
    return best;
  }

  private link(end: ClearHalf, start: ClearHalf): WriteOp[] {
    this.linked.set(`prev:${end.sessionId}`, true);
    this.linked.set(`next:${start.sessionId}`, true);
    return [{ kind: "session", row: { sessionId: start.sessionId, source: start.source, startedAt: start.at, previousSessionId: end.sessionId, previousSessionInferred: true } }];
  }

  /** The write of an instruction load, with its place among the same loads of the session from `origin`. */
  instructionLoaded(load: InstructionLoad, origin: RecordOrigin): WriteOp[] {
    const seq = this.loadSeq.seqOf(load, origin);
    return [{ kind: "instructionLoaded", row: { sessionId: load.sessionId, seq, at: load.at, filePath: load.filePath, memoryType: load.memoryType, loadReason: load.loadReason } }];
  }

  /** The event of a change of the session's `kind` value (its permission mode, its main model), when `seen` changes it. */
  valueSeen(kind: "permission_mode" | "model_change", seen: SessionValue): WriteOp[] {
    const key = JSON.stringify([kind, seen.sessionId]);
    const before = this.latest.get(key);
    if (before && seen.at < before.at) return [];
    this.latest.set(key, { at: seen.at, value: seen.value });
    if (!before || before.value === seen.value) return [];
    return [sessionEventOp(kind, { sessionId: seen.sessionId, at: seen.at, station: "CORE", label: seen.value }, [seen.at, seen.value])];
  }

  /** The write of a commit Claude Code did not describe, once per tool call: the branch `branchOf` tells, no sha. */
  undescribedCommit(commit: UndescribedCommit, branchOf: (cwd: string) => string | undefined): WriteOp[] {
    const key = JSON.stringify([commit.sessionId, commit.toolUseId]);
    if (this.commits.has(key)) return [];
    this.commits.set(key, true);
    return [{ kind: "gitOp", row: { sessionId: commit.sessionId, promptId: commit.promptId, at: commit.at, branch: branchOf(commit.cwd), kind: "commit" } }];
  }
}

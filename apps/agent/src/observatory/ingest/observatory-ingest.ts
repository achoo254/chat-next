// The ingest: takes filtered records from the three sources (SDK hook
// callbacks in the agent, the hook spool, the OTLP receiver), normalizes each
// (normalize-hook-record.ts, normalize-otel-record.ts), completes the joins
// (ingest-joins.ts) and pushes the writes to the store's batch writer, the
// session's row first so the store knows the session's project (and blocks
// its content when the project keeps none) before the session's events land.
//
// It follows the sink's contract (privacy/filtered-record.ts): every write is
// pushed synchronously, inside `accept`; a record it cannot use (an unknown
// event, a missing key, a field of an unexpected type, even a failure of the
// normalizer itself) is counted, logged once by name, and accepted: it never
// rejects, so a record never comes back from the spool for a reason that
// would not change.
//
// Duplicates: the store merges a second copy of an event into its row (each
// table has its key). Records of a session the agent runs through the SDK
// also reach the spool, because the hooks installed for the CLI run in SDK
// sessions too: those spool records are dropped here, the callbacks are the
// session's one source.
import { join } from "node:path";
import { redact } from "../../mcp/redact.ts";
import type { FilteredRecord, ObservatorySink, RecordOrigin } from "../privacy/filtered-record.ts";
import { hideHomePaths } from "../privacy/home-and-account.ts";
import { labelValue } from "../privacy/privacy-labels.ts";
import type { WriteOp } from "../store/write-ops.ts";
import { BoundedMap } from "./bounded-map.ts";
import { gitHeadBranch } from "./git-head-branch.ts";
import { IngestJoins } from "./ingest-joins.ts";
import type { StoredLoads } from "./instruction-load-seq.ts";
import type { NormalizedRecord } from "./normalized-record.ts";
import { normalizeHookRecord } from "./normalize-hook-record.ts";
import { normalizeOtelRecord } from "./normalize-otel-record.ts";

export type ObservatoryIngestOptions = {
  /** Pushes one write into the store's batch writer (never throws). */
  push: (op: WriteOp) => void;
  /** The home folder, for `~` in a session's folder. */
  home: string;
  /** One line for the agent's log (names only, never content). */
  log: (line: string) => void;
  /** The branch checked out in the repository holding a folder (git-head-branch.ts by default). */
  branchOf?: (folder: string) => string | undefined;
  /** The instruction loads already stored, for their numbers to go on after a restart (instruction-load-seq.ts); none when absent. */
  storedLoads?: StoredLoads;
};

export type IngestStats = {
  records: number;
  /** Records that wrote rows. */
  stored: number;
  /** Known events with no table (Stop, PostToolBatch, tool_decision…). */
  known: number;
  unknownEvents: number;
  /** Records without the key their table needs (no session, prompt, tool use or agent id). */
  missingKeys: number;
  /** Fields not known for their event, counted per record. */
  unknownFields: number;
  /** Fields of an unexpected type, read as absent. */
  mistypedFields: number;
  /** Spool records of a session the agent runs through the SDK. */
  sdkSpoolSkipped: number;
  /** Records the normalizer failed on (a bug, not a format change). */
  failed: number;
};

const MAX_SESSIONS = 20_000;
const MAX_LOGGED_NAMES = 200;
const NAME = /^[\w.:-]{1,60}$/;

/** `cwd` as the filter keeps it (home folder as `~`) back to a folder on this machine. */
export function expandHome(cwd: string, home: string): string {
  if (cwd === "~") return home;
  return /^~[\\/]/.test(cwd) ? join(home, cwd.slice(2)) : cwd;
}

export class ObservatoryIngest implements ObservatorySink {
  readonly stats: IngestStats = { records: 0, stored: 0, known: 0, unknownEvents: 0, missingKeys: 0, unknownFields: 0, mistypedFields: 0, sdkSpoolSkipped: 0, failed: 0 };
  private readonly joins: IngestJoins;
  /** Sessions seen from an SDK callback. */
  private readonly sdkSessions = new BoundedMap<string, true>(MAX_SESSIONS);
  /** Sessions with an internal label (the Advisor's; always SDK sessions too). */
  private readonly internalSessions = new BoundedMap<string, true>(MAX_SESSIONS);
  private readonly logged = new Set<string>();

  constructor(private readonly opts: ObservatoryIngestOptions) {
    this.joins = new IngestJoins(opts.storedLoads);
  }

  accept(record: FilteredRecord, origin: RecordOrigin): Promise<void> {
    this.stats.records++;
    try {
      this.take(record, origin);
    } catch (err) {
      this.stats.failed++;
      this.note("failed on", record.event, err instanceof Error ? err.name : typeof err);
    }
    return Promise.resolve();
  }

  /**
   * A session whose spool records are left out: one the agent runs through
   * the SDK (its callbacks are its one source) or one with an internal label.
   * Known from the records taken since the agent started.
   */
  isAgentSession(sessionId: string): boolean {
    return this.sdkSessions.has(sessionId) || this.internalSessions.has(sessionId);
  }

  private take(record: FilteredRecord, origin: RecordOrigin): void {
    const n = record.src === "hook" ? normalizeHookRecord(record, origin) : normalizeOtelRecord(record);
    if (n.sessionId && origin === "sdk") this.sdkSessions.set(n.sessionId, true);
    if (n.sessionId && n.session?.internalLabel) this.internalSessions.set(n.sessionId, true);
    if (n.sessionId && origin === "spool" && this.sdkSessions.has(n.sessionId)) {
      this.stats.sdkSpoolSkipped++;
      return;
    }
    this.countFields(record.event, n);
    if (n.outcome === "unknown-event") {
      this.stats.unknownEvents++;
      this.note(`skipped unknown ${record.src} event`, record.event);
      return;
    }
    if (n.outcome === "missing-key") this.stats.missingKeys++;
    else if (n.outcome === "known") this.stats.known++;
    else this.stats.stored++;
    // Every hook record writes its session's row first: the ingest cannot know the row is still stored (a wipe, a write the writer dropped).
    if (n.session) this.opts.push({ kind: "session", row: n.session });
    for (const op of [...n.ops, ...this.joined(n, origin)]) this.opts.push(this.joins.preferMeasured(op, record.src === "otel"));
  }

  private joined(n: NormalizedRecord, origin: RecordOrigin): WriteOp[] {
    const ops: WriteOp[] = [];
    if (n.toolStart) ops.push(...this.joins.toolStarted(n.toolStart));
    if (n.toolEnd) ops.push(...this.joins.toolEnded(n.toolEnd));
    if (n.clearEnded) ops.push(...this.joins.clearEnded(n.clearEnded));
    if (n.clearStarted) ops.push(...this.joins.clearStarted(n.clearStarted));
    if (n.instruction) ops.push(...this.joins.instructionLoaded(n.instruction, origin));
    if (n.undescribedCommit) ops.push(...this.joins.undescribedCommit(n.undescribedCommit, (cwd) => this.branchOf(cwd)));
    if (n.permissionMode) ops.push(...this.joins.valueSeen("permission_mode", n.permissionMode));
    if (n.mainModel) ops.push(...this.joins.valueSeen("model_change", n.mainModel));
    return ops;
  }

  /** The branch of the repository holding `cwd` (with `~`), as a redacted label. */
  private branchOf(cwd: string): string | undefined {
    const branch = labelValue((this.opts.branchOf ?? gitHeadBranch)(expandHome(cwd, this.opts.home)));
    return branch === undefined ? undefined : hideHomePaths(redact(branch), this.opts.home);
  }

  private countFields(event: string, n: NormalizedRecord): void {
    this.stats.unknownFields += n.unknownFields.length;
    this.stats.mistypedFields += n.mistypedFields.length;
    for (const field of n.unknownFields) this.note(`ignored an unknown field of ${event}:`, field);
    for (const field of n.mistypedFields) this.note(`ignored a field of an unexpected type in ${event}:`, field);
  }

  /** Logs `what` once per name (a field or event name: never content), for at most MAX_LOGGED_NAMES names. */
  private note(what: string, name: string, detail?: string): void {
    const shown = NAME.test(name) ? name : "(unprintable name)";
    const key = `${what} ${shown}`;
    if (this.logged.has(key) || this.logged.size >= MAX_LOGGED_NAMES) return;
    this.logged.add(key);
    // A log that throws must not make `accept` throw (the sink never rejects).
    try {
      this.opts.log(`observatory: ingest ${key}${detail ? ` (${detail})` : ""}; counted, later ones not logged`);
    } catch {
      // the count is kept; the line is lost
    }
  }
}

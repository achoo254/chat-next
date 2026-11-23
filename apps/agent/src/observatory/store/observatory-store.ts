// The Observatory database of this machine: open (open-observatory-db.ts),
// batched writes, the reads the agent serves, retention, removal of stored
// content, export, wipe.
//
// Every call is synchronous, as both drivers are, and blocks the caller's
// thread for its work plus at most the busy timeout when another connection
// holds the lock (then it throws ObservatoryStoreBusy, nothing written). The
// agent keeps batches small (batch-writer.ts) and the timeout short.
import { SCHEMA_VERSION, isNewerThanAgent, rollbackQuietly, schemaVersionOf } from "./migrate.ts";
import { deleteObservatoryDb } from "./observatory-db-files.ts";
import { observatoryDbPath } from "./observatory-db-path.ts";
import { type ExportFileOptions, type ExportSink, type ExportSummary, exportObservatory, exportObservatoryToFile } from "./observatory-export.ts";
import type { ContentSettingRow, DailyRollupRow, SessionRow } from "./observatory-rows.ts";
import { AGENT_BUSY_TIMEOUT_MS, openObservatoryDb } from "./open-observatory-db.ts";
import { type PruneResult, pruneExpired } from "./retention.ts";
import { type SqliteConnection, type SqliteRuntime, isSqliteBusy } from "./sqlite-driver.ts";
import { ObservatoryStoreBusy, ObservatoryStoreClosed, ObservatoryWipeFailed } from "./store-errors.ts";
import { type DayRange, type SessionQuery, type SessionTimeline, readContentSetting, readDailyRollups, readInstructionLoads, readSessionTimeline, readSessions } from "./store-reads.ts";
import { type WriteOp, applyWriteOp } from "./write-ops.ts";

export type { SessionTimeline };

export type OpenOptions = {
  /** This machine's database (observatory-db-path.ts) by default. */
  path?: string;
  runtime?: SqliteRuntime;
  /** How long a call waits for another connection's lock: AGENT_BUSY_TIMEOUT_MS by default, CLI_BUSY_TIMEOUT_MS for a CLI command. */
  busyTimeoutMs?: number;
};

export class ObservatoryStore {
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly opts: OpenOptions,
    private db: SqliteConnection,
  ) {}

  /** Opens the database, creating and migrating it; throws ObservatorySchemaTooNew, untouched, for a newer one this agent may not read. */
  static async open(opts: OpenOptions = {}): Promise<ObservatoryStore> {
    const path = opts.path ?? observatoryDbPath();
    return new ObservatoryStore(path, opts, await openObservatoryDb(path, opts.runtime, opts.busyTimeoutMs ?? AGENT_BUSY_TIMEOUT_MS));
  }

  get runtime(): SqliteRuntime {
    return this.live().runtime;
  }

  get schemaVersion(): number {
    return schemaVersionOf(this.live());
  }

  /**
   * True when a newer agent wrote the database and still lets this one use
   * it (migrate.ts): this agent writes, prunes and exports only the tables
   * and columns it knows, and leaves the rest as it found it.
   */
  get newerThanAgent(): boolean {
    return isNewerThanAgent(this.live());
  }

  /** The schema version this agent writes (the database's may be higher, see newerThanAgent). */
  get agentSchemaVersion(): number {
    return SCHEMA_VERSION;
  }

  private live(): SqliteConnection {
    if (this.closed) throw new ObservatoryStoreClosed();
    return this.db;
  }

  /** Runs `fn` in an IMMEDIATE transaction (the write lock taken up front); a lock held elsewhere throws ObservatoryStoreBusy. */
  private transaction<T>(fn: (db: SqliteConnection) => T): T {
    const db = this.live();
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      throw isSqliteBusy(err) ? new ObservatoryStoreBusy(err) : err;
    }
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      rollbackQuietly(db);
      throw isSqliteBusy(err) ? new ObservatoryStoreBusy(err) : err;
    }
  }

  /** Runs `ops` in one transaction: all of them land, or none (the error is thrown). */
  write(ops: readonly WriteOp[]): void {
    if (ops.length === 0) return;
    this.transaction((db) => {
      for (const op of ops) applyWriteOp(db, op);
    });
  }

  /** Sessions started in [from, to) (Unix ms), newest first, at most `limit` (up to 1000; 100 by default). */
  sessions(q: SessionQuery = {}): SessionRow[] {
    return readSessions(this.live(), q);
  }

  /** Everything stored of one session, each list in time order. */
  sessionTimeline(sessionId: string): SessionTimeline {
    return readSessionTimeline(this.live(), sessionId);
  }

  /**
   * Daily totals for days in [fromDay, toDay] (YYYY-MM-DD, both included).
   * Only days already rolled up are here (older than the detail kept, see
   * retention.ts); recent days are in the detail tables.
   */
  dailyRollups(q: DayRange = {}): DailyRollupRow[] {
    return readDailyRollups(this.live(), q);
  }

  /** The number and time of each stored load of one instruction file for one reason in a session (store-reads.ts). */
  instructionLoads(sessionId: string, filePath: string, loadReason: string): { seq: number; at: number }[] {
    return readInstructionLoads(this.live(), sessionId, filePath, loadReason);
  }

  /** The content setting of a project; undefined when it was never set (the default applies). */
  contentSetting(projectKey: string): ContentSettingRow | undefined {
    return readContentSetting(this.live(), projectKey);
  }

  /**
   * Removes the stored content of a project (prompt excerpts, tool call
   * content) from every row written in it (the row's project, else its
   * session's), in one transaction; the rest of the rows stays. Content whose
   * project cannot be told (none on the row, none on its session) goes too:
   * it may be this project's (fail closed, as write-ops.ts blocks it). Returns
   * the rows changed.
   */
  clearContent(projectKey: string): { prompts: number; toolCalls: number } {
    // A row's project is its own (the event that wrote the content), else its session's; unknown counts as this one.
    const ofProject = (table: string): string =>
      `COALESCE(${table}.project_key, (SELECT s.project_key FROM sessions s WHERE s.session_id = ${table}.session_id), ?) = ?`;
    return this.transaction((db) => ({
      prompts: db.run(`UPDATE prompts SET excerpt = NULL WHERE excerpt IS NOT NULL AND ${ofProject("prompts")}`, [projectKey, projectKey]),
      toolCalls: db.run(`UPDATE tool_calls SET content = NULL WHERE content IS NOT NULL AND ${ofProject("tool_calls")}`, [projectKey, projectKey]),
    }));
  }

  /** One retention pass at `now` (retention.ts), in one transaction; `limit` rows per table at most, days in `timeZone`. */
  prune(now: number = Date.now(), limit?: number, timeZone?: string): PruneResult {
    return this.transaction((db) => pruneExpired(db, now, limit, timeZone));
  }

  /** Writes every row of every table to `sink`, page by page (observatory-export.ts). */
  exportTo(sink: ExportSink, pageRows?: number): Promise<ExportSummary> {
    return exportObservatory(() => this.live(), sink, pageRows);
  }

  /** Writes the export to `file` (0600, through a temp file); an existing file is refused unless `overwrite`. */
  exportToFile(file: string, opts?: ExportFileOptions): Promise<ExportSummary> {
    return exportObservatoryToFile(() => this.live(), file, opts);
  }

  /** Closes the database; every later call throws ObservatoryStoreClosed. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /**
   * Closes the database and deletes its files (-wal and -shm included); the
   * store stays closed. When they cannot be deleted (on Windows: another
   * program has the database open) the store opens it again, still usable,
   * and ObservatoryWipeFailed is thrown. Calls made while it runs throw
   * ObservatoryStoreClosed.
   */
  async wipe(): Promise<void> {
    this.close();
    try {
      await deleteObservatoryDb(this.path);
    } catch (err) {
      try {
        this.db = await openObservatoryDb(this.path, this.opts.runtime, this.opts.busyTimeoutMs ?? AGENT_BUSY_TIMEOUT_MS);
        this.closed = false;
      } catch {
        // stays closed; the caller learns why from the error below
      }
      throw new ObservatoryWipeFailed(this.path, err);
    }
  }
}

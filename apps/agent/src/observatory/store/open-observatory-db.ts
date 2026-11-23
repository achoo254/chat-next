// Opening the Observatory database file, in an order that never writes to a
// database this agent must not touch:
//
// 1. the folder (0700) and an empty file (0600) when missing;
// 2. a read-only connection reads PRAGMA user_version and the minimum reader
//    version (migrate.ts): a newer schema that does not let this agent read
//    it is refused here, before any write connection exists (a read-write
//    connection closing last would checkpoint a newer agent's -wal into the
//    file, changing it). A read-only connection cannot open a WAL database
//    whose -wal and -shm are gone (bun:sqlite on macOS: SQLITE_CANTOPEN, as
//    after every clean close); with no -wal there is nothing of another
//    agent's to checkpoint, so the same reads run on a read-write
//    connection that writes nothing;
// 3. the file and folder made private, the write connection opened with the
//    caller's busy timeout, WAL with synchronous=NORMAL (a crash may lose the
//    last commits, never the file's integrity), then the migrations (none for
//    a newer database this agent may use: it is opened as it is).
//
// The busy timeout is how long a call waits for a lock another connection
// holds, with the caller's thread blocked: the agent passes a short one (a
// batch it cannot write now is retried later), the CLI a long one.
import { migrate, schemaAccess } from "./migrate.ts";
import { existsSync } from "node:fs";
import { prepareObservatoryDbFile, restrictObservatoryDbFile } from "./observatory-db-files.ts";
import { type SqliteConnection, type SqliteOpenMode, type SqliteRuntime, isSqliteCantOpen, openSqlite } from "./sqlite-driver.ts";
import { ObservatoryStoreError } from "./store-errors.ts";

/** The agent's wait for a lock: its event loop is blocked for at most this long per call. */
export const AGENT_BUSY_TIMEOUT_MS = 50;
/** A CLI command's wait for a lock (it has nothing else to do meanwhile). */
export const CLI_BUSY_TIMEOUT_MS = 5_000;

function closeQuietly(db: SqliteConnection): void {
  try {
    db.close();
  } catch {
    // the error that made us close is the one to report
  }
}

function setBusyTimeout(db: SqliteConnection, ms: number): void {
  // PRAGMA takes no bound parameter; `ms` was checked to be an integer.
  db.exec(`PRAGMA busy_timeout = ${ms}`);
}

/** Reads, on a connection of its own, whether this agent may use the database (migrate.ts); throws ObservatorySchemaTooNew when it may not. */
async function checkAccess(path: string, runtime: SqliteRuntime | undefined, busyTimeoutMs: number, mode: SqliteOpenMode): Promise<void> {
  const reader = await openSqlite(path, runtime, mode);
  try {
    setBusyTimeout(reader, busyTimeoutMs);
    schemaAccess(reader, path);
  } finally {
    closeQuietly(reader);
  }
}

/** Opens `path` for writing (creating and migrating it); throws ObservatorySchemaTooNew, untouched, for a newer database this agent may not read. */
export async function openObservatoryDb(path: string, runtime: SqliteRuntime | undefined, busyTimeoutMs: number): Promise<SqliteConnection> {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw new ObservatoryStoreError(`the busy timeout must be a non-negative integer, not ${String(busyTimeoutMs)}`);
  await prepareObservatoryDbFile(path);

  try {
    await checkAccess(path, runtime, busyTimeoutMs, "readonly");
  } catch (err) {
    if (!isSqliteCantOpen(err) || existsSync(`${path}-wal`)) throw err;
    await checkAccess(path, runtime, busyTimeoutMs, "readwrite");
  }

  await restrictObservatoryDbFile(path);
  const db = await openSqlite(path, runtime, "readwrite");
  try {
    setBusyTimeout(db, busyTimeoutMs);
    const mode = db.all("PRAGMA journal_mode = WAL")[0]?.journal_mode;
    if (mode !== "wal") throw new ObservatoryStoreError(`the Observatory database could not use WAL (journal mode ${String(mode)})`);
    db.exec("PRAGMA synchronous = NORMAL");
    // Checks the version again inside its transaction (another agent may have migrated since).
    migrate(db, path);
  } catch (err) {
    closeQuietly(db);
    throw err;
  }
  return db;
}

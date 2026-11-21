// Opening the Observatory database file, in an order that never writes to a
// database this agent must not touch:
//
// 1. the folder (0700) and an empty file (0600) when missing;
// 2. a read-only connection reads PRAGMA user_version: a newer schema is
//    refused here, before any write connection exists (a read-write
//    connection closing last would checkpoint a newer agent's -wal into the
//    file, changing it);
// 3. the file and folder made private, the write connection opened with the
//    caller's busy timeout, WAL with synchronous=NORMAL (a crash may lose the
//    last commits, never the file's integrity), then the migrations.
//
// The busy timeout is how long a call waits for a lock another connection
// holds, with the caller's thread blocked: the agent passes a short one (a
// batch it cannot write now is retried later), the CLI a long one.
import { assertNotNewer, migrate } from "./migrate.ts";
import { prepareObservatoryDbFile, restrictObservatoryDbFile } from "./observatory-db-files.ts";
import { type SqliteConnection, type SqliteRuntime, openSqlite } from "./sqlite-driver.ts";
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

/** Opens `path` for writing (creating and migrating it); throws ObservatorySchemaTooNew, untouched, for a newer database. */
export async function openObservatoryDb(path: string, runtime: SqliteRuntime | undefined, busyTimeoutMs: number): Promise<SqliteConnection> {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw new ObservatoryStoreError(`the busy timeout must be a non-negative integer, not ${String(busyTimeoutMs)}`);
  await prepareObservatoryDbFile(path);

  const reader = await openSqlite(path, runtime, "readonly");
  try {
    setBusyTimeout(reader, busyTimeoutMs);
    assertNotNewer(reader, path);
  } finally {
    closeQuietly(reader);
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

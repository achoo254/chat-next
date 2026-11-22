// Schema versions of the Observatory database, kept in PRAGMA user_version.
// Migrations only add (tables, columns, indexes) and run in one transaction
// each. A database written by a newer agent (a version above SCHEMA_VERSION)
// is refused before anything is written to it, so an older agent put back
// after an update never damages what the newer one stored.
import { SCHEMA_V1 } from "./schema-v1.ts";
import type { SqliteConnection } from "./sqlite-driver.ts";
import { ObservatorySchemaTooNew, ObservatoryStoreError } from "./store-errors.ts";

/** The schema version this agent writes. */
export const SCHEMA_VERSION = 1;

/** The statements that take the schema from `version - 1` to `version`, by version. */
const MIGRATIONS: readonly { version: number; statements: readonly string[] }[] = [{ version: 1, statements: SCHEMA_V1 }];

/**
 * Ends an open transaction after a failure. SQLite ends some transactions
 * itself (a full disk, an I/O error), and then ROLLBACK fails too: that
 * second error is dropped so the caller reports the first one.
 */
export function rollbackQuietly(db: SqliteConnection): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // the transaction had already ended
  }
}

/** The database's schema version (0 for a new file). */
export function schemaVersionOf(db: SqliteConnection): number {
  const value = db.all("PRAGMA user_version")[0]?.user_version;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ObservatoryStoreError(`the Observatory database reports an unreadable schema version (${String(value)})`);
  }
  return value;
}

/** Throws ObservatorySchemaTooNew when the database is newer than this agent; reads only. */
export function assertNotNewer(db: SqliteConnection, path: string): number {
  const version = schemaVersionOf(db);
  if (version > SCHEMA_VERSION) throw new ObservatorySchemaTooNew(version, SCHEMA_VERSION, path);
  return version;
}

/**
 * Brings the schema up to SCHEMA_VERSION, one transaction per migration. The
 * version is read again inside each transaction, so two processes opening
 * the same new file migrate it once.
 */
export function migrate(db: SqliteConnection, path: string): void {
  for (const m of MIGRATIONS) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const version = assertNotNewer(db, path);
      if (version < m.version) {
        for (const sql of m.statements) db.exec(sql);
        // PRAGMA takes no bound parameter; the version is a constant of this file.
        db.exec(`PRAGMA user_version = ${m.version}`);
      } else if (version === 1) {
        alignBeforeRelease(db);
      }
      db.exec("COMMIT");
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
  }
}

/**
 * Version 1 changed before it was released: `tool_calls.tool_kind` became
 * `office_room`, and `prompts` and `tool_calls` gained `project_key`. A
 * database a development build wrote before that is brought in line in place
 * (same version, rows kept: the new columns start NULL, which falls back on
 * the session's project), so its writes do not fail on a missing column.
 * Each step runs only when its column is missing, so running it again
 * changes nothing.
 */
function alignBeforeRelease(db: SqliteConnection): void {
  const columnsOf = (table: string): Set<unknown> => new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
  const toolCalls = columnsOf("tool_calls");
  if (toolCalls.has("tool_kind") && !toolCalls.has("office_room")) db.exec("ALTER TABLE tool_calls RENAME COLUMN tool_kind TO office_room");
  for (const table of ["prompts", "tool_calls"]) {
    if (!columnsOf(table).has("project_key")) db.exec(`ALTER TABLE ${table} ADD COLUMN project_key TEXT`);
  }
}

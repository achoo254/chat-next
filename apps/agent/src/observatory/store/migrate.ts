// Schema versions of the Observatory database, kept in PRAGMA user_version,
// and who may open a database written by a newer agent.
//
// Migrations run in one transaction each. Every database also records, in
// its `meta` table, `min_reader_version`: the lowest schema version that can
// still read and write it safely. A migration that only adds (a table, a
// column that may be NULL, an index) leaves it as it is, so an older agent
// put back after an update opens the newer database as it is: it migrates
// nothing, lowers nothing, and writes only the tables and columns it knows
// (its INSERTs name their columns; the new ones stay NULL, which is why a
// column added later must allow NULL). A migration that changes a meaning or
// removes something raises it (MIN_READER_VERSION), and an agent below it
// refuses the database before writing a byte (ObservatorySchemaTooNew).
import { META_TABLE, SCHEMA_V1 } from "./schema-v1.ts";
import { SCHEMA_V2 } from "./schema-v2.ts";
import type { SqliteConnection } from "./sqlite-driver.ts";
import { ObservatorySchemaTooNew, ObservatoryStoreError } from "./store-errors.ts";

/** The schema version this agent writes. */
export const SCHEMA_VERSION = 2;

/** The lowest schema version that can read and write a database at SCHEMA_VERSION (version 2 only adds). */
export const MIN_READER_VERSION = 1;

const MIN_READER_KEY = "min_reader_version";

/** The statements that take the schema from `version - 1` to `version`, by version. */
const MIGRATIONS: readonly { version: number; statements: readonly string[] }[] = [
  { version: 1, statements: SCHEMA_V1 },
  { version: 2, statements: SCHEMA_V2 },
];

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

/**
 * The database's `min_reader_version`; undefined when it has none (no `meta`
 * table, or no such key: a file made before the table existed). Reads only.
 */
export function minReaderVersionOf(db: SqliteConnection): number | undefined {
  const hasMeta = db.all("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'").length > 0;
  if (!hasMeta) return undefined;
  const raw = db.all("SELECT value FROM meta WHERE key = ?", [MIN_READER_KEY])[0]?.value;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ObservatoryStoreError(`the Observatory database reports an unreadable minimum reader version (${String(raw)})`);
  }
  return value;
}

/** How this agent may use a database: `current` (its own version or older, migrated on open) or `newer` (written by a newer agent that still lets it read and write). */
export type SchemaAccess = { version: number; mode: "current" | "newer" };

/**
 * Tells how this agent may use the database; throws ObservatorySchemaTooNew
 * when it may not touch it at all: newer, and either its minimum reader is
 * above this agent or it says nothing about one (a newer agent always
 * writes it, so a missing one is not trusted). Reads only.
 */
export function schemaAccess(db: SqliteConnection, path: string): SchemaAccess {
  const version = schemaVersionOf(db);
  if (version <= SCHEMA_VERSION) return { version, mode: "current" };
  const minReader = minReaderVersionOf(db);
  if (minReader === undefined || minReader > SCHEMA_VERSION) throw new ObservatorySchemaTooNew(version, SCHEMA_VERSION, path, minReader);
  return { version, mode: "newer" };
}

/** True when the database was written by a newer agent this one may still use (schemaAccess). */
export function isNewerThanAgent(db: SqliteConnection): boolean {
  return schemaVersionOf(db) > SCHEMA_VERSION;
}

/**
 * Brings the schema up to SCHEMA_VERSION, one transaction per migration,
 * then records the minimum reader. The version is read again inside each
 * transaction, so two processes opening the same new file migrate it once.
 * A newer database this agent may use is left exactly as it is.
 */
export function migrate(db: SqliteConnection, path: string): SchemaAccess {
  for (const m of MIGRATIONS) {
    const done = inTransaction(db, () => {
      const access = schemaAccess(db, path);
      if (access.mode === "newer") return true;
      if (access.version < m.version) {
        for (const sql of m.statements) db.exec(sql);
        // PRAGMA takes no bound parameter; the version is a constant of this file.
        db.exec(`PRAGMA user_version = ${m.version}`);
      } else if (m.version === 1 && access.version === 1) {
        alignBeforeRelease(db);
      }
      return false;
    });
    if (done) return { version: schemaVersionOf(db), mode: "newer" };
  }
  return inTransaction(db, () => {
    const access = schemaAccess(db, path);
    if (access.mode === "current") recordMinReader(db);
    return access;
  });
}

function inTransaction<T>(db: SqliteConnection, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/** Creates `meta` when missing and raises `min_reader_version` to MIN_READER_VERSION (never lowers it). */
function recordMinReader(db: SqliteConnection): void {
  db.exec(META_TABLE);
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
    [MIN_READER_KEY, String(MIN_READER_VERSION)],
  );
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

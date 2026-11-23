// The one door to SQLite for Observatory: a small connection interface and
// the runtime's driver behind it. The released tunelo runs under Bun
// (bun:sqlite); tests and development run under Node (node:sqlite). Both are
// loaded with a dynamic import() so neither runtime ever loads the other's
// module, and Bun's bundler keeps both calls as they are (measured before
// this layer was written). Nothing else in the agent imports a SQLite driver.
//
// Statements are prepared once per connection and kept until it closes.
// Values are strings, numbers or NULL only: booleans become 0/1 above this
// layer, and no column holds a blob or a number past 2^53.

/** A value bound to a statement's `?` placeholder. */
export type SqlValue = string | number | null;

/** A result row by column name, as the driver returned it (checked by the caller). */
export type SqlRow = Readonly<Record<string, unknown>>;

export type SqliteRuntime = "bun" | "node";

export interface SqliteConnection {
  readonly runtime: SqliteRuntime;
  /** Runs one statement that takes no parameters (DDL, PRAGMA, BEGIN/COMMIT). */
  exec(sql: string): void;
  /** Runs one statement; resolves the number of rows it changed. */
  run(sql: string, params?: readonly SqlValue[]): number;
  /** Runs one query; every row it returns. */
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  /** Finalizes every statement and closes the file. Safe to call twice. */
  close(): void;
}

/** The driver of the runtime this process runs in: Bun when `process.versions.bun` is set, else Node. */
export function currentSqliteRuntime(): SqliteRuntime {
  return process.versions.bun ? "bun" : "node";
}

export type SqliteOpenMode = "readwrite" | "readonly";

/**
 * Opens the SQLite file at `path` with the runtime's driver: `readwrite`
 * creates it when missing; `readonly` never writes it (not even a WAL
 * checkpoint when it closes).
 */
export async function openSqlite(path: string, runtime: SqliteRuntime = currentSqliteRuntime(), mode: SqliteOpenMode = "readwrite"): Promise<SqliteConnection> {
  if (runtime === "bun") {
    const { openBunSqlite } = await import("./sqlite-driver-bun.ts");
    return openBunSqlite(path, mode);
  }
  const { openNodeSqlite } = await import("./sqlite-driver-node.ts");
  return openNodeSqlite(path, mode);
}

const SQLITE_BUSY = 5;
const SQLITE_CANTOPEN = 14;
const SQLITE_CONSTRAINT = 19;
const SQLITE_MISMATCH = 20;
const PRIMARY_CODES: Record<string, number> = { SQLITE_BUSY, SQLITE_CANTOPEN, SQLITE_CONSTRAINT, SQLITE_MISMATCH };

/** The primary SQLite result code of a driver error (extended codes reduced); undefined for an error SQLite did not raise. */
export function sqliteResultCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  // node:sqlite reports `errcode`; bun:sqlite `errno` and `code` (SQLITE_CONSTRAINT_UNIQUE…).
  const { errcode, errno, code } = err as { errcode?: unknown; errno?: unknown; code?: unknown };
  for (const n of [errcode, errno]) if (typeof n === "number" && n > 0) return n & 0xff;
  if (typeof code === "string") {
    const name = Object.keys(PRIMARY_CODES).find((k) => code === k || code.startsWith(`${k}_`));
    if (name !== undefined) return PRIMARY_CODES[name];
  }
  return undefined;
}

/** SQLITE_BUSY: another connection holds the lock past the busy timeout. */
export function isSqliteBusy(err: unknown): boolean {
  return sqliteResultCode(err) === SQLITE_BUSY;
}

/** SQLITE_CANTOPEN: the file (or, for a read-only connection, its WAL index) could not be opened. */
export function isSqliteCantOpen(err: unknown): boolean {
  return sqliteResultCode(err) === SQLITE_CANTOPEN;
}

/** A constraint or a type mismatch: the statement's own values are at fault, not the database. */
export function isSqliteDataError(err: unknown): boolean {
  const code = sqliteResultCode(err);
  return code === SQLITE_CONSTRAINT || code === SQLITE_MISMATCH;
}

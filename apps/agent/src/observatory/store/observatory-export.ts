// The export of the Observatory database: every row of every table exactly
// as stored (column names and values), with the schema version they follow,
// and nothing that is not in the database (no machine name, no time of the
// export). One JSON document:
//
//   {"schemaVersion":1,"tables":{"sessions":[{...},...],"prompts":[...],...}}
//
// A database a newer agent wrote (migrate.ts) is exported with the tables
// this agent knows only, and says so in a "note" before "tables".
//
// written to a sink page by page (EXPORT_PAGE_ROWS rows by rowid), the event
// loop getting a turn between pages, so a large database is never held in
// memory nor the agent stalled. Pages are read one by one, not in one
// transaction (the agent keeps writing meanwhile): a row written during an
// export may or may not be in it.
import { randomUUID } from "node:crypto";
import { open as openFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SCHEMA_VERSION, schemaVersionOf } from "./migrate.ts";
import { OBSERVATORY_TABLES } from "./schema-v1.ts";
import type { SqliteConnection } from "./sqlite-driver.ts";
import { ObservatoryStoreError } from "./store-errors.ts";

export const EXPORT_PAGE_ROWS = 500;

/** The note of an export of a database a newer agent wrote. */
export const NEWER_DB_EXPORT_NOTE = "This database was written by a newer tunelo; the tables this version does not know are not in this export.";
const ROWID = "__export_rowid";

/** Where an export goes: called with each piece of the JSON text, in order; the next piece waits for it. */
export type ExportSink = (chunk: string) => Promise<void>;

export type ExportSummary = { rows: number };

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The JSON of one stored row, checked to hold only text, numbers and NULL. */
function rowJson(table: string, raw: Readonly<Record<string, unknown>>): string {
  const row: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === ROWID) continue;
    if (v !== null && typeof v !== "string" && typeof v !== "number") throw new ObservatoryStoreError(`${table}.${k} holds a value that cannot be exported`);
    row[k] = v;
  }
  return JSON.stringify(row);
}

/** Writes the export of the database `db()` returns (asked again for every page, so a store closed meanwhile stops the export) to `sink`. */
export async function exportObservatory(db: () => SqliteConnection, sink: ExportSink, pageRows: number = EXPORT_PAGE_ROWS): Promise<ExportSummary> {
  if (!Number.isSafeInteger(pageRows) || pageRows < 1) throw new ObservatoryStoreError(`the export page size must be a positive integer, not ${String(pageRows)}`);
  let rows = 0;
  const version = schemaVersionOf(db());
  const note = version > SCHEMA_VERSION ? `"note":${JSON.stringify(NEWER_DB_EXPORT_NOTE)},` : "";
  await sink(`{"schemaVersion":${version},${note}"tables":{`);
  for (const [i, table] of OBSERVATORY_TABLES.entries()) {
    await sink(`${i > 0 ? "," : ""}${JSON.stringify(table)}:[`);
    let after = 0;
    let first = true;
    for (;;) {
      const page = db().all(`SELECT rowid AS ${ROWID}, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after, pageRows]);
      if (page.length === 0) break;
      const last = page[page.length - 1]?.[ROWID];
      if (typeof last !== "number") throw new ObservatoryStoreError(`${table} returned a row without a rowid`);
      after = last;
      const text = page.map((r) => rowJson(table, r)).join(",");
      await sink(`${first ? "" : ","}${text}`);
      first = false;
      rows += page.length;
      if (page.length < pageRows) break;
      await yieldToLoop();
    }
    await sink("]");
  }
  await sink("}}");
  return { rows };
}

export type ExportFileOptions = {
  /** Replace a file already at the path; by default an existing file is refused and left as it is. */
  overwrite?: boolean;
  pageRows?: number;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Writes the export to `file` through a 0600 temp file in the same folder,
 * renamed over `file` once complete: a failed export leaves `file` as it
 * was (absent, or the user's own file untouched) and no temp file behind.
 * An existing `file` is refused unless `overwrite` (checked before writing
 * and again before the rename).
 */
export async function exportObservatoryToFile(db: () => SqliteConnection, file: string, opts: ExportFileOptions = {}): Promise<ExportSummary> {
  const refuse = async () => {
    if (!opts.overwrite && (await exists(file))) throw new ObservatoryStoreError(`${file} already exists; the export does not replace it`);
  };
  await refuse();
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await openFile(tmp, "wx", 0o600);
  try {
    const summary = await exportObservatory(db, async (chunk) => void (await handle.write(chunk)), opts.pageRows);
    await handle.close();
    await refuse();
    await rename(tmp, file);
    return summary;
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw err;
  }
}

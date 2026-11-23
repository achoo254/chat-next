// Rows to statement values and back, by a table's spec
// (observatory-table-specs.ts).
//
// An upsert table merges a second write of the same key column by column
// (Merge): a value is filled in, kept from the first write, or the earliest
// or latest of the two, so events of one call arriving from several sources
// in any order end as the same row. A value once stored is never set back to
// NULL by a write (ObservatoryStore.clearContent is the one way to remove
// stored content), except in a column merged `latest` (a row its one writer
// always writes whole). An `ignore` table keeps the first copy of a duplicate.
import { StationFlag } from "../live-map/station-map.ts";
import type { Column, Merge, TableSpec } from "./observatory-table-specs.ts";
import type { SqlRow, SqlValue } from "./sqlite-driver.ts";
import { ObservatoryInvalidWrite, ObservatoryStoreError } from "./store-errors.ts";

/** A row being written: any field may be left out (or undefined), stored as NULL or kept by an upsert. */
export type LooseRow<R> = { [P in keyof R]?: R[P] | undefined };

/** SQL of a column's value after a write of the same key: `n` the new value, `c` the stored one. */
function mergeSql(merge: Merge, c: string): string {
  const n = `excluded.${c}`;
  switch (merge) {
    case "fill":
      return `COALESCE(${n}, ${c})`;
    case "first":
      return `COALESCE(${c}, ${n})`;
    // SQLite's MIN/MAX of several values is NULL when one is: fall back to the one that is set.
    case "min":
      return `COALESCE(MIN(${n}, ${c}), ${n}, ${c})`;
    case "max":
      return `COALESCE(MAX(${n}, ${c}), ${n}, ${c})`;
    // A link to the previous session reported by Claude Code (previous_session_inferred = 0) is
    // final: an inferred one arriving later never replaces it. SET reads the row before the update.
    case "unlessCertain":
      return `CASE WHEN previous_session_inferred = 0 THEN ${c} ELSE COALESCE(${n}, ${c}) END`;
    // The station and its flags move together, judged by the new write: exact (a station without the
    // estimated bit) replaces what is stored; estimated only fills a call stored without a station.
    case "exactStation":
      return `CASE WHEN excluded.station IS NOT NULL AND (COALESCE(excluded.station_flags, 0) & ${StationFlag.estimated}) = 0 THEN COALESCE(${n}, ${c}) WHEN station IS NULL THEN ${n} ELSE ${c} END`;
    case "latest":
      return n;
  }
}

const writeSqlCache = new WeakMap<object, string>();

/** The INSERT (upsert, or insert-unless-duplicate) statement of `spec`, its parameters in column order. */
export function writeSql<R>(spec: TableSpec<R>): string {
  const hit = writeSqlCache.get(spec);
  if (hit !== undefined) return hit;
  const names = spec.columns.map((c) => c.column);
  let sql = `INSERT INTO ${spec.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  const conflict = spec.conflict;
  if (conflict === "ignore") sql += " ON CONFLICT DO NOTHING";
  else if (conflict !== "insert") {
    const keys = spec.columns.filter((c) => conflict.upsert.includes(c.field));
    const rest = spec.columns.filter((c) => !conflict.upsert.includes(c.field));
    sql += ` ON CONFLICT (${keys.map((c) => c.column).join(", ")}) DO UPDATE SET ${rest.map((c) => `${c.column} = ${mergeSql(c.merge, c.column)}`).join(", ")}`;
  }
  writeSqlCache.set(spec, sql);
  return sql;
}

function encodeValue(value: unknown, c: Column<unknown>, table: string): SqlValue {
  const bad = () => new ObservatoryInvalidWrite(`${table}.${c.column} cannot hold ${typeof value} ${String(value).slice(0, 40)}`);
  if (value === undefined || value === null) {
    if (c.required) throw bad();
    return null;
  }
  switch (c.type) {
    case "text":
      if (typeof value !== "string") throw bad();
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw bad();
      return value;
    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw bad();
      return value ? 1 : 0;
  }
}

/** The parameters of writeSql(spec) for `row`; throws ObservatoryInvalidWrite on a missing required value or a value of the wrong type. */
export function encodeRow<R>(spec: TableSpec<R>, row: LooseRow<R>): SqlValue[] {
  return spec.columns.map((c) => encodeValue(row[c.field], c as Column<unknown>, spec.table));
}

function decodeValue(value: unknown, c: Column<unknown>, table: string): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  const bad = () => new ObservatoryStoreError(`${table}.${c.column} holds a value of an unexpected type (${typeof value})`);
  switch (c.type) {
    case "text":
      if (typeof value !== "string") throw bad();
      return value;
    case "integer":
    case "real":
      if (typeof value !== "number") throw bad();
      return value;
    case "boolean":
      if (value !== 0 && value !== 1) throw bad();
      return value === 1;
  }
}

/** A row read by `SELECT <selectList(spec)>` as `R`; throws ObservatoryStoreError on a value of the wrong type. */
export function decodeRow<R>(spec: TableSpec<R>, raw: SqlRow): R {
  const out: Record<string, string | number | boolean | null> = {};
  for (const c of spec.columns) out[c.field] = decodeValue(raw[c.column], c as Column<unknown>, spec.table);
  // Every field of R was set above from its column, each checked against the column's type.
  return out as R;
}

/** The column list of `spec` for a SELECT. */
export function selectList<R>(spec: TableSpec<R>): string {
  return spec.columns.map((c) => c.column).join(", ");
}

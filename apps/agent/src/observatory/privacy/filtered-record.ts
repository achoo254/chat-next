// What the privacy filter hands on: one Claude Code event reduced to the
// fields Observatory stores (filter-hook-event.ts, filter-otel-record.ts).
// Only these records are written anywhere (the spool, the store, a log), so
// a field missing here never reaches the disk.
//
// Hook records keep Claude Code's own field names (snake_case) for the
// normalizer to read; OpenTelemetry records keep the attribute names.
// Content (prompt, tool input and output, messages, errors) is kept apart in
// `c`, already redacted (in the spool: the redacted window the agent's
// second pass cuts, content-excerpt.ts), and absent when the project stores
// none. A hook record carries `f.project_key` when the session's folder has
// one, worked out from the real `cwd` before it was shortened.

export const FILTERED_RECORD_VERSION = 1;

/** A field of a hook record: an id, a short label, a number, a flag, or a list of ids. */
export type HookFieldValue = string | number | boolean | readonly string[];

export type FilteredHookRecord = {
  v: typeof FILTERED_RECORD_VERSION;
  src: "hook";
  /** The hook event (`PostToolUse`). */
  event: string;
  /** When the hook ran, Unix ms. */
  at: number;
  /** The allowed fields: ids, labels (paths with the home folder as `~`), numbers, flags. */
  f: Record<string, HookFieldValue>;
  /** Content, redacted and cut; absent when the project stores none or nothing was there. */
  c?: Record<string, string>;
  /** In the spool: the content fields the hook cut at its window (true), for the agent's final cut (content-excerpt.ts). */
  truncated?: Record<string, boolean>;
};

export type OtelFieldValue = string | number | boolean;

export type FilteredOtelRecord = {
  v: typeof FILTERED_RECORD_VERSION;
  src: "otel";
  /** The log event without its prefix (`api_request`). */
  event: string;
  /** The event's time, Unix ms. */
  at: number;
  /** The allowed attributes. */
  f: Record<string, OtelFieldValue>;
};

export type FilteredRecord = FilteredHookRecord | FilteredOtelRecord;

/** Where a record came from: a hook callback in the agent, the hook spool, the OTLP receiver. */
export type RecordOrigin = "sdk" | "spool" | "otlp";

/**
 * What takes the filtered records (the normalizer of the ingest). The
 * contract:
 * - `accept` resolves once the record's writes are pushed into the batch
 *   writer; the caller then makes them durable with the writer's flush (the
 *   spool reader deletes a file only after both, spool-reader.ts).
 * - A record it does not understand (an unknown event, a field of an
 *   unexpected type) is counted and logged, and `accept` resolves: it is not
 *   an error. `accept` rejects only on a passing failure (the writes could
 *   not be queued now); the spool reader tries such a record again, and sets
 *   it aside after three refusals in a row (spool-quarantine.ts).
 * - Writes are pushed synchronously, before the first `await` of `accept`:
 *   on stop the service waits for the `accept` calls still running, then
 *   closes the writer, so a write pushed later would be lost.
 */
export interface ObservatorySink {
  accept(record: FilteredRecord, origin: RecordOrigin): Promise<void>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fieldValueOk(v: unknown): boolean {
  if (typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** `value` has the shape of a filtered record (a spool line is read back with this). */
export function isFilteredRecord(value: unknown): value is FilteredRecord {
  if (!isPlainObject(value) || value.v !== FILTERED_RECORD_VERSION) return false;
  if (value.src !== "hook" && value.src !== "otel") return false;
  if (typeof value.event !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
  if (!isPlainObject(value.f) || !Object.values(value.f).every(fieldValueOk)) return false;
  if (value.truncated !== undefined && (value.src !== "hook" || !isPlainObject(value.truncated) || !Object.values(value.truncated).every((x) => typeof x === "boolean"))) return false;
  if (value.c === undefined) return true;
  return value.src === "hook" && isPlainObject(value.c) && Object.values(value.c).every((x) => typeof x === "string");
}

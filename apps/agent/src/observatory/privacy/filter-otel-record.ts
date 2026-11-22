// An OTLP/HTTP JSON logs request (ExportLogsServiceRequest) reduced to
// filtered records by the allowlist of otel-allowlist.ts. Only Claude
// Code's resource (`service.name`) is read; each log record is judged on its
// own, so one record too large or malformed never costs the others.
import { redact } from "../../mcp/redact.ts";
import { FILTERED_RECORD_VERSION, type FilteredOtelRecord, type OtelFieldValue } from "./filtered-record.ts";
import { CLAUDE_CODE_SERVICE_NAME, COMMON_OTEL_FIELDS, OTEL_EVENT_FIELDS, type OtelRule } from "./otel-allowlist.ts";
import { idValue, labelValue } from "./privacy-labels.ts";
import { approxJsonBytes } from "./privacy-text.ts";

/** A log record larger than this (as JSON) is dropped alone. */
export const MAX_OTEL_RECORD_BYTES = 256 * 1024;
/** …or with more attributes than this (Claude Code sends a few dozen). */
export const MAX_OTEL_ATTRIBUTES = 1_000;
const EVENT_PREFIX = "claude_code.";

export type OtelFilterResult = {
  records: FilteredOtelRecord[];
  /** Records of another service (`service.name` not Claude Code's). */
  otherService: number;
  tooLarge: number;
  /** Records of events not kept. */
  ignored: number;
  /** Records or a request that could not be read. */
  malformed: number;
};

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The primitive inside an OTLP AnyValue; undefined for arrays, maps, bytes. */
function anyValue(v: unknown): string | number | boolean | undefined {
  const a = record(v);
  if (typeof a.stringValue === "string") return a.stringValue;
  if (typeof a.boolValue === "boolean") return a.boolValue;
  if (typeof a.doubleValue === "number") return a.doubleValue;
  if (typeof a.intValue === "number") return a.intValue;
  if (typeof a.intValue === "string" && /^-?\d{1,18}$/.test(a.intValue)) return Number(a.intValue);
  return undefined;
}

function attribute(attributes: unknown, key: string): string | number | boolean | undefined {
  for (const kv of list(attributes)) if (record(kv).key === key) return anyValue(record(kv).value);
  return undefined;
}

function keptValue(rule: OtelRule, value: string | number | boolean, known: readonly string[]): OtelFieldValue | undefined {
  if (rule === "id") return idValue(typeof value === "number" ? String(value) : value);
  if (rule === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (rule === "bool") return typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : undefined;
  const label = labelValue(value);
  return label === undefined ? undefined : redact(label, known);
}

/** Unix ms from OTLP nanoseconds (a decimal string or a number). */
function nanosToMs(nanos: unknown): number | undefined {
  if (typeof nanos === "number" && Number.isFinite(nanos) && nanos > 0) return Math.floor(nanos / 1e6);
  if (typeof nanos === "string" && /^\d{7,25}$/.test(nanos)) return Number(nanos.slice(0, -6));
  return undefined;
}

function eventName(log: Record<string, unknown>): string | undefined {
  const named = attribute(log.attributes, "event.name");
  if (typeof named === "string") return named.startsWith(EVENT_PREFIX) ? named.slice(EVENT_PREFIX.length) : named;
  const body = anyValue(log.body);
  return typeof body === "string" && body.startsWith(EVENT_PREFIX) ? body.slice(EVENT_PREFIX.length) : undefined;
}

function filterLog(log: Record<string, unknown>, known: readonly string[], now: number): FilteredOtelRecord | "ignored" | "malformed" {
  const event = eventName(log);
  if (event === undefined) return "malformed";
  const own = Object.hasOwn(OTEL_EVENT_FIELDS, event) ? OTEL_EVENT_FIELDS[event] : undefined;
  if (!own) return "ignored";
  const rules: Record<string, OtelRule> = { ...COMMON_OTEL_FIELDS, ...own };
  const f: Record<string, OtelFieldValue> = {};
  for (const kv of list(log.attributes)) {
    const key = record(kv).key;
    if (typeof key !== "string" || !Object.hasOwn(rules, key)) continue;
    const rule = rules[key];
    const value = anyValue(record(kv).value);
    if (rule === undefined || value === undefined) continue;
    const kept = keptValue(rule, value, known);
    if (kept !== undefined) f[key] = kept;
  }
  const at = nanosToMs(log.timeUnixNano) ?? nanosToMs(log.observedTimeUnixNano) ?? now;
  return { v: FILTERED_RECORD_VERSION, src: "otel", event, at, f };
}

/** The kept records of an OTLP logs request `body` (parsed JSON), with what was dropped and why. */
export function filterOtlpLogs(body: unknown, known: Iterable<string>, now: number): OtelFilterResult {
  const out: OtelFilterResult = { records: [], otherService: 0, tooLarge: 0, ignored: 0, malformed: 0 };
  const resourceLogs = record(body).resourceLogs;
  if (!Array.isArray(resourceLogs)) {
    out.malformed++;
    return out;
  }
  const secrets = [...known];
  for (const rl of resourceLogs) {
    const resource = record(rl);
    const ours = attribute(record(resource.resource).attributes, "service.name") === CLAUDE_CODE_SERVICE_NAME;
    for (const scope of list(resource.scopeLogs)) {
      const logs = list(record(scope).logRecords);
      if (!ours) {
        out.otherService += logs.length;
        continue;
      }
      for (const raw of logs) {
        if (list(record(raw).attributes).length > MAX_OTEL_ATTRIBUTES || approxJsonBytes(raw, MAX_OTEL_RECORD_BYTES) > MAX_OTEL_RECORD_BYTES) {
          out.tooLarge++;
          continue;
        }
        const kept = filterLog(record(raw), secrets, now);
        if (kept === "ignored") out.ignored++;
        else if (kept === "malformed") out.malformed++;
        else out.records.push(kept);
      }
    }
  }
  return out;
}

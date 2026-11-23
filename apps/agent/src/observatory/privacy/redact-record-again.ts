// The agent's second pass over a record from the hook spool. The hook
// process redacts by pattern only (it never opens the key store) and keeps
// the redacted window of each content value; the agent holds the machine's
// secret values (mcp/redact.ts remembers the sign-in secrets, Advisor's key,
// the machine secret and the OTLP tokens once loaded; the caller passes them
// too) and hides them in every string of the record, then cuts content to
// its stored size (content-excerpt.ts finalExcerpt). Cutting only after this
// pass is what keeps a machine secret near the 2 KB mark from being stored
// in part.
import { redact } from "../../mcp/redact.ts";
import { finalExcerpt } from "./content-excerpt.ts";
import type { FilteredRecord, HookFieldValue } from "./filtered-record.ts";

function again(value: HookFieldValue, known: readonly string[]): HookFieldValue {
  if (typeof value === "string") return redact(value, known);
  return Array.isArray(value) ? value.map((x: string) => redact(x, known)) : value;
}

/** `record` with `known` values (and the process's remembered secrets) hidden in every string, content cut to its stored size. */
export function redactRecordAgain(record: FilteredRecord, known: Iterable<string>): FilteredRecord {
  const secrets = [...known].filter((s) => s.length > 0);
  if (record.src === "otel") {
    const f = Object.fromEntries(Object.entries(record.f).map(([k, v]) => [k, typeof v === "string" ? redact(v, secrets) : v]));
    return { ...record, f };
  }
  const f = Object.fromEntries(Object.entries(record.f).map(([k, v]) => [k, again(v, secrets)]));
  if (record.c === undefined) return { ...record, f };
  const cut = record.truncated ?? {};
  const c = Object.fromEntries(Object.entries(record.c).map(([k, v]) => [k, finalExcerpt({ text: v, truncated: cut[k] === true }, secrets)]));
  // Cut to its stored size now: the flag has done its work.
  const { truncated: _done, ...rest } = record;
  return { ...rest, f, c };
}

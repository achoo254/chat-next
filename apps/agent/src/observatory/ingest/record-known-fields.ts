// The field names the normalizer knows for each event: the privacy filter's
// allowlists (privacy/hook-allowlist.ts, privacy/otel-allowlist.ts) plus the
// fields the filter derives (a tool's target and sizes, the git operation of
// a commit, the prompt's length, the project key, the Live Map station) and, from a source inside
// the agent only, the internal label of a session. Content fields live in
// `c`, not here. Any other name in a record is counted and logged as unknown.
import { COMMON_HOOK_FIELDS, DERIVED_HOOK_FIELDS, HOOK_EVENT_FIELDS } from "../privacy/hook-allowlist.ts";
import { COMMON_OTEL_FIELDS, OTEL_EVENT_FIELDS } from "../privacy/otel-allowlist.ts";

/** A field a source inside the agent adds (an Advisor session's records): the session's internal label. */
export const INTERNAL_LABEL_FIELD = "internal_label";

function nonContent(fields: Readonly<Record<string, string>>): string[] {
  return Object.entries(fields)
    .filter(([, rule]) => rule !== "content")
    .map(([name]) => name);
}

const hookKnown = new Map<string, ReadonlySet<string>>();
const hookKnownFromAgent = new Map<string, ReadonlySet<string>>();
for (const [event, own] of Object.entries(HOOK_EVENT_FIELDS)) {
  const names = [...nonContent(COMMON_HOOK_FIELDS), ...nonContent(own), ...Object.keys(DERIVED_HOOK_FIELDS)];
  hookKnown.set(event, new Set(names));
  hookKnownFromAgent.set(event, new Set([...names, INTERNAL_LABEL_FIELD]));
}

const otelKnown = new Map<string, ReadonlySet<string>>();
for (const [event, own] of Object.entries(OTEL_EVENT_FIELDS)) otelKnown.set(event, new Set([...Object.keys(COMMON_OTEL_FIELDS), ...Object.keys(own)]));

/** The fields of hook `event` the normalizer reads (the internal label too when `fromAgent`); undefined for an event it does not know. */
export function knownHookFields(event: string, fromAgent: boolean): ReadonlySet<string> | undefined {
  return (fromAgent ? hookKnownFromAgent : hookKnown).get(event);
}

/** The attributes of OpenTelemetry `event` the normalizer reads; undefined for an event it does not know. */
export function knownOtelFields(event: string): ReadonlySet<string> | undefined {
  return otelKnown.get(event);
}

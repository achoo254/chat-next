// How Observatory's entries in a Claude Code settings.json are recognised,
// and what they hold (the editing is settings-json-observatory.ts):
// - one hook group per observed event, in exec form (`command` + `args`, no
//   shell) and `async`, recognised by its arguments ending in
//   `observatory hook <event>` (OBSERVATORY_HOOK_ARGS): that is the marker,
//   so no key Claude Code does not know is ever written;
// - the OTel environment for the agent's receiver, marked by
//   TUNELO_OBSERVATORY_ENV_MARKER in the same `env`. A key counts as
//   Observatory's only with the marker there and a value of the shape
//   Observatory writes, so a value the user changed stays theirs.
// Read by the sessions tunelo opens (session-observer.ts, the terminal's
// hooks) as well as by the install.

/** The hook events whose records Observatory keeps (privacy/hook-allowlist.ts), in the order the groups are written. */
export const OBSERVED_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionRequest",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "InstructionsLoaded",
  "PreCompact",
  "PostCompact",
  "Notification",
] as const;

/** The arguments every Observatory hook ends with, before its event. */
export const OBSERVATORY_HOOK_ARGS = ["observatory", "hook"] as const;

/** The env key marking the OTel keys Observatory wrote (its value names it). */
export const TUNELO_OBSERVATORY_ENV_MARKER = "TUNELO_OBSERVATORY";
/** The marker's value. */
export const TUNELO_OBSERVATORY_MARKER_VALUE = "otel";

/** The OTel keys Observatory writes, each with the shape of value it writes. */
const OBSERVATORY_ENV_SHAPES: Readonly<Record<string, RegExp>> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: /^1$/,
  OTEL_LOGS_EXPORTER: /^otlp$/,
  OTEL_EXPORTER_OTLP_PROTOCOL: /^http\/json$/,
  OTEL_EXPORTER_OTLP_ENDPOINT: /^http:\/\/127\.0\.0\.1:\d{1,5}$/,
  OTEL_EXPORTER_OTLP_HEADERS: /^Authorization=Bearer [0-9a-f]{16,128}$/,
};

/** The environment a Claude Code session needs to send its logs to the agent's receiver (no metrics, no content flags). */
export function observatoryOtelEnv(client: { port: number; token: string }): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    // The receiver accepts exactly this Host (receiver/request-guard.ts), and JSON only.
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${client.port}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${client.token}`,
  };
}

/** An OpenTelemetry variable of Claude Code: what turns telemetry on or points it somewhere. */
export const isOtelKey = (key: string): boolean => key.startsWith("OTEL_") || key === "CLAUDE_CODE_ENABLE_TELEMETRY";

export type HookGroup = { hooks: { type: "command"; command: string; args: string[]; async: true }[] };

/** The group running `argv` (tunelo, then the arguments before `observatory hook`) for `event`. */
export function observatoryHookGroup(argv: readonly string[], event: string): HookGroup {
  const [command, ...before] = argv;
  if (command === undefined) throw new Error("no command for the Observatory hook");
  return { hooks: [{ type: "command", command, args: [...before, ...OBSERVATORY_HOOK_ARGS, event], async: true }] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A hook group Observatory wrote: every hook in it runs `… observatory hook <event>`. */
export function isObservatoryHookGroup(group: unknown): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) return false;
  return group.hooks.every((h: unknown) => {
    if (!isRecord(h) || !Array.isArray(h.args)) return false;
    const args: unknown[] = h.args;
    const n = args.length;
    return n >= 3 && args[n - 3] === OBSERVATORY_HOOK_ARGS[0] && args[n - 2] === OBSERVATORY_HOOK_ARGS[1];
  });
}

/** The parsed settings, or undefined for text that is not a JSON object. */
export function parseSettings(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined || text.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(stripBom(text));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** How many Observatory hook groups the settings hold, per event. */
export function observatoryHookCounts(settings: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const n = groups.filter(isObservatoryHookGroup).length;
    if (n > 0) out[event] = n;
  }
  return out;
}

export function hasObservatoryHooks(settings: Record<string, unknown>): boolean {
  return Object.keys(observatoryHookCounts(settings)).length > 0;
}

/** The OTel keys of `env` Observatory wrote (with its marker, of its shape). */
export function observatoryEnvKeys(env: unknown): string[] {
  if (!isRecord(env) || env[TUNELO_OBSERVATORY_ENV_MARKER] !== TUNELO_OBSERVATORY_MARKER_VALUE) return [];
  return Object.entries(OBSERVATORY_ENV_SHAPES).flatMap(([key, shape]) => (typeof env[key] === "string" && shape.test(env[key]) ? [key] : []));
}

/** The OTel keys of the user's own in the settings' `env`: any OTel key Observatory did not write. */
export function userOtelKeys(settings: Record<string, unknown>): string[] {
  const env = settings.env;
  if (!isRecord(env)) return [];
  const ours = new Set(observatoryEnvKeys(env));
  return Object.keys(env).filter((k) => isOtelKey(k) && !ours.has(k));
}

const BOM = "\uFEFF";
const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

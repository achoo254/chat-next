// One hook payload (stdin of `tunelo observatory hook`, or an SDK hook
// callback's input) reduced to a filtered record by the allowlist of
// hook-allowlist.ts. Pure and synchronous: no store, no key store, no
// network, so it runs in the short-lived hook process as well as in the
// agent. Its cost does not grow with the payload: content is read only as
// far as privacy-text.ts reads it.
import { redact } from "../../mcp/redact.ts";
import type { FilteredHookRecord, HookFieldValue } from "./filtered-record.ts";
import { FILTERED_RECORD_VERSION } from "./filtered-record.ts";
import { COMMON_HOOK_FIELDS, type FieldRule, HOOK_EVENT_FIELDS, TOOL_EVENTS, isKeptHookEvent } from "./hook-allowlist.ts";
import { type PathContext, baseName, idValue, keptPath, labelValue } from "./privacy-labels.ts";
import { hideAccountNames, hideHomePaths } from "./home-and-account.ts";
import { finalExcerpt, windowExcerpt } from "./content-excerpt.ts";
import { REDACT_WINDOW_CHARS, approxJsonBytes, boundedJson } from "./privacy-text.ts";
import { toolTarget } from "./tool-target.ts";

export type HookFilterContext = {
  home: string;
  isSensitive: (absolutePath: string) => boolean;
  /** The session's project stores content (content_settings, or the hook's state.json). */
  contentAllowed: boolean;
  /** Secret values to hide besides the patterns (the agent passes the machine's; the hook process has none). */
  known?: Iterable<string>;
  /**
   * hook (the default): content keeps the redacted window for the agent's
   * second pass (content-excerpt.ts); final: both passes, content cut to
   * 2 KB (a source inside the agent).
   */
  stage?: "hook" | "final";
  /** Account names hidden in content (home-and-account.ts machineAccountNames); the home folder's name by default. */
  accountNames?: readonly string[];
  /** The project key of the session's real `cwd` (usage/repo-key.ts), worked out before `cwd` is shortened. */
  projectKey?: string | undefined;
};

/** Ids of one PostToolBatch kept at most. */
const MAX_BATCH_IDS = 100;
const SHA = /^[0-9a-f]{7,64}$/i;

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A label as kept: secrets hidden, the home folder as `~` (never the account name: a branch `dev` stays `dev`). */
const cleanText = (text: string, known: Iterable<string>, home: string): string => hideHomePaths(redact(text, known), home);

function keptField(rule: Exclude<FieldRule, "content">, value: unknown, path: PathContext, known: Iterable<string>): HookFieldValue | undefined {
  switch (rule) {
    case "id":
      return idValue(value);
    case "label": {
      const label = labelValue(value);
      return label === undefined ? undefined : cleanText(label, known, path.home);
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "path":
      return keptPath(value, path);
  }
}

/** The commit a `git commit` call made, from `tool_response.gitOperation` (`{ commit: { sha, kind, branch } }`). */
function gitFields(response: unknown, known: Iterable<string>, home: string): Record<string, string> {
  const operations = record(record(response).gitOperation);
  for (const [name, detail] of Object.entries(operations)) {
    const d = record(detail);
    const out: Record<string, string> = {};
    const op = labelValue(name, 40);
    if (op) out.git_op = op;
    if (typeof d.sha === "string" && SHA.test(d.sha)) out.git_sha = d.sha.toLowerCase();
    const kind = labelValue(d.kind, 40);
    if (kind) out.git_kind = kind;
    const branch = labelValue(d.branch);
    if (branch) out.git_branch = cleanText(branch, known, home);
    return out;
  }
  return {};
}

function batchIds(calls: unknown): string[] {
  if (!Array.isArray(calls)) return [];
  const ids: string[] = [];
  for (let i = 0; i < calls.length && ids.length < MAX_BATCH_IDS; i++) {
    const id = idValue(record(calls[i]).tool_use_id);
    if (id) ids.push(id);
  }
  return ids;
}

/** `payload` of hook `event` as a filtered record at `at` (Unix ms); undefined for an event not kept or a payload that is no object. */
export function filterHookEvent(event: string, payload: unknown, ctx: HookFilterContext, at: number): FilteredHookRecord | undefined {
  if (!isKeptHookEvent(event) || typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const input = payload as Record<string, unknown>;
  const known = [...(ctx.known ?? [])];
  const path: PathContext = { home: ctx.home, cwd: typeof input.cwd === "string" ? input.cwd : undefined, isSensitive: ctx.isSensitive };
  const f: Record<string, HookFieldValue> = {};
  const c: Record<string, string> = {};

  let secret = false;
  if (TOOL_EVENTS.has(event) && typeof input.tool_name === "string") {
    const t = toolTarget(input.tool_name, input.tool_input, path);
    secret = t.secret;
    if (t.target) f.target = cleanText(t.target, known, ctx.home);
    if (input.tool_input !== undefined) f.input_bytes = approxJsonBytes(input.tool_input);
  }
  if (event === "PostToolUse" && input.tool_response !== undefined) {
    f.output_bytes = approxJsonBytes(input.tool_response);
    Object.assign(f, gitFields(input.tool_response, known, ctx.home));
  }
  if (event === "PostToolBatch") f.tool_use_ids = batchIds(input.tool_calls);
  if (event === "UserPromptSubmit" && typeof input.prompt === "string") f.prompt_length = input.prompt.length;
  if (ctx.projectKey) f.project_key = ctx.projectKey;

  const truncated: Record<string, boolean> = {};
  const names = ctx.accountNames ?? [baseName(ctx.home)];
  const hide = (t: string): string => hideAccountNames(hideHomePaths(t, ctx.home), names);

  const rules: Record<string, FieldRule> = { ...COMMON_HOOK_FIELDS, ...HOOK_EVENT_FIELDS[event] };
  for (const [key, rule] of Object.entries(rules)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (rule !== "content") {
      const kept = keptField(rule, value, path, known);
      if (kept !== undefined) f[key] = kept;
      continue;
    }
    if (!ctx.contentAllowed || secret) continue;
    // One character past the window, so the window pass sees that the value went on.
    const windowed = windowExcerpt(boundedJson(value, REDACT_WINDOW_CHARS + 1), known, hide);
    const text = ctx.stage === "final" ? finalExcerpt(windowed, known, hide) : windowed.text;
    if (text === "") continue;
    c[key] = text;
    if (ctx.stage !== "final" && windowed.truncated) truncated[key] = true;
  }
  return {
    v: FILTERED_RECORD_VERSION,
    src: "hook",
    event,
    at,
    f,
    ...(Object.keys(c).length > 0 ? { c } : {}),
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
  };
}

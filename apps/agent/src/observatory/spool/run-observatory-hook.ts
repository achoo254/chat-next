// What `tunelo observatory hook <event>` does, as a function the command
// calls (the command and its fast path come later): read the hook payload
// from stdin, check state.json (and read the target key salt beside it), filter (privacy/filter-hook-event.ts),
// append one line to the spool, done. No network, no store, no waiting for
// the agent. Whatever happens it resolves (never rejects), and within
// HOOK_DEADLINE_MS: Claude Code does not kill an async hook before the
// session ends, so a hook stuck on stdin or on a slow disk would pile up.
// The command exits right after this resolves, which ends a stdin read
// still pending.
import { filterHookEvent } from "../privacy/filter-hook-event.ts";
import { isKeptHookEvent } from "../privacy/hook-allowlist.ts";
import { readTargetKeySalt } from "../privacy/target-key-salt.ts";
import { contentAllowed, readHookState } from "./hook-state-file.ts";
import { appendSpoolLine, countDropped } from "./spool-append.ts";
import { HOOK_DEADLINE_MS } from "./spool-files.ts";

/** A hook payload larger than this is dropped and counted (a tool result of a few MB fits). */
export const MAX_HOOK_STDIN_BYTES = 32 * 1024 * 1024;

export type ObservatoryHookDeps = {
  /** The payload Claude Code writes (process.stdin). */
  stdin: AsyncIterable<Buffer | string>;
  /** The Observatory data folder (state.json, spool/). */
  dataDir: string;
  home: string;
  isSensitive: (absolutePath: string) => boolean;
  /** The project key of a working folder (usage/repo-key.ts), stored with the record and checked against the projects without content. */
  repoKey: (cwd: string) => string;
  /** Account names hidden in content (home-and-account.ts machineAccountNames); the home folder's name by default. */
  accountNames?: readonly string[];
  now?: () => number;
  deadlineMs?: number;
  maxStdinBytes?: number;
};

/**
 * written: one line added; off: Observatory is off, nothing read or written;
 * dropped: the spool is full or the payload too large (counted); ignored: an
 * event not kept, or a payload that is not a JSON object; timeout: the
 * deadline passed first (nothing written after it); failed: the spool could
 * not be written.
 */
export type HookOutcome = "written" | "off" | "dropped" | "ignored" | "timeout" | "failed";

async function readStdin(stdin: AsyncIterable<Buffer | string>, max: number, signal: AbortSignal): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    if (signal.aborted) return undefined;
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buf.length;
    if (size > max) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function projectKeyOf(cwd: unknown, repoKey: (cwd: string) => string): string | undefined {
  if (typeof cwd !== "string" || cwd === "") return undefined;
  try {
    return repoKey(cwd);
  } catch {
    return undefined;
  }
}

async function hook(event: string, deps: ObservatoryHookDeps, signal: AbortSignal): Promise<HookOutcome> {
  const now = deps.now ?? Date.now;
  if (!isKeptHookEvent(event)) return "ignored";
  const [state, targetKeySalt] = await Promise.all([readHookState(deps.dataDir), readTargetKeySalt(deps.dataDir)]);
  if (!state.enabled) return "off";
  const text = await readStdin(deps.stdin, deps.maxStdinBytes ?? MAX_HOOK_STDIN_BYTES, signal);
  if (signal.aborted) return "timeout";
  if (text === undefined) {
    await countDropped(deps.dataDir, now());
    return "dropped";
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return "ignored";
  }
  const cwd = typeof payload === "object" && payload !== null ? (payload as { cwd?: unknown }).cwd : undefined;
  const projectKey = projectKeyOf(cwd, deps.repoKey);
  const record = filterHookEvent(
    event,
    payload,
    {
      home: deps.home,
      isSensitive: deps.isSensitive,
      contentAllowed: contentAllowed(state, projectKey),
      projectKey,
      targetKeySalt,
      ...(deps.accountNames ? { accountNames: deps.accountNames } : {}),
    },
    now(),
  );
  if (record === undefined) return "ignored";
  if (signal.aborted) return "timeout";
  return appendSpoolLine(deps.dataDir, JSON.stringify(record), now());
}

/** Runs the hook for `event` (see the module comment); resolves within the deadline, never rejects. */
export async function runObservatoryHook(event: string, deps: ObservatoryHookDeps): Promise<HookOutcome> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<HookOutcome>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve("timeout");
    }, deps.deadlineMs ?? HOOK_DEADLINE_MS);
  });
  try {
    return await Promise.race([hook(event, deps, abort.signal).catch((): HookOutcome => "failed"), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

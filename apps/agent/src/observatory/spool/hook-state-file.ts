// `<observatory data>/state.json`: what a hook process needs to know of the
// agent's settings without opening SQLite. A copy derived from the agent's
// config (config.ts `observatory`), which is the source of truth: written
// only by the agent, one write at a time (hook-state-writer.ts), each
// through a temp file of its own renamed into place (0600); read by every
// hook. A hook finding Observatory off exits without writing anything.
//
// Missing file: Observatory is on (its default) and every project keeps
// content. A file that cannot be read as state: on, but no content kept for
// any project, since the list of projects without content is unknown. The
// agent moves such a file aside (`state.json.corrupt-<time>`) before it
// writes the state again from its config.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOOK_STATE_FILE } from "./spool-files.ts";

export type HookState = {
  enabled: boolean;
  /** Project keys (usage/repo-key.ts) whose content is not stored. */
  contentOff: readonly string[];
  /** The file could not be read: no project's content is kept. */
  unreadable: boolean;
};

const MAX_STATE_BYTES = 1024 * 1024;

export function hookStatePath(dataDir: string): string {
  return join(dataDir, HOOK_STATE_FILE);
}

function parseState(text: string): HookState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { enabled, contentOff } = value as { enabled?: unknown; contentOff?: unknown };
  if (typeof enabled !== "boolean" || !Array.isArray(contentOff) || !contentOff.every((k) => typeof k === "string")) return undefined;
  return { enabled, contentOff: contentOff as string[], unreadable: false };
}

/** The state the agent last wrote under `dataDir` (see the module comment for a missing or broken file). */
export async function readHookState(dataDir: string): Promise<HookState> {
  let text: string;
  try {
    text = await readFile(hookStatePath(dataDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true, contentOff: [], unreadable: false };
    return { enabled: true, contentOff: [], unreadable: true };
  }
  if (text.length > MAX_STATE_BYTES) return { enabled: true, contentOff: [], unreadable: true };
  return parseState(text) ?? { enabled: true, contentOff: [], unreadable: true };
}

/** Whether a session in project `projectKey` keeps its content under `state`. */
export function contentAllowed(state: HookState, projectKey: string | undefined): boolean {
  if (state.unreadable) return false;
  if (state.contentOff.length === 0) return true;
  return projectKey !== undefined && !state.contentOff.includes(projectKey);
}

/**
 * Moves a state.json that exists but is not state aside as
 * `state.json.corrupt-<now>`, for a look later; true when it did. A file
 * that cannot be read now (locked) stays: the next write replaces it.
 */
export async function setAsideBrokenHookState(dataDir: string, now: number): Promise<boolean> {
  const file = hookStatePath(dataDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  if (text.length <= MAX_STATE_BYTES && parseState(text)) return false;
  await rename(file, `${file}.corrupt-${now}`);
  return true;
}

/** Each write has a temp file of its own, so two writes never mix. */
let writes = 0;

/** Writes the state for the hooks (agent only, one at a time): the whole file replaced at once, 0600. */
export async function writeHookState(dataDir: string, state: { enabled: boolean; contentOff: readonly string[] }): Promise<void> {
  const file = hookStatePath(dataDir);
  const tmp = `${file}.${process.pid}.${++writes}.tmp`;
  const body = JSON.stringify({ enabled: state.enabled, contentOff: [...new Set(state.contentOff)].sort() });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    // Inside the try: a write cut short (a full disk) leaves no temp file behind.
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    // A hook reading the file at that moment can make Windows refuse the rename for a few milliseconds.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

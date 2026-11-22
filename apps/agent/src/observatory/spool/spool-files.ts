// The files of the hook spool, in `<observatory data>/spool/`: one file of
// events per minute (`events-<minute>.jsonl`, a minute being Unix ms / 60 000),
// appended to by every hook process of that minute (appending lines from
// several processes is safe on Windows too), and one file per hour counting
// events the hooks dropped (`dropped-<first minute of the hour>.log`, one
// line each). The agent
// reads a minute's files only once the minute is over and the hooks' hard
// deadline has passed too, then deletes them: on Windows a write to a file
// already deleted is lost without an error. Nothing renames or truncates a
// file a hook may still write.
//
// No import beyond node: hook processes and tests' child processes load this.
import { join } from "node:path";

export const SPOOL_DIR = "spool";
/** The agent's small file telling the hooks whether Observatory runs and which projects keep no content. */
export const HOOK_STATE_FILE = "state.json";
/** Where the agent is in the file it reads (spool-reader.ts). */
export const SPOOL_CURSOR_FILE = "cursor.json";
/** Records the ingest kept refusing (spool-quarantine.ts). */
export const SPOOL_QUARANTINE_FILE = "quarantine.jsonl";

/** The hook process gives up after this long (it is never killed by Claude Code mid-session). */
export const HOOK_DEADLINE_MS = 2_000;
/** A minute's files are read once this long has passed after the minute ended (well past HOOK_DEADLINE_MS). */
export const SPOOL_GRACE_MS = 5_000;
/** The spool's events stop growing at this size; later events are dropped and counted. */
export const SPOOL_MAX_BYTES = 50 * 1024 * 1024;
/** …or at this many files, dropped counts included (the hook adds up their sizes, so this bounds its work). */
export const SPOOL_MAX_FILES = 2_000;
/** Longest line kept (a filtered record is a few KB: content is cut to 2 KB a field). */
export const SPOOL_MAX_LINE_BYTES = 256 * 1024;

const MINUTE_MS = 60_000;
const NAME = /^(events|dropped)-(\d{1,12})\.(jsonl|log)$/;

export type SpoolFileKind = "events" | "dropped";

export function minuteOf(ms: number): number {
  return Math.floor(ms / MINUTE_MS);
}

export function spoolFileName(kind: SpoolFileKind, minute: number): string {
  return kind === "events" ? `events-${minute}.jsonl` : `dropped-${minute}.log`;
}

/** The minute naming the `dropped-` file that counts drops of `minute`: the first minute of its hour. */
export function droppedFileMinute(minute: number): number {
  return minute - (minute % 60);
}

export function spoolFilePath(dataDir: string, kind: SpoolFileKind, minute: number): string {
  return join(dataDir, SPOOL_DIR, spoolFileName(kind, minute));
}

/** The kind and minute of a spool file's name; undefined for any other file. */
export function parseSpoolFileName(name: string): { kind: SpoolFileKind; minute: number } | undefined {
  const m = NAME.exec(name);
  if (!m?.[1] || !m[2]) return undefined;
  const kind = m[1] === "events" ? "events" : "dropped";
  if ((kind === "events") !== (m[3] === "jsonl")) return undefined;
  return { kind, minute: Number(m[2]) };
}

/** A minute's files may be read and deleted at `now`: the minute is over and no hook of it can still be writing. */
export function minuteSettled(minute: number, now: number, graceMs: number = SPOOL_GRACE_MS): boolean {
  return (minute + 1) * MINUTE_MS + graceMs <= now;
}

/** A spool file may be read and deleted at `now`: an events file once its minute settled, a dropped file once its hour did. */
export function spoolFileSettled(kind: SpoolFileKind, minute: number, now: number, graceMs: number = SPOOL_GRACE_MS): boolean {
  return minuteSettled(kind === "events" ? minute : minute + 59, now, graceMs);
}

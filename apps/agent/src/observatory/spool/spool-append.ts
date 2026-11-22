// A hook process adding its one line to the spool (spool-files.ts): into the
// file of the current minute, created 0600 in a 0700 folder, unless the spool
// is full (SPOOL_MAX_BYTES or SPOOL_MAX_FILES), in which case the line is
// dropped and counted in the minute's `dropped-` file. Never throws: a hook
// must not fail Claude Code.
//
// No import beyond node and spool-files.ts: tests run this in plain child
// processes.
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SPOOL_DIR, SPOOL_MAX_BYTES, SPOOL_MAX_FILES, SPOOL_MAX_LINE_BYTES, droppedFileMinute, minuteOf, parseSpoolFileName, spoolFileName } from "./spool-files.ts";

export type SpoolLimits = { maxBytes: number; maxFiles: number; maxLineBytes: number };

export const DEFAULT_SPOOL_LIMITS: SpoolLimits = { maxBytes: SPOOL_MAX_BYTES, maxFiles: SPOOL_MAX_FILES, maxLineBytes: SPOOL_MAX_LINE_BYTES };

/** What became of a line: written, dropped and counted (spool full, line too long), or lost (the spool could not be written at all). */
export type AppendOutcome = "written" | "dropped" | "failed";

/** Whether `adding` more bytes keeps the events files within the limits (counting stops once past them). */
async function eventsUsage(dir: string, limits: SpoolLimits, adding: number): Promise<"room" | "full"> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return "room"; // no spool folder yet
  }
  const spooled = names.filter((n) => parseSpoolFileName(n) !== undefined);
  if (spooled.length >= limits.maxFiles) return "full";
  const events = spooled.filter((n) => parseSpoolFileName(n)?.kind === "events");
  let bytes = adding;
  for (const name of events) {
    try {
      bytes += (await stat(join(dir, name))).size;
    } catch {
      // read and deleted by the agent meanwhile
    }
    if (bytes > limits.maxBytes) return "full";
  }
  return "room";
}

/** Counts one dropped line in the hour's `dropped-` file (one file an hour, so a long full spool adds few files). */
export async function countDropped(dataDir: string, now: number): Promise<void> {
  const dir = join(dataDir, SPOOL_DIR);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, spoolFileName("dropped", droppedFileMinute(minuteOf(now)))), "1\n", { mode: 0o600 });
  } catch {
    // nothing more a hook can do
  }
}

/** Appends `line` (one JSON record, no newline) to the spool under `dataDir` at `now`. */
export async function appendSpoolLine(dataDir: string, line: string, now: number, limits: SpoolLimits = DEFAULT_SPOOL_LIMITS): Promise<AppendOutcome> {
  const dir = join(dataDir, SPOOL_DIR);
  const bytes = Buffer.byteLength(line, "utf8") + 1;
  if (bytes > limits.maxLineBytes || line.includes("\n") || (await eventsUsage(dir, limits, bytes)) === "full") {
    await countDropped(dataDir, now);
    return "dropped";
  }
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // One write of the whole line: lines of concurrent hooks never interleave.
    await appendFile(join(dir, spoolFileName("events", minuteOf(now))), `${line}\n`, { mode: 0o600 });
    return "written";
  } catch {
    return "failed";
  }
}

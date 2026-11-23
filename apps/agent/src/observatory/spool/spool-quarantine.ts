// Where the spool reader puts a record the ingest kept refusing
// (SPOOL_MAX_ATTEMPTS runs in a row), so one bad record never holds every
// file after it: `spool/quarantine.jsonl` (0600), kept for a look and
// deleted with the rest of the data on a wipe. It has a size cap of its own;
// past it a quarantined line is dropped and only counted. Its name is no
// spool file name (spool-files.ts), so neither the hooks' cap nor the reader
// ever counts or reads it.
//
// It is as private as the store: a line is the record as the ingest got it,
// after the agent's second pass (the machine's secrets hidden, content cut to
// its stored size), never the spool line itself, with the time it was set
// aside (`quarantinedAt`). A line is kept QUARANTINE_KEEP_MS, then deleted;
// a line without that time (written by an older agent, the raw spool line)
// is deleted at the next pass.
//
// The position in the file being read and the tries of each refused line
// (by a hash of the spool line, so a restart keeps counting) are kept in
// cursor.json.
import { createHash } from "node:crypto";
import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FilteredRecord } from "../privacy/filtered-record.ts";
import { SPOOL_CURSOR_FILE, SPOOL_QUARANTINE_FILE } from "./spool-files.ts";

/** Runs a refused record is tried in before it is set aside. */
export const SPOOL_MAX_ATTEMPTS = 3;
/** The quarantine file stops growing at this size. */
export const SPOOL_QUARANTINE_MAX_BYTES = 5 * 1024 * 1024;
/** A quarantined record is deleted this long after it was set aside. */
export const QUARANTINE_KEEP_MS = 7 * 24 * 60 * 60_000;
/** The file the quarantine is rewritten through when old lines go (deleted with the spool on a wipe). */
export const SPOOL_QUARANTINE_TEMP_FILE = `${SPOOL_QUARANTINE_FILE}.tmp`;

export type SpoolCursor = { file: string; offset: number; attempts: Record<string, number> };

/** A record the ingest refused: the hash of its spool line, and the record as the ingest got it. */
export type RefusedRecord = { key: string; record: FilteredRecord };

/** A short hash of a spool line, to count its tries. */
export function lineKey(line: Buffer): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 16);
}

/** Appends `record` (set aside at `at`) to the quarantine file under `spoolDir`; false (nothing written) when the file is at its cap. */
export async function quarantineRecord(spoolDir: string, record: FilteredRecord, at: number, maxBytes: number = SPOOL_QUARANTINE_MAX_BYTES): Promise<boolean> {
  const file = join(spoolDir, SPOOL_QUARANTINE_FILE);
  const line = Buffer.from(`${JSON.stringify({ quarantinedAt: at, ...record })}\n`);
  const size = await stat(file).then((s) => s.size, () => 0);
  if (size + line.length > maxBytes) return false;
  await appendFile(file, line, { mode: 0o600 });
  return true;
}

/**
 * Counts a try for each refused record in `attempts`; one refused
 * SPOOL_MAX_ATTEMPTS times goes to the quarantine file (or, past its cap, is
 * dropped). `waiting`: some record is still to be tried again.
 */
export async function setAsideRefused(
  spoolDir: string,
  refused: readonly RefusedRecord[],
  attempts: Record<string, number>,
  at: number,
  maxBytes: number = SPOOL_QUARANTINE_MAX_BYTES,
): Promise<{ waiting: boolean; quarantined: number; dropped: number }> {
  const out = { waiting: false, quarantined: 0, dropped: 0 };
  for (const { key, record } of refused) {
    const tries = (attempts[key] ?? 0) + 1;
    attempts[key] = tries;
    if (tries < SPOOL_MAX_ATTEMPTS) out.waiting = true;
    else if (await quarantineRecord(spoolDir, record, at, maxBytes)) out.quarantined++;
    else out.dropped++;
  }
  return out;
}

function keptUntil(line: string, cutoff: number): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && "quarantinedAt" in value && typeof value.quarantinedAt === "number" && value.quarantinedAt >= cutoff;
  } catch {
    return false;
  }
}

/** Deletes quarantined lines set aside before `now` − QUARANTINE_KEEP_MS (and lines without that time); the file goes when none is left. */
export async function pruneQuarantine(spoolDir: string, now: number): Promise<void> {
  const file = join(spoolDir, SPOOL_QUARANTINE_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return; // nothing set aside
  }
  const lines = text.split("\n").filter((l) => l !== "");
  const kept = lines.filter((l) => keptUntil(l, now - QUARANTINE_KEEP_MS));
  if (kept.length === lines.length) return;
  if (kept.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const temp = join(spoolDir, SPOOL_QUARANTINE_TEMP_FILE);
  await writeFile(temp, `${kept.join("\n")}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/** The saved cursor; undefined when there is none or it is broken (the file is then read from its start: the store ignores a duplicate). */
export async function readSpoolCursor(spoolDir: string): Promise<SpoolCursor | undefined> {
  try {
    const value = JSON.parse(await readFile(join(spoolDir, SPOOL_CURSOR_FILE), "utf8")) as { file?: unknown; offset?: unknown; attempts?: unknown };
    if (typeof value.file !== "string" || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) return undefined;
    const attempts: Record<string, number> = {};
    if (typeof value.attempts === "object" && value.attempts !== null) {
      for (const [k, n] of Object.entries(value.attempts)) if (typeof n === "number" && Number.isSafeInteger(n)) attempts[k] = n;
    }
    return { file: value.file, offset: value.offset, attempts };
  } catch {
    return undefined;
  }
}

export async function writeSpoolCursor(spoolDir: string, cursor: SpoolCursor): Promise<void> {
  await writeFile(join(spoolDir, SPOOL_CURSOR_FILE), JSON.stringify(cursor), { mode: 0o600 });
}

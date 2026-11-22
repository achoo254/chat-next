// Where the spool reader puts a record the ingest kept refusing
// (SPOOL_MAX_ATTEMPTS runs in a row), so one bad record never holds every
// file after it: `spool/quarantine.jsonl` (0600), kept for a look and
// deleted with the rest of the data on a wipe. It has a size cap of its own;
// past it a quarantined line is dropped and only counted. Its name is no
// spool file name (spool-files.ts), so neither the hooks' cap nor the reader
// ever counts or reads it.
//
// The position in the file being read and the tries of each refused line
// (by a hash of the line, so a restart keeps counting) are kept in
// cursor.json.
import { createHash } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPOOL_CURSOR_FILE, SPOOL_QUARANTINE_FILE } from "./spool-files.ts";

/** Runs a refused record is tried in before it is set aside. */
export const SPOOL_MAX_ATTEMPTS = 3;
/** The quarantine file stops growing at this size. */
export const SPOOL_QUARANTINE_MAX_BYTES = 5 * 1024 * 1024;

export type SpoolCursor = { file: string; offset: number; attempts: Record<string, number> };

/** A short hash of a spool line, to count its tries. */
export function lineKey(line: Buffer): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 16);
}

/** Appends `line` to the quarantine file under `spoolDir`; false (nothing written) when the file is at its cap. */
export async function quarantineLine(spoolDir: string, line: Buffer, maxBytes: number = SPOOL_QUARANTINE_MAX_BYTES): Promise<boolean> {
  const file = join(spoolDir, SPOOL_QUARANTINE_FILE);
  const size = await stat(file).then((s) => s.size, () => 0);
  if (size + line.length + 1 > maxBytes) return false;
  await appendFile(file, Buffer.concat([line, Buffer.from("\n")]), { mode: 0o600 });
  return true;
}

/**
 * Counts a try for each refused line in `attempts`; a line refused
 * SPOOL_MAX_ATTEMPTS times goes to the quarantine file (or, past its cap, is
 * dropped). `waiting`: some line is still to be tried again.
 */
export async function setAsideRefused(
  spoolDir: string,
  refused: readonly Buffer[],
  attempts: Record<string, number>,
  maxBytes: number = SPOOL_QUARANTINE_MAX_BYTES,
): Promise<{ waiting: boolean; quarantined: number; dropped: number }> {
  const out = { waiting: false, quarantined: 0, dropped: 0 };
  for (const line of refused) {
    const key = lineKey(line);
    const tries = (attempts[key] ?? 0) + 1;
    attempts[key] = tries;
    if (tries < SPOOL_MAX_ATTEMPTS) out.waiting = true;
    else if (await quarantineLine(spoolDir, line, maxBytes)) out.quarantined++;
    else out.dropped++;
  }
  return out;
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

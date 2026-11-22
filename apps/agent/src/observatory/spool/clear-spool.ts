// Deleting what the spool holds, for a wipe of all Observatory data: every
// events and dropped file, the quarantine file and the reader's cursor. state.json stays (the
// hooks still need it). A hook writing during the wipe may leave a new line
// behind, read later like any other.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SPOOL_CURSOR_FILE, SPOOL_DIR, SPOOL_QUARANTINE_FILE, parseSpoolFileName } from "./spool-files.ts";

/** Deletes the spool's files under `dataDir`; a missing spool is nothing to do. */
export async function clearSpool(dataDir: string): Promise<void> {
  const dir = join(dataDir, SPOOL_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === SPOOL_CURSOR_FILE || name === SPOOL_QUARANTINE_FILE || parseSpoolFileName(name)) await rm(join(dir, name), { force: true, maxRetries: 3 });
  }
}

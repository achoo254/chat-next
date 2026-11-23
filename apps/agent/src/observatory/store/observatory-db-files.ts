// The Observatory database's files on disk: made private before SQLite
// opens them, removed (with SQLite's side files) on wipe. SQLite gives the
// -wal and -shm files the database file's mode, so a 0600 database keeps
// them 0600 too.
import { chmod, mkdir, open as openFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { observatoryDbFiles } from "./observatory-db-path.ts";

/** Creates the folder (0700) and an empty database file (0600) when missing; an existing file keeps its content. */
export async function prepareObservatoryDbFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await openFile(path, "a", 0o600);
  await handle.close();
}

/** Makes an existing database file 0600 and its folder 0700 (made by hand, by an older build, or under another umask). */
export async function restrictObservatoryDbFile(path: string): Promise<void> {
  await chmod(path, 0o600);
  // Windows has no POSIX modes for folders (chmod only toggles read-only).
  if (process.platform !== "win32") await chmod(dirname(path), 0o700);
}

/**
 * Deletes the database files at `path`; its store must be closed. The side
 * files go first and the database last, so a deletion stopped halfway never
 * leaves an old -wal next to a new database. On Windows a file another
 * process has open cannot be deleted (EBUSY/EPERM, thrown); on POSIX it is
 * unlinked while that process keeps writing to it unseen.
 */
export async function deleteObservatoryDb(path: string): Promise<void> {
  const [db, ...side] = observatoryDbFiles(path);
  for (const f of [...side, db]) if (f !== undefined) await rm(f, { force: true, maxRetries: 3 });
}

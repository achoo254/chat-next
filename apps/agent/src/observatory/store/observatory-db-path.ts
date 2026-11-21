// Where the Observatory database lives. It is machine-local data, never
// roaming: on Windows %LOCALAPPDATA%\tunelo\observatory\ (not %APPDATA%,
// which a company machine may keep on a network share); elsewhere next to
// the agent's config (config.ts). TUNELO_HOME, when set, holds everything,
// as it does for the config. The SQLite file comes with its -wal and -shm
// files beside it.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { configDir } from "../../config.ts";

export const OBSERVATORY_DIR = "observatory";
export const OBSERVATORY_DB_FILE = "observatory.db";

export type DbPathInputs = {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The agent's config folder (config.ts configDir()), used outside Windows. */
  configDir: string;
};

/** The path of the Observatory database for `inputs` (this process's by default). */
export function observatoryDbPath(inputs: DbPathInputs = currentDbPathInputs()): string {
  const windows = inputs.platform === "win32";
  const path = windows ? win32 : posix;
  const tuneloHome = inputs.env.TUNELO_HOME;
  let base: string;
  if (tuneloHome) base = tuneloHome;
  else if (windows) base = path.join(inputs.env.LOCALAPPDATA || path.join(inputs.home, "AppData", "Local"), "tunelo");
  else base = inputs.configDir;
  return path.join(base, OBSERVATORY_DIR, OBSERVATORY_DB_FILE);
}

/** The files SQLite keeps for the database at `dbPath`: the file itself, its write-ahead log and shared memory, a rollback journal. */
export function observatoryDbFiles(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

function currentDbPathInputs(): DbPathInputs {
  return { platform: process.platform, env: process.env, home: homedir(), configDir: configDir() };
}

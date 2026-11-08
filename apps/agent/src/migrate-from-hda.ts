// Moves an hda install (the earlier name of tunelo; chat-agent before that)
// to tunelo without losing the machine: the same machine id, secret and key,
// paired devices, tunnel sign-in, subdomain and journals. The steps keep
// exactly one background loop alive the whole time, and each can run again,
// so an interrupted move finishes on the next try:
//   1. Copy (never move) the old config folder and the Keychain entry; the
//      copy must read back before anything else changes.
//   2. Put the binary in its new place and on PATH, register the new
//      supervisor and wait until it answers.
//   3. Write "stop" (ends the old Windows loop) and the marker into the old
//      folder, then let a still running old agent exit.
//   4. Remove the old login entry.
//   5. Unload the old LaunchAgent, last: that can end this very process.
// The old folder and Keychain entry stay, so going back is still possible.
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigStore, legacyConfigDir, tuneloConfigDir } from "./config.ts";
import { callControl } from "./control-socket.ts";
import { copyLegacyMachineKey } from "./keystore.ts";
import { bootoutLegacy, installService, removeLegacyAutostart, stopLegacyAgent } from "./service.ts";

const run = promisify(execFile);

/** Written into the old folder once tunelo runs; from then on `hda run` never starts an agent. */
export const MIGRATED_MARKER = "migrated-to-tunelo";
/** Files that belong to the old process or its supervisor, not to the machine. */
const NOT_COPIED = new Set(["control.json", "stop", MIGRATED_MARKER, "run-agent.cmd", "run-agent.vbs", "agent.log"]);
const START_WAIT_MS = 60_000;
const POLL_MS = 500;

export type MigrationPaths = {
  /** Config folder of hda. */
  legacyDir: string;
  /** Config folder of tunelo. */
  newDir: string;
  /** The binary running now: the hda file the bridge release replaced, or tunelo itself. */
  currentExe: string;
  /** Where tunelo is installed. */
  newExe: string;
  /** Home folder: ~/.tunelo of the old Tunelo CLI, the shell profile. */
  home: string;
};

/** Everything that touches the OS outside the two config folders; tests replace it. */
export type MigrationSystem = {
  copyMachineKey(): Promise<void>;
  addToPath(binDir: string): Promise<void>;
  /** Throws when the binary does not run. */
  checkBinary(exe: string): Promise<void>;
  /** True when an agent answers on the control channel of that folder. */
  isRunning(dir: string): Promise<boolean>;
  installService(dir: string, cmd: string[]): Promise<void>;
  stopLegacyAgent(legacyDir: string): Promise<void>;
  removeLegacyAutostart(): Promise<void>;
  bootoutLegacy(): Promise<void>;
  sleep(ms: number): Promise<void>;
};

type Log = (line: string) => void;

export function migrationPaths(): MigrationPaths {
  const home = homedir();
  const newExe =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "tunelo", "tunelo.exe")
      : join(home, ".local", "bin", "tunelo");
  return { legacyDir: legacyConfigDir(), newDir: tuneloConfigDir(), currentExe: process.execPath, newExe, home };
}

/** The hda files a Windows install leaves behind (the running one, and the one before an update). */
export function legacyBinaries(): string[] {
  if (process.platform !== "win32") return [];
  const dir = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hda");
  return [join(dir, "hda.exe"), join(dir, "hda.exe.old")];
}

export const hasLegacyInstall = (legacyDir: string): boolean => existsSync(join(legacyDir, "config.json"));
export const isMigrated = (legacyDir: string): boolean => existsSync(join(legacyDir, MIGRATED_MARKER));

/** Copies a folder tree: folders 0700, files 0600, links skipped. */
function copyTree(from: string, to: string, top: boolean): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  chmodSync(to, 0o700);
  for (const name of readdirSync(from)) {
    if (top && NOT_COPIED.has(name)) continue;
    if (name.endsWith(".tmp")) continue;
    const src = join(from, name);
    const dst = join(to, name);
    const st = lstatSync(src);
    if (st.isDirectory()) copyTree(src, dst, false);
    else if (st.isFile()) {
      copyFileSync(src, dst);
      chmodSync(dst, 0o600);
    }
  }
}

/**
 * Step 1: copies the old config folder into the new one through a staging
 * folder. config.json lands last, so its presence means the copy finished;
 * a finished copy is never overwritten.
 */
export function copyConfigFolder(legacyDir: string, newDir: string): "copied" | "kept" {
  if (existsSync(join(newDir, "config.json"))) return "kept";
  const staging = `${newDir}.from-hda`;
  rmSync(staging, { recursive: true, force: true });
  copyTree(legacyDir, staging, true);
  if (!existsSync(newDir)) {
    mkdirSync(dirname(newDir), { recursive: true });
    renameSync(staging, newDir);
    return "copied";
  }
  // A folder without config.json (a command ran before the move): fill in what it lacks.
  const names = readdirSync(staging).sort((a, b) => Number(a === "config.json") - Number(b === "config.json"));
  for (const name of names) {
    if (!existsSync(join(newDir, name))) renameSync(join(staging, name), join(newDir, name));
  }
  rmSync(staging, { recursive: true, force: true });
  chmodSync(newDir, 0o700);
  return "copied";
}

/**
 * Takes the tunnel server from the old Tunelo CLI's ~/.tunelo/config.json.
 * Only that setting: its key and session are secrets and stay where they
 * are, and nothing in ~/.tunelo is changed.
 */
export function importCliSettings(home: string, newDir: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(home, ".tunelo", "config.json"), "utf8"));
  } catch {
    return null;
  }
  const server = typeof raw === "object" && raw !== null && "server" in raw ? (raw as { server: unknown }).server : undefined;
  if (typeof server !== "string") return null;
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const config = new ConfigStore(newDir);
  if (config.get().tunnelServer) return null;
  config.update((c) => (c.tunnelServer = url.origin));
  return url.origin;
}

/** Step 2: the binary in its new place, written beside it and renamed so it is never half there. */
export function installBinary(currentExe: string, newExe: string): "copied" | "kept" {
  if (resolve(currentExe) === resolve(newExe) || existsSync(newExe)) return "kept";
  mkdirSync(dirname(newExe), { recursive: true });
  const tmp = `${newExe}.${process.pid}.tmp`;
  copyFileSync(currentExe, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, newExe);
  return "copied";
}

async function waitFor(sys: MigrationSystem, ok: () => Promise<boolean>): Promise<boolean> {
  for (let waited = 0; ; waited += POLL_MS) {
    if (await ok()) return true;
    if (waited >= START_WAIT_MS) return false;
    await sys.sleep(POLL_MS);
  }
}

/** The whole move, steps 1 to 5. Safe to run again after any failure. */
export async function migrateFromHda(paths: MigrationPaths, sys: MigrationSystem, log: Log): Promise<void> {
  const { legacyDir, newDir, newExe } = paths;
  if (resolve(legacyDir) === resolve(newDir)) throw new Error(`hda and tunelo would share ${newDir}; set TUNELO_HOME to another folder`);
  if (!hasLegacyInstall(legacyDir)) throw new Error(`no hda install in ${legacyDir}`);

  log(`copying ${legacyDir} to ${newDir}: ${copyConfigFolder(legacyDir, newDir)}`);
  const server = importCliSettings(paths.home, newDir);
  if (server) log(`tunnel server ${server} taken from the old Tunelo CLI`);
  await sys.copyMachineKey();

  log(`tunelo at ${newExe}: ${installBinary(paths.currentExe, newExe)}`);
  await sys.addToPath(dirname(newExe));
  await sys.checkBinary(newExe);
  if (!(await sys.isRunning(newDir))) {
    await sys.installService(newDir, [newExe, "run"]);
    // An old agent that still answers keeps tunelo waiting; it ends in step 3.
    const up = await waitFor(sys, async () => (await sys.isRunning(newDir)) || (await sys.isRunning(legacyDir)));
    if (!up) throw new Error("tunelo did not start within a minute; hda keeps running as before");
  }

  writeFileSync(join(legacyDir, "stop"), "");
  writeFileSync(join(legacyDir, MIGRATED_MARKER), `${JSON.stringify({ to: newExe, config: newDir, at: new Date().toISOString() })}\n`);
  await sys.stopLegacyAgent(legacyDir);
  log("hda is stopped; tunelo runs from now on");

  await sys.removeLegacyAutostart();
  await sys.bootoutLegacy();
}

/**
 * After the marker: makes sure tunelo runs, then repeats steps 4 and 5 (an
 * earlier run may have stopped before them). Throws, leaving the old login
 * entry so its supervisor tries again, when tunelo does not come up.
 */
export async function finishMigration(paths: MigrationPaths, sys: MigrationSystem, log: Log): Promise<void> {
  const { legacyDir, newDir, newExe } = paths;
  if (!(await sys.isRunning(newDir))) {
    if (!existsSync(newExe)) throw new Error(`tunelo is missing at ${newExe}; run the install command from the web page again`);
    await sys.stopLegacyAgent(legacyDir);
    log("tunelo is not running; starting it");
    await sys.installService(newDir, [newExe, "run"]);
    if (!(await waitFor(sys, () => sys.isRunning(newDir)))) throw new Error("tunelo did not start within a minute");
  }
  await sys.removeLegacyAutostart();
  await sys.bootoutLegacy();
}

/**
 * `hda run`, as the supervisor of hda starts it after the bridge update.
 * Once moved it never starts an agent: it only keeps tunelo running and
 * exits. Before that it moves the install; if the move fails, the agent runs
 * from the old folder as hda did, so the machine stays online.
 */
export async function runAsHda(paths: MigrationPaths, sys: MigrationSystem, log: Log, runLegacyAgent: () => Promise<number>): Promise<number> {
  if (isMigrated(paths.legacyDir)) {
    await finishMigration(paths, sys, log);
    return 0;
  }
  try {
    await migrateFromHda(paths, sys, log);
    return 0;
  } catch (err) {
    log(`could not move to tunelo yet (${(err as Error).message}); running as hda until the next start`);
    return runLegacyAgent();
  }
}

/** Windows: `tunelo start` deletes hda.exe once moved; a file still in use stays until a later start. */
export function removeLegacyBinaries(legacyDir: string, files = legacyBinaries()): void {
  if (!isMigrated(legacyDir)) return;
  for (const file of files) {
    try {
      rmSync(file, { force: true });
    } catch {
      // In use by a process that has not exited yet.
    }
  }
}

/** macOS: the line that puts a bin folder on PATH for new terminals (zsh is the default shell). */
export function addToShellProfile(home: string, binDir: string): void {
  const dir = binDir === join(home, ".local", "bin") ? "$HOME/.local/bin" : binDir;
  const line = `export PATH="${dir}:$PATH"`;
  for (const rc of [join(home, ".zprofile"), join(home, ".bash_profile")]) {
    if (rc.endsWith(".bash_profile") && !existsSync(rc)) continue;
    const text = existsSync(rc) ? readFileSync(rc, "utf8") : "";
    if (!text.includes(line)) appendFileSync(rc, `\n${line}\n`);
  }
}

async function addToUserPath(binDir: string): Promise<void> {
  if (process.platform !== "win32") return addToShellProfile(homedir(), binDir);
  // The user's own PATH (no admin), as the install script sets it.
  const dir = binDir.replace(/'/g, "''");
  const ps = `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains '${dir}')) { [Environment]::SetEnvironmentVariable('Path', $(if ($p) { "$p;${dir}" } else { '${dir}' }), 'User') }`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
}

/** The real OS behind the migration. */
export function osMigrationSystem(): MigrationSystem {
  return {
    copyMachineKey: copyLegacyMachineKey,
    addToPath: addToUserPath,
    async checkBinary(exe) {
      const { stdout } = await run(exe, ["--version"], { timeout: 30_000, windowsHide: true });
      if (!/^\d+\.\d+\.\d+/.test(stdout.trim())) throw new Error(`${exe} --version printed ${JSON.stringify(stdout.trim().slice(0, 80))}`);
    },
    isRunning: (dir) => callControl(dir, "GET", "/status").then(
      () => true,
      () => false,
    ),
    async installService(dir, cmd) {
      await installService(dir, cmd);
    },
    stopLegacyAgent,
    removeLegacyAutostart,
    bootoutLegacy,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// `tunelo uninstall`: `tunelo logout` (without the network it warns and goes
// on), then everything the install script and tunelo put on the machine:
// the background service and the terminal process with their units, the
// config folder, the key store entries (macOS Keychain; DPAPI and plain key
// files sit in the config folder), the PATH lines the install script added,
// and the binaries (tunelo, tunelo-term-host and the `.old` copies updates
// keep). Windows cannot delete a running file: a detached `cmd` deletes
// both tunelo folders a moment after this process exits.
//
// Only the paths listed by uninstallTargets are touched; a development run
// (not the installed single file) keeps its binary.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { deleteKeyStore } from "../keystore.ts";
import { isCompiled, uninstallService } from "../service.ts";
import { logout } from "./logout.ts";

/** The line install.sh adds to shell profiles; removed only when nothing else is left in its folder. */
export const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
/** The profiles install.sh may add PATH_LINE to. */
const PROFILES = [".zprofile", ".bash_profile", ".profile", ".bashrc", ".zshrc"];
const TERM_HOST = "tunelo-term-host";

export type UninstallTargets = {
  /** Folders deleted whole. On Windows, by the detached command after exit. */
  dirs: string[];
  /** Files deleted (the binaries and their `.old` copies), outside those folders. */
  files: string[];
  /** Shell profiles PATH_LINE is taken out of, when `pathDir` is empty afterwards. */
  profiles: string[];
  /** The folder the PATH entry points at. */
  pathDir: string | undefined;
};

export type UninstallEnvironment = {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The config folder in use (TUNELO_HOME or the default). */
  configDir: string;
  /** The running binary; undefined in a development run. */
  binary: string | undefined;
};

/** Every path `tunelo uninstall` deletes or edits on this OS. */
export function uninstallTargets(e: UninstallEnvironment): UninstallTargets {
  if (e.platform === "win32") {
    const roaming = e.env.APPDATA || win32.join(e.home, "AppData", "Roaming");
    const local = e.env.LOCALAPPDATA || win32.join(e.home, "AppData", "Local");
    const binDir = win32.join(local, "tunelo");
    const dirs = [...new Set([e.configDir, win32.join(roaming, "tunelo"), binDir])];
    return { dirs, files: [], profiles: [], pathDir: binDir };
  }
  const files: string[] = [];
  let pathDir: string | undefined;
  if (e.binary) {
    const dir = dirname(e.binary);
    files.push(e.binary, join(dir, TERM_HOST));
    pathDir = dir;
  }
  // The config folder in use; on macOS also the Application Support folder, should one exist.
  const dirs = [e.configDir, ...(e.platform === "darwin" ? [join(e.home, "Library", "Application Support", "tunelo")] : [])];
  return {
    dirs: [...new Set(dirs)],
    files,
    profiles: PROFILES.map((p) => join(e.home, p)),
    pathDir: pathDir === join(e.home, ".local", "bin") ? pathDir : undefined,
  };
}

/** Takes PATH_LINE (and the blank line install.sh put before it) out of a profile's text. */
export function withoutPathLine(text: string): string {
  return text.replace(/\n?\n?export PATH="\$HOME\/\.local\/bin:\$PATH"[ \t]*(?=\n|$)/g, "");
}

/** What uninstalling touches beyond the listed paths; tests replace it. */
export interface UninstallDeps {
  environment: UninstallEnvironment;
  /** `tunelo logout --force`: resolves with its exit code. */
  logout: (dir: string) => Promise<number>;
  /** Stops the service and removes its units; logout does it, this is for when logout failed early. */
  removeService: (dir: string) => Promise<void>;
  deleteKeyStore: (dir: string) => Promise<void>;
  /** Windows: takes `dir` out of the user's PATH. */
  removeUserPath: (dir: string) => Promise<void>;
  /** Windows: deletes the folders a moment after this process exits. */
  deleteAfterExit: (dirs: string[]) => void;
  log: (line: string) => void;
}

/** A PowerShell single-quoted string. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function removeWindowsUserPath(dir: string): Promise<void> {
  const script = [
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($p) {",
    `  $kept = ($p -split ';') | Where-Object { $_ -and ($_.TrimEnd('\\') -ne ${psQuote(dir.replace(/\\+$/, ""))}) }`,
    "  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')",
    "}",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`powershell exited ${String(code)}`))));
  });
}

function deleteWindowsDirsAfterExit(dirs: string[]): void {
  const removals = dirs.map((d) => `rmdir /s /q "${d}"`).join(" & ");
  spawn("cmd.exe", ["/d", "/c", `ping -n 3 127.0.0.1 >nul & ${removals}`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

export function defaultUninstallDeps(configDir: string): UninstallDeps {
  return {
    environment: { platform: process.platform, home: homedir(), env: process.env, configDir, binary: isCompiled() ? process.execPath : undefined },
    logout: (dir) => logout(dir, { force: true }),
    removeService: (dir) => uninstallService(dir),
    deleteKeyStore,
    removeUserPath: removeWindowsUserPath,
    deleteAfterExit: deleteWindowsDirsAfterExit,
    log: (line) => console.log(line),
  };
}

/** The `.old` copies an update keeps next to a binary (`tunelo.old`, `tunelo.old-…`). */
function oldCopies(file: string): string[] {
  const dir = dirname(file);
  if (!existsSync(dir)) return [];
  const name = basename(file);
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.old`))
    .map((f) => join(dir, f));
}

/** Uninstalls tunelo from this machine. Resolves with the exit code. */
export async function uninstall(dir: string, deps: UninstallDeps = defaultUninstallDeps(dir)): Promise<number> {
  const e = deps.environment;
  // Leaves the account; without the network it warns and goes on (--force).
  try {
    await deps.logout(dir);
  } catch (err) {
    deps.log(`  Warning: could not leave the account (${(err as Error).message}); remove the machine on the chat's Machines page.`);
    await deps.removeService(dir).catch((e: unknown) => deps.log(`  Warning: could not remove the background service (${(e as Error).message}).`));
  }
  await deps.deleteKeyStore(dir).catch((err: unknown) => deps.log(`  Warning: could not delete tunelo's key store entries (${(err as Error).message}).`));
  const t = uninstallTargets(e);

  if (e.platform === "win32") {
    if (t.pathDir) await deps.removeUserPath(t.pathDir).catch((err: unknown) => deps.log(`  Warning: could not take tunelo out of your PATH (${(err as Error).message}).`));
    deps.deleteAfterExit(t.dirs);
    deps.log("  tunelo is uninstalled; its folders are deleted in a moment.");
    return 0;
  }

  for (const d of t.dirs) rmSync(d, { recursive: true, force: true });
  for (const f of t.files.flatMap((file) => [file, ...oldCopies(file)])) rmSync(f, { force: true });
  // ~/.local/bin is shared: its PATH line goes only when tunelo was the last thing in it.
  if (t.pathDir && (!existsSync(t.pathDir) || readdirSync(t.pathDir).length === 0)) {
    for (const p of t.profiles) {
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      const kept = withoutPathLine(text);
      if (kept !== text) writeFileSync(p, kept);
    }
  }
  deps.log("  tunelo is uninstalled.");
  return 0;
}

// Notices Claude's configuration changing while the service runs, on the
// machine and in each profile, so the other side gets it at once instead of
// at the next session start: a session already open sees the change too
// (claude reloads its settings and .claude.json when they change).
//
// Folders are watched, not files: claude and editors save by writing a new
// file and renaming it over the old one, which ends a watch on the file
// itself. Changes come in bursts (temp file, rename), so they are gathered
// for a short while and answered once.
import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CLAUDE_JSON, MACHINE_SETTINGS_FILES } from "./config-sync.ts";
import { claudeJsonOf } from "./paths.ts";

/** How long a burst of changes is gathered before the other side is updated. */
export const SETTINGS_SYNC_DELAY_MS = 300;

/** The files of a Claude folder kept in sync (settings, key bindings, .claude.json inside the folder). */
export const SYNCED_FILES: readonly string[] = [...MACHINE_SETTINGS_FILES, CLAUDE_JSON];

/**
 * Calls `onChange` after one of `names` in `dir` changes (any case: Windows
 * and macOS folders ignore it); returns what stops watching. A folder that
 * cannot be watched (missing, no rights) is logged and left alone: sessions
 * still sync at start.
 */
export function watchFiles(
  dir: string,
  names: readonly string[],
  onChange: () => void,
  log: (line: string) => void,
  delayMs = SETTINGS_SYNC_DELAY_MS,
): () => void {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  const stop = (): void => {
    clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
  };
  try {
    watcher = watch(dir, { persistent: false }, (_event, name) => {
      // Some systems do not name the file: the change may be ours, so it counts.
      if (name !== null && !wanted.has(String(name).toLowerCase())) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onChange();
      }, delayMs);
      timer.unref?.();
    });
    watcher.on("error", (err) => {
      log(`claude profiles: stopped following ${dir} (${err.message})`);
      stop();
    });
  } catch (err) {
    log(`claude profiles: cannot follow the settings in ${dir} (${(err as Error).message}); they sync when a session starts`);
  }
  return stop;
}

/**
 * Follows the machine's Claude configuration: its folder (settings, key
 * bindings) and the folder of its .claude.json, which is ~ for ~/.claude.
 */
export function watchMachineSettings(
  claudeHome: string,
  onChange: () => void,
  log: (line: string) => void,
  delayMs = SETTINGS_SYNC_DELAY_MS,
): () => void {
  const claudeJson = claudeJsonOf(claudeHome);
  const inside = claudeJson === join(claudeHome, CLAUDE_JSON);
  const stops = [watchFiles(claudeHome, inside ? SYNCED_FILES : MACHINE_SETTINGS_FILES, onChange, log, delayMs)];
  if (!inside) stops.push(watchFiles(dirname(claudeJson), [basename(claudeJson)], onChange, log, delayMs));
  return () => {
    for (const stop of stops) stop();
  };
}

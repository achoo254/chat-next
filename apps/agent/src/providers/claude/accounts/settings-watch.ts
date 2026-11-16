// Notices the machine's Claude settings changing while the service runs, so
// every profile gets the new copy at once instead of at its next session
// start: a session already open on a profile then sees the change too
// (claude reloads its settings file when it changes).
//
// The folder is watched, not the files: claude and editors save by writing a
// new file and renaming it over the old one, which ends a watch on the file
// itself. Changes come in bursts (temp file, rename), so they are gathered
// for a short while and answered once.
import { type FSWatcher, watch } from "node:fs";
import { MACHINE_SETTINGS_FILES } from "./setup.ts";

/** How long a burst of changes is gathered before the profiles are updated. */
export const SETTINGS_SYNC_DELAY_MS = 300;

/** Whether a name the watcher reports is one of the copied settings files (any case: Windows and macOS folders ignore it). */
function isMachineSettingsFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MACHINE_SETTINGS_FILES.some((file) => file === lower);
}

/**
 * Calls `onChange` after the machine's settings files in `claudeHome` change;
 * returns what stops watching. A folder that cannot be watched (missing,
 * no rights) is logged and left alone: sessions still copy at start.
 */
export function watchMachineSettings(
  claudeHome: string,
  onChange: () => void,
  log: (line: string) => void,
  delayMs = SETTINGS_SYNC_DELAY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  const stop = (): void => {
    clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
  };
  try {
    watcher = watch(claudeHome, { persistent: false }, (_event, name) => {
      // Some systems do not name the file: the change may be ours, so it counts.
      if (name !== null && !isMachineSettingsFile(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onChange();
      }, delayMs);
      timer.unref?.();
    });
    watcher.on("error", (err) => {
      log(`claude profiles: stopped following the machine's settings (${err.message})`);
      stop();
    });
  } catch (err) {
    log(`claude profiles: cannot follow the machine's settings (${(err as Error).message}); they reach a profile when its session starts`);
  }
  return stop;
}

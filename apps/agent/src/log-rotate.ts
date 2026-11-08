// Keeps agent.log small: past 5 MB it is copied to agent.log.1 (older copies
// move to .2 and .3, the oldest is dropped) and emptied in place. The
// service's output was opened by the supervisor (launchd, the Windows logon
// task) in append mode, so emptying the file in place is the only way the
// service can rotate it; lines written between the copy and the emptying
// are lost. `tunelo logs -f` starts over when the file shrinks.
import { chmodSync, copyFileSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;
const CHECK_EVERY_MS = 60_000;

/** Rotates `file` when it passed `maxBytes`; true when it did. */
export function rotateLog(file: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // no copy of that age yet
    }
  }
  copyFileSync(file, `${file}.1`);
  chmodSync(`${file}.1`, 0o600);
  truncateSync(file, 0);
  return true;
}

/** Checks `file` now and every minute; returns the stop. */
export function startLogRotation(file: string, log: (line: string) => void): () => void {
  const check = () => {
    try {
      if (rotateLog(file)) log(`log rotated: older lines are in ${file}.1`);
    } catch (err) {
      log(`could not rotate the log: ${(err as Error).message}`);
    }
  };
  check();
  const timer = setInterval(check, CHECK_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

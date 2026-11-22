// Temp folders of the Observatory tests, all named `obs-<name>-…` in the
// system temp folder and all removed after the test file (afterAll), even
// when a test failed: they hold databases, tokens and config files.
// (os.tmpdir() on Windows reads TEMP, not the TMPDIR vitest.config sets, so
// the run's own temp folder does not cover these.)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** A new temp folder `obs-<name>-…`, removed by removeObsTempDirs(). */
export function obsTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `obs-${name}-`));
  made.push(dir);
  return dir;
}

/** Removes every folder obsTempDir() made in this test file. */
export function removeObsTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

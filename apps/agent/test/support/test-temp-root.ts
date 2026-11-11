// Where the tests' temp folders go, and their removal once the run ends.
//
// macOS puts temp folders under /var/folders, and /var is a sensitive path
// of the agent (safety/sensitive-paths.ts), so a test home made there reads
// as sensitive: tests take their temp folders from one folder under
// /private/tmp instead (the rule itself stays as it is). Linux (CI) uses
// /tmp. Each run gets its own folder in it, named by the pid of the vitest
// process; the run removes it when it ends, and also removes the folders of
// earlier runs whose process is gone (a run stopped halfway). Set
// TUNELO_KEEP_TEST_TMP=1 to keep the run's folder for debugging.
import { mkdirSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_FOLDER = /^run-(\d+)$/;

function tempBase(): string {
  return process.platform === "darwin" && tmpdir().startsWith("/var/") ? "/private/tmp/tunelo-agent-test" : join(tmpdir(), "tunelo-agent-test");
}

/** This run's temp folder (made once; the same path however often it is asked for in this process). */
export function testTempRun(): string {
  const dir = join(tempBase(), `run-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`could not remove the test temp folder ${dir}: ${(err as Error).message}`);
  }
}

/** Vitest global setup: clears what stopped runs left; the returned teardown removes this run's folder. */
export default function setup(): () => void {
  const base = tempBase();
  const own = testTempRun();
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    names = [];
  }
  for (const name of names) {
    const pid = Number(RUN_FOLDER.exec(name)?.[1] ?? Number.NaN);
    if (Number.isInteger(pid) && pid !== process.pid && !processAlive(pid)) remove(join(base, name));
  }
  return () => {
    if (process.env.TUNELO_KEEP_TEST_TMP === "1") {
      console.info(`kept the test temp folder ${own}`);
      return;
    }
    remove(own);
    try {
      // Gone once no other run uses it; another run's folder keeps it.
      rmdirSync(base);
    } catch {
      // not empty: another run is going on
    }
  };
}

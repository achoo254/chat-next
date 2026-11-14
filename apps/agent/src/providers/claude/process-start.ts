// When a running process started, as the system tells, to check that a pid a
// running claude wrote in its register (<claude folder>/sessions/<pid>.json)
// still belongs to that claude: Windows gives a pid out again soon after its
// process ends, and a claude killed outright leaves its record behind.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A process's start: Unix ms, and on Windows also its creation time as a
 * FILETIME (100 ns steps since 1601, UTC), the form claude records as
 * `procStart` there.
 */
export type ProcessStart = { startedAt: number; fileTime?: bigint };

/** Looks up a running process's start; undefined when it does not run or cannot be told. Never fails. */
export type ProcessStartLookup = (pid: number) => Promise<ProcessStart | undefined>;

/** FILETIME of the Unix epoch. */
const UNIX_EPOCH_FILETIME = 116_444_736_000_000_000n;
const TIMEOUT_MS = 5_000;

/** On Windows, from the process's own creation time (PowerShell; one short call, only for a record that matters). */
export async function windowsProcessStart(pid: number, exec: (cmd: string, args: string[]) => Promise<string> = defaultExec): Promise<ProcessStart | undefined> {
  // Only a plain pid ever reaches the command line.
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const out = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`]);
    const digits = /^\s*(\d{1,24})\s*$/.exec(out)?.[1];
    if (digits === undefined) return undefined;
    const fileTime = BigInt(digits);
    return { fileTime, startedAt: Number((fileTime - UNIX_EPOCH_FILETIME) / 10_000n) };
  } catch {
    return undefined;
  }
}

async function defaultExec(cmd: string, args: string[]): Promise<string> {
  return (await run(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true })).stdout;
}

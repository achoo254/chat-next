// The programs the terminal process runs right now: its direct children, each
// with its command line and working folder, read with `ps` and `lsof` on
// macOS and Linux. Used to tell whether sessions no thread owns are an AI's
// CLI left alone (which may end when a newer terminal process replaces this
// one) or something else, such as a shell, that must not be cut. Windows has
// no cheap way to read another process's folder: there, and whenever the
// commands fail, the answer is undefined ("cannot tell").
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 2_000;

export type ChildProcess = {
  pid: number;
  /** The program's name or path as `ps` shows it. */
  command: string;
  /** Its whole command line. */
  args: string;
  /** Its working folder; "" when unreadable. */
  cwd: string;
};

export type Exec = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: Exec = async (cmd, args) => (await run(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout;

/** `ps -axo pid=,ppid=,comm=,args=` lines → the children of `parent`, without their folders. */
export function parseChildren(out: string, parent: number): Omit<ChildProcess, "cwd">[] {
  const found: Omit<ChildProcess, "cwd">[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, pid = "", ppid = "", command = "", args = ""] = m;
    if (Number(ppid) === parent) found.push({ pid: Number(pid), command, args });
  }
  return found;
}

/** `lsof -a -d cwd -Fn -p …` output → working folder by pid. */
export function parseCwds(out: string): Map<number, string> {
  const cwd = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwd.set(pid, line.slice(1));
  }
  return cwd;
}

/** The direct children of `parent`; undefined when they cannot be read. */
export async function childProcesses(parent: number, exec: Exec = defaultExec, platform: NodeJS.Platform = process.platform): Promise<ChildProcess[] | undefined> {
  if (platform === "win32") return undefined;
  try {
    const children = parseChildren(await exec("ps", ["-axo", "pid=,ppid=,comm=,args="]), parent);
    if (children.length === 0) return [];
    // lsof exits non-zero when one of the processes ended meanwhile: what it printed still counts.
    // macOS keeps lsof in /usr/sbin, which a service's PATH may not hold.
    const lsofPath = platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
    const lsof = await exec(lsofPath, ["-a", "-d", "cwd", "-Fn", "-p", children.map((c) => c.pid).join(",")]).catch((err: unknown) => {
      const stdout = (err as { stdout?: unknown }).stdout;
      return typeof stdout === "string" ? stdout : "";
    });
    const cwds = parseCwds(lsof);
    return children.map((c) => ({ ...c, cwd: cwds.get(c.pid) ?? "" }));
  } catch {
    return undefined;
  }
}

// Claude Code processes running on the machine, whatever started them (a
// terminal, an IDE, another app), for telling which sessions are open
// elsewhere. Claude does not keep its transcript open between writes, so the
// file has no holder to find; what every process does show is its working
// folder and when it started (and, when resumed by id, that id on its command
// line). Read with `ps` and `lsof` on macOS and Linux: two short commands,
// kept for a few seconds. Windows has no cheap way to read another process's
// folder: there, and whenever the commands fail, the list is empty.
//
// Nothing here reads any application's own files or settings.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type RunningClaude = {
  pid: number;
  /** Its working folder. */
  cwd: string;
  /** Unix milliseconds when it started (to the second). */
  startedAt: number;
  /** The session it resumed by id (`--resume <id>`, `--session-id <id>`); "" when unknown. */
  sessionId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRESH_MS = 5_000;
const TIMEOUT_MS = 2_000;

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in milliseconds; undefined when unreadable. */
export function elapsedMs(etime: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return undefined;
  const [, d = "0", h = "0", min = "0", sec = "0"] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)) * 1000;
}

/** The program a command line runs is Claude Code: its native binary, or its package run by node. */
export function isClaudeCommand(comm: string, args: string): boolean {
  const base = (comm.split("/").pop() ?? "").toLowerCase();
  if (base === "claude") return true;
  const first = (args.trim().split(/\s+/)[0] ?? "").split("/").pop()?.toLowerCase();
  if (first === "claude") return true;
  return /\/(?:@anthropic-ai\/claude-code|claude-code)\/cli\.m?js(?:\s|$)/.test(args);
}

/** The session id a command line resumes or names; "" when none. */
export function sessionIdOf(args: string): string {
  const words = args.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    const eq = /^--(?:resume|session-id)=(.+)$/.exec(w);
    const value = eq ? eq[1] : w === "--resume" || w === "-r" || w === "--session-id" ? words[i + 1] : undefined;
    if (value && UUID.test(value)) return value.toLowerCase();
  }
  return "";
}

/**
 * `ps -axo pid=,ppid=,etime=,comm=,args=` lines → Claude processes (cwd not
 * yet known). Children of `exceptParent` (tunelo's own sessions) are left out.
 */
export function parsePs(out: string, now: number, exceptParent: number): Omit<RunningClaude, "cwd">[] {
  const found: Omit<RunningClaude, "cwd">[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, pid = "", ppid = "", etime = "", comm = "", args = ""] = m;
    if (Number(ppid) === exceptParent || !isClaudeCommand(comm, args)) continue;
    const age = elapsedMs(etime);
    if (age === undefined) continue;
    found.push({ pid: Number(pid), startedAt: now - age, sessionId: sessionIdOf(args) });
  }
  return found;
}

/** `lsof -a -d cwd -Fn -p …` output → working folder by pid. */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwd = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwd.set(pid, line.slice(1));
  }
  return cwd;
}

export type ProbeDeps = {
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Runs a command; resolves with its standard output. */
  exec?: (cmd: string, args: string[]) => Promise<string>;
  /** Children of this process are tunelo's own sessions. */
  selfPid?: number;
};

/** Reads the running Claude processes at most every few seconds; one read at a time. */
export class ClaudeProcesses {
  private last: RunningClaude[] = [];
  private readAt = -Infinity;
  private reading: Promise<void> | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly exec: (cmd: string, args: string[]) => Promise<string>;
  private readonly selfPid: number;

  constructor(deps: ProbeDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.exec = deps.exec ?? (async (cmd, args) => (await run(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout);
    this.selfPid = deps.selfPid ?? process.pid;
  }

  /** The processes as last read. */
  get current(): readonly RunningClaude[] {
    return this.last;
  }

  /** Reads again unless the last read is only seconds old. Never throws. */
  refresh(): Promise<void> {
    if (this.platform === "win32" || this.now() - this.readAt < FRESH_MS) return Promise.resolve();
    this.reading ??= this.read().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private async read(): Promise<void> {
    try {
      const now = this.now();
      const procs = parsePs(await this.exec("ps", ["-axo", "pid=,ppid=,etime=,comm=,args="]), now, this.selfPid);
      let cwd = new Map<number, string>();
      if (procs.length) {
        // lsof exits 1 when one of the processes ended meanwhile: its output still counts.
        const out = await this.exec("lsof", ["-a", "-d", "cwd", "-Fn", "-p", procs.map((p) => p.pid).join(",")]).catch((err: unknown) => {
          const stdout = (err as { stdout?: unknown }).stdout;
          return typeof stdout === "string" ? stdout : "";
        });
        cwd = parseLsofCwd(out);
      }
      this.last = procs.flatMap((p) => {
        const dir = cwd.get(p.pid);
        return dir ? [{ ...p, cwd: dir }] : [];
      });
    } catch {
      this.last = [];
    }
    this.readAt = this.now();
  }
}

/** Slack between a process starting and its session file changing, for clocks read to the second. */
const START_SLACK_MS = 2_000;

/**
 * Sessions the running processes hold: the one named on a command line, and
 * otherwise, per working folder, the sessions of that folder changed since
 * its processes started, newest first, one per process.
 */
export function heldSessions(
  procs: readonly RunningClaude[],
  sessions: readonly { sessionId: string; dir: string; mtimeMs: number }[],
  same: (a: string, b: string) => boolean,
): Set<string> {
  const held = new Set<string>();
  const unnamed: RunningClaude[] = [];
  for (const p of procs) {
    if (p.sessionId) held.add(p.sessionId);
    else unnamed.push(p);
  }
  const byDir = new Map<string, RunningClaude[]>();
  for (const p of unnamed) {
    const key = [...byDir.keys()].find((d) => same(d, p.cwd)) ?? p.cwd;
    byDir.set(key, [...(byDir.get(key) ?? []), p]);
  }
  for (const [dir, list] of byDir) {
    const since = Math.min(...list.map((p) => p.startedAt)) - START_SLACK_MS;
    const changed = sessions
      .filter((s) => !held.has(s.sessionId) && same(s.dir, dir) && s.mtimeMs >= since)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, list.length);
    for (const s of changed) held.add(s.sessionId);
  }
  return held;
}

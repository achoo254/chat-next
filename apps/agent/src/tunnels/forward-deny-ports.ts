// Ports a local forward never reaches. Beyond the shared list
// (LOCAL_FORWARD.DENY_PORTS, which the tunnel server also checks), the
// machine knows more of its own:
// - every port of tunelo itself: the device link, the control channel, the
//   inspectors of `tunelo http`, and anything a tunelo process listens on;
// - the IDE ports of Claude Code, from `<claude folder>/ide/<port>.lock` of
//   the machine's Claude folder, ~/.claude and every Claude profile;
// - the debug ports running processes were started with: `--inspect*`
//   (9229 when no port is given), `--inspect-port`, `--remote-debugging-port`,
//   a JVM's `jdwp` address, `kubectl proxy` (8001 unless given), also when
//   they come from the environment (`NODE_OPTIONS`, on macOS and Linux);
//   a debug port of 0 (picked at random) refuses every port of that process;
// - the ports the user added (`tunelo config local-forward block <port>`).
//
// Reading processes takes a moment, so a snapshot is kept for a few seconds
// and shared by the requests of that time. When the OS cannot be read, the
// last good reading stands; before any good reading, the common debug ports
// are refused as well (fail closed).
//
// Still not seen: a debugger switched on later (SIGUSR1: 9229 is refused
// anyway), `NODE_OPTIONS` of processes on Windows, debuggers that take no
// port on the command line (debugpy, Delve, JMX set in a config file), and
// processes of other OS users that ps does not show in full.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeniedForwardPort } from "@tunelo/client";
import { defaultClaudeHome, profilesRoot } from "../profiles/paths.ts";
import { type ListeningPort, type ProcessLine, listeningPorts, processLines } from "./listening-ports.ts";
import { listRecords } from "./run-registry.ts";

/** How long a snapshot of processes and ports stays fresh. */
export const DENY_SNAPSHOT_MS = 3_000;
/** Refused while running processes could never be read (common debug and admin ports). */
export const FALLBACK_DEBUG_PORTS: readonly number[] = [5005, 5858, 8001, 9222, 9223, 9229, 9230, 9231, 9232];

export type DenySources = {
  /** tunelo's config folder (control.json, Claude profiles). */
  configDir: string;
  /** Ports this process holds that the OS listing might miss (the device link). */
  ownPorts: () => readonly number[];
  /** Ports the user added on this machine. */
  extraPorts: () => readonly number[];
  listening?: () => Promise<ListeningPort[]>;
  processes?: () => Promise<ProcessLine[]>;
  /** Inspector ports of running `tunelo http` processes, and their pids. */
  runs?: () => { pid: number; inspectorPort?: number }[];
  /** Claude folders whose `ide` folder holds lock files. */
  claudeHomes?: () => string[];
  /** Where a failed reading of the OS is reported. */
  log?: (line: string) => void;
  now?: () => number;
};

export type DenySnapshot = {
  /** Ports refused, beyond the shared list. */
  denied: ReadonlySet<number>;
  /** What listens on 127.0.0.1, when the OS could list it. */
  listening: readonly ListeningPort[];
};

const port = (value: string | undefined): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : null;
};

/** Debug ports named on a command line. */
export function debugPortsOf(command: string): number[] {
  const out: number[] = [];
  const add = (n: number | null) => {
    if (n !== null) out.push(n);
  };
  for (const m of command.matchAll(/--inspect(?:-brk|-wait)?(?:=(?:\[[^\]]*\]:|[^\s:=]*:)?(\d+))?(?=\s|$)/g)) add(m[1] === undefined ? 9229 : port(m[1]));
  for (const m of command.matchAll(/--inspect-port=(?:\[[^\]]*\]:|[^\s:=]*:)?(\d+)/g)) add(port(m[1]));
  for (const m of command.matchAll(/--remote-debugging-port[=\s](\d+)/g)) add(port(m[1]));
  for (const m of command.matchAll(/jdwp=\S*?address=(?:[^,\s]*:)?(\d+)/g)) add(port(m[1]));
  if (/\bkubectl\b.*\sproxy(?=\s|$)/.test(command)) add(port(/(?:--port[=\s]|\s-p[=\s]?)(\d+)/.exec(command)?.[1]) ?? 8001);
  return out;
}

/** Whether a command line asks for a debug port picked at random (`=0`): its ports are unknown. */
export function randomDebugPort(command: string): boolean {
  return /--inspect(?:-brk|-wait|-port)?=(?:\[[^\]]*\]:|[^\s:=]*:)?0+(?=\s|$)|--remote-debugging-port[=\s]0+(?=\s|$)/.test(command);
}

/** Ports of `<home>/ide/<port>.lock` files. */
export function idePorts(claudeHomes: readonly string[]): number[] {
  const out: number[] = [];
  for (const home of claudeHomes) {
    let names: string[];
    try {
      names = readdirSync(join(home, "ide"));
    } catch {
      continue;
    }
    for (const name of names) {
      const n = /^(\d{1,5})\.lock$/.exec(name)?.[1];
      const p = port(n);
      if (p !== null) out.push(p);
    }
  }
  return out;
}

/** The machine's Claude folder, ~/.claude, and the home of every Claude profile. */
function claudeHomesOf(configDir: string): string[] {
  const homes = new Set([defaultClaudeHome(), join(homedir(), ".claude")]);
  try {
    for (const entry of readdirSync(profilesRoot(configDir), { withFileTypes: true })) {
      if (entry.isDirectory()) homes.add(join(profilesRoot(configDir), entry.name, "home"));
    }
  } catch {
    // no profiles yet
  }
  return [...homes];
}

/** The control channel's port, from control.json. */
function controlPort(configDir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, "control.json"), "utf8")) as { port?: unknown };
    return typeof parsed.port === "number" ? port(String(parsed.port)) : null;
  } catch {
    return null;
  }
}

/** Whether a process name is tunelo (or hda, its earlier name). */
function isTuneloName(name: string): boolean {
  return /^(tunelo|hda)(\.exe)?$/i.test(name);
}

export class ForwardDenyList {
  private snapshot: { at: number; value: DenySnapshot } | undefined;
  /** The last readings of the OS that worked; undefined until one did. */
  private lastListening: ListeningPort[] | undefined;
  private lastProcesses: ProcessLine[] | undefined;
  private pending: Promise<DenySnapshot> | undefined;
  private readonly now: () => number;

  constructor(private readonly sources: DenySources) {
    this.now = sources.now ?? Date.now;
  }

  /** Whether a forward to `p` is refused. */
  async denies(p: number): Promise<boolean> {
    if (isDeniedForwardPort(p) || this.sources.ownPorts().includes(p) || this.sources.extraPorts().includes(p)) return true;
    return (await this.current()).denied.has(p);
  }

  /** A fresh snapshot, or the one being read now. */
  current(): Promise<DenySnapshot> {
    const hit = this.snapshot;
    if (hit && this.now() - hit.at < DENY_SNAPSHOT_MS) return Promise.resolve(hit.value);
    this.pending ??= this.read().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async read(): Promise<DenySnapshot> {
    const s = this.sources;
    const failed = (what: string) => (err: unknown) => {
      s.log?.(`local forward: could not read ${what} (${(err as Error).message}); keeping the last reading`);
      return undefined;
    };
    const [listed, read] = await Promise.all([
      (s.listening ?? listeningPorts)().catch(failed("listening ports")),
      (s.processes ?? processLines)().catch(failed("running processes")),
    ]);
    if (listed) this.lastListening = listed;
    if (read) this.lastProcesses = read;
    const listening = this.lastListening ?? [];
    const processes = this.lastProcesses ?? [];
    const runs = (s.runs ?? listRecords)();
    const tuneloPids = new Set([process.pid, ...runs.map((r) => r.pid)]);
    const denied = new Set<number>([...s.ownPorts(), ...s.extraPorts()]);
    const control = controlPort(s.configDir);
    if (control !== null) denied.add(control);
    for (const r of runs) if (r.inspectorPort !== undefined) denied.add(r.inspectorPort);
    for (const l of listening) if (tuneloPids.has(l.pid) || isTuneloName(l.name)) denied.add(l.port);
    for (const p of idePorts((s.claudeHomes ?? (() => claudeHomesOf(s.configDir)))())) denied.add(p);
    if (this.lastProcesses === undefined) for (const p of FALLBACK_DEBUG_PORTS) denied.add(p);
    const randomPids = new Set<number>();
    for (const proc of processes) {
      for (const p of debugPortsOf(proc.command)) denied.add(p);
      if (randomDebugPort(proc.command)) randomPids.add(proc.pid);
    }
    for (const l of listening) if (randomPids.has(l.pid)) denied.add(l.port);
    const value: DenySnapshot = { denied, listening };
    this.snapshot = { at: this.now(), value };
    return value;
  }
}

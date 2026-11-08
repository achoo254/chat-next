// Ports a local forward never reaches. Beyond the shared list
// (LOCAL_FORWARD.DENY_PORTS, which the tunnel server also checks), the
// machine knows more of its own:
// - every port of tunelo itself: the device link, the control channel, the
//   inspectors of `tunelo http`, and anything a tunelo process listens on;
// - the IDE ports of Claude Code, from `<claude folder>/ide/<port>.lock` of
//   the machine's Claude folder, ~/.claude and every Claude profile;
// - the debug ports running processes were started with: `--inspect*`
//   (9229 when no port is given), `--inspect-port`, `--remote-debugging-port`,
//   and a JVM's `jdwp` address;
// - the ports the user added (`tunelo config local-forward block <port>`).
//
// Reading processes takes a moment, so a snapshot is kept for a few seconds
// and shared by the requests of that time.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeniedForwardPort } from "@tunelo/client";
import { defaultClaudeHome, profilesRoot } from "../profiles/paths.ts";
import { type ListeningPort, type ProcessLine, listeningPorts, processLines } from "./listening-ports.ts";
import { listRecords } from "./run-registry.ts";

/** How long a snapshot of processes and ports stays fresh. */
export const DENY_SNAPSHOT_MS = 3_000;

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
  return out;
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
    const [listening, processes] = await Promise.all([
      (s.listening ?? listeningPorts)().catch(() => [] as ListeningPort[]),
      (s.processes ?? processLines)().catch(() => [] as ProcessLine[]),
    ]);
    const runs = (s.runs ?? listRecords)();
    const tuneloPids = new Set([process.pid, ...runs.map((r) => r.pid)]);
    const denied = new Set<number>([...s.ownPorts(), ...s.extraPorts()]);
    const control = controlPort(s.configDir);
    if (control !== null) denied.add(control);
    for (const r of runs) if (r.inspectorPort !== undefined) denied.add(r.inspectorPort);
    for (const l of listening) if (tuneloPids.has(l.pid) || isTuneloName(l.name)) denied.add(l.port);
    for (const p of idePorts((s.claudeHomes ?? (() => claudeHomesOf(s.configDir)))())) denied.add(p);
    for (const proc of processes) for (const p of debugPortsOf(proc.command)) denied.add(p);
    const value: DenySnapshot = { denied, listening };
    this.snapshot = { at: this.now(), value };
    return value;
  }
}

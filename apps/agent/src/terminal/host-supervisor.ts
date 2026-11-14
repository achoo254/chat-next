// Finds, installs and starts tunelo-term-host, the process that keeps the
// machine's terminals. It runs under a supervised unit of its own (launchd
// label, systemd user unit, HKCU Run entry with a restart loop on Windows;
// service.ts / systemd-service.ts), never as the agent's child, so restarting
// or updating the agent leaves every shell running. The unit is written on
// first terminal use, so machines installed before the terminal get it then.
//
// Which binary: TUNELO_TERM_HOST_BIN, else `<config>/term-host/bin/current/`,
// else the agent's own folder. A newer one is staged in `bin/next/` (the
// release step downloads it there); it becomes `bin/current/` only while no
// terminal process runs, so an update never cuts open shells. The terminal
// service replaces a running one sooner when every session it keeps is a
// thread's idle AI, which opens again resumed (`replace`).
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ControlError, type HelloResult, HostLink, type HostLinkOptions, readControlInfo, termHostDir } from "./host-link.ts";

export const TERM_HOST_BINARY = process.platform === "win32" ? "tunelo-term-host.exe" : "tunelo-term-host";
/** How long a started terminal process may take to answer on its socket. */
const START_TIMEOUT_MS = 10_000;

export type TerminalAvailabilityState = "available" | "missing" | "incompatible";

/** The terminal process's own supervised unit on this OS (service.ts builds the real ones). */
export interface TermHostUnit {
  /** True when the registered unit is the one this tunelo would write for `bin`. */
  current(bin: string): boolean;
  /** Writes and registers the unit for `bin`; only called while no terminal process runs. */
  install(bin: string): Promise<void>;
  /** Starts the terminal process through the unit (nothing happens when it runs). */
  start(): Promise<void>;
  /** Unregisters and deletes the unit; the caller shut the process down first. */
  remove(): Promise<void>;
}

/** The terminal process cannot serve (missing, another major, or it does not start). */
export class TerminalUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUnavailable";
  }
}

const binDir = (configDir: string) => join(termHostDir(configDir), "bin");

/** The terminal process binary to run, or undefined when none is installed. */
export function locateTermHost(configDir: string, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | undefined {
  const fromEnv = env.TUNELO_TERM_HOST_BIN;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  for (const candidate of [join(binDir(configDir), "current", TERM_HOST_BINARY), join(dirname(execPath), TERM_HOST_BINARY)]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Moves a staged `bin/next/` into `bin/current/`; the one it replaces is kept
 * in `bin/previous/` until the next switch (restorePreviousTermHost puts it
 * back). Only while no terminal process runs. Returns true when it switched.
 */
export function switchStagedTermHost(configDir: string, log: (line: string) => void = () => undefined): boolean {
  const next = join(binDir(configDir), "next");
  if (!existsSync(join(next, TERM_HOST_BINARY))) return false;
  const current = join(binDir(configDir), "current");
  const old = join(binDir(configDir), "previous");
  try {
    rmSync(old, { recursive: true, force: true });
    if (existsSync(current)) renameSync(current, old);
    renameSync(next, current);
    return true;
  } catch (err) {
    log(`terminal: could not switch to the staged terminal process (${(err as Error).message})`);
    return false;
  }
}

/**
 * The switched-to terminal process does not start: drops it, and puts back
 * the one it replaced (`bin/previous/`, or the agent's own folder's when
 * there was none). Only while no terminal process runs.
 */
export function restorePreviousTermHost(configDir: string, log: (line: string) => void = () => undefined): void {
  const current = join(binDir(configDir), "current");
  const old = join(binDir(configDir), "previous");
  try {
    rmSync(current, { recursive: true, force: true });
    if (existsSync(old)) renameSync(old, current);
  } catch (err) {
    log(`terminal: could not go back to the previous terminal process (${(err as Error).message})`);
  }
}

export type SupervisorOptions = Omit<HostLinkOptions, "onReady" | "onDown" | "configDir"> & {
  configDir: string;
  /** The OS unit; undefined where this OS cannot supervise it (no systemd). */
  unit: TermHostUnit | undefined;
  onReady: (hello: HelloResult) => void;
  onDown: () => void;
  /** MachineInfo.terminal changed. */
  onAvailability?: (state: TerminalAvailabilityState) => void;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
};

export class HostSupervisor {
  readonly link: HostLink;
  private state: TerminalAvailabilityState;
  private starting: Promise<void> | undefined;

  constructor(private readonly opts: SupervisorOptions) {
    this.link = new HostLink({ ...opts, onReady: (h) => this.ready(h), onDown: () => opts.onDown() });
    this.state = this.probe();
  }

  /** What MachineInfo.terminal says. */
  availability(): TerminalAvailabilityState {
    return this.state;
  }

  private set(state: TerminalAvailabilityState): void {
    if (state === this.state) return;
    this.state = state;
    this.opts.onAvailability?.(state);
  }

  private probe(): TerminalAvailabilityState {
    if (readControlInfo(this.opts.configDir)) return "available";
    if (!this.opts.unit) return "incompatible";
    return locateTermHost(this.opts.configDir, this.opts.env, this.opts.execPath) ? "available" : "missing";
  }

  private ready(hello: HelloResult): void {
    this.set("available");
    this.opts.onReady(hello);
  }

  /** A newer terminal process waits in `bin/next/` (a binary named by the environment is never swapped). */
  hasStaged(): boolean {
    if ((this.opts.env ?? process.env).TUNELO_TERM_HOST_BIN) return false;
    return existsSync(join(binDir(this.opts.configDir), "next", TERM_HOST_BINARY));
  }

  /**
   * Shuts the running terminal process down (every program in it ends) and
   * starts the staged one in its place; when that one does not start, the
   * one it replaced starts again and this throws. The caller checked that
   * nothing in it would be lost, over a link that is ready.
   */
  async replace(): Promise<void> {
    const info = readControlInfo(this.opts.configDir);
    if (!info || !this.link.isReady) throw new Error("the terminal process is not connected");
    try {
      await this.link.call("shutdown");
    } catch {
      // Not answering: stopped by its pid below.
    }
    await stopProcess(info.pid, 10_000);
    // The answer to `shutdown` comes before its socket closes: start the new one only once the link is down.
    for (const end = Date.now() + 5_000; this.link.isReady && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
    if (this.link.isReady) throw new Error("the running terminal process did not stop");
    try {
      await this.ensureRunning();
    } catch (err) {
      this.opts.log(`terminal: the newer terminal process did not start (${(err as Error).message}); going back to the previous one`);
      restorePreviousTermHost(this.opts.configDir, this.opts.log);
      await this.ensureRunning();
      throw err;
    }
  }

  /** At agent start: a terminal process that kept running is joined again (its sessions, its unsent audit). */
  attachExisting(): void {
    if (!readControlInfo(this.opts.configDir)) return;
    this.link.connect().catch((err: unknown) => this.failed(err, false));
  }

  /** Connects to the terminal process, starting it through its unit when none runs. */
  ensureRunning(): Promise<void> {
    if (this.link.isReady) return Promise.resolve();
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (readControlInfo(this.opts.configDir)) {
      try {
        await this.link.connect();
        return;
      } catch (err) {
        if (err instanceof ControlError) return this.failed(err, true);
        // A control.json left by a process that crashed: start a new one.
      }
    }
    const { configDir, unit } = this.opts;
    if (!unit) {
      this.set("incompatible");
      throw new TerminalUnavailable("this machine cannot keep a terminal process running (no service manager)");
    }
    // A binary named by the environment is never swapped.
    if (!(this.opts.env ?? process.env).TUNELO_TERM_HOST_BIN && switchStagedTermHost(configDir, this.opts.log)) {
      this.opts.log("terminal: switched to the newer terminal process");
    }
    const bin = locateTermHost(configDir, this.opts.env, this.opts.execPath);
    if (!bin) {
      this.set("missing");
      throw new TerminalUnavailable("the terminal process is not installed on this machine");
    }
    try {
      if (!unit.current(bin)) await unit.install(bin);
      await unit.start();
    } catch (err) {
      this.set("incompatible");
      throw new TerminalUnavailable(`the terminal process could not be started: ${(err as Error).message}`);
    }
    const until = Date.now() + START_TIMEOUT_MS;
    let last: unknown;
    while (Date.now() < until) {
      if (readControlInfo(configDir)) {
        try {
          await this.link.connect();
          return;
        } catch (err) {
          if (err instanceof ControlError) return this.failed(err, true);
          last = err;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new TerminalUnavailable(`the terminal process did not start (${last instanceof Error ? last.message : "no answer"})`);
  }

  private failed(err: unknown, raise: boolean): void {
    if (err instanceof ControlError && (err.code === "version_mismatch" || err.code === "unauthorized")) {
      this.set("incompatible");
      this.opts.log(`terminal: the running terminal process refused this agent (${err.code})`);
      if (raise) throw new TerminalUnavailable("the running terminal process is of another version; it is replaced once its sessions end");
      return;
    }
    this.opts.log(`terminal: not connected (${err instanceof Error ? err.message : String(err)})`);
    if (raise) throw new TerminalUnavailable("the terminal process does not answer");
  }

  /** The agent stops: the link closes, the terminal process and its shells keep running. */
  stop(): void {
    this.link.close();
  }
}

export type ShutdownOutcome = {
  /** A terminal process was running. */
  running: boolean;
  /** Sessions whose shell was still running when it was shut down. */
  openSessions: number;
};

/**
 * `tunelo uninstall`: asks the terminal process to close every connection and
 * shell and exit, and waits until it is gone (killing it if it does not
 * exit). The agent is stopped before, so this is the only client.
 */
export async function shutdownTermHost(configDir: string, agentVersion: string, timeoutMs = 10_000): Promise<ShutdownOutcome> {
  const info = readControlInfo(configDir);
  if (!info) return { running: false, openSessions: 0 };
  let openSessions = 0;
  const link = new HostLink({
    configDir,
    agentVersion,
    // Uninstalling: every connection closes anyway.
    revoked: () => [],
    onEvent: () => undefined,
    onRelay: () => undefined,
    onReady: (hello) => {
      openSessions = hello.sessions.filter((s) => !s.exited).length;
    },
    onDown: () => undefined,
    log: () => undefined,
  });
  try {
    await link.connect();
    await link.call("shutdown");
  } catch {
    // Not answering, or another major: stopped by its pid below.
  } finally {
    link.close();
  }
  await stopProcess(info.pid, timeoutMs);
  return { running: true, openSessions };
}

/** Waits until `pid` exited after a `shutdown`, killing it if it does not. */
async function stopProcess(pid: number, timeoutMs: number): Promise<void> {
  if (await exited(pid, timeoutMs)) return;
  signal(pid, "SIGTERM");
  if (!(await exited(pid, 3_000))) signal(pid, "SIGKILL");
  await exited(pid, 2_000);
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function exited(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

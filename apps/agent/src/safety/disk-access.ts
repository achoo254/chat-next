// Full Disk Access on macOS. Without it, macOS (TCC) refuses tunelo and the AI
// sessions it starts the protected folders: Desktop, Documents, Downloads,
// iCloud Drive, other apps' data. For some of them it asks first, with a
// dialog on the machine's screen that nobody answers when the session runs
// from a device, so the session hangs.
//
// The probe reads the user's own TCC folder, which only a process with Full
// Disk Access may list. Unlike Desktop or Downloads, macOS never asks about
// it: it refuses outright, so probing shows no dialog.
import { execFile, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DiskAccess = "granted" | "needed" | "not-applicable";

/** System Settings, Privacy & Security, Full Disk Access. */
export const FULL_DISK_ACCESS_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/** What the probe looks at and on which system; tests replace it. */
export interface DiskAccessProbe {
  platform: NodeJS.Platform;
  /** Lists a folder only Full Disk Access may list; throws as readdirSync does. */
  listProtected: () => void;
}

const defaultProbe: DiskAccessProbe = {
  platform: process.platform,
  listProtected: () => {
    readdirSync(join(homedir(), "Library", "Application Support", "com.apple.TCC"));
  },
};

const errnoCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : undefined;

/** Whether this process has Full Disk Access; "not-applicable" off macOS or when the probe says nothing. */
export function diskAccess(probe: DiskAccessProbe = defaultProbe): DiskAccess {
  if (probe.platform !== "darwin") return "not-applicable";
  try {
    probe.listProtected();
    return "granted";
  } catch (err) {
    const code = errnoCode(err);
    return code === "EPERM" || code === "EACCES" ? "needed" : "not-applicable";
  }
}

/**
 * True when a failed file operation is macOS refusing for lack of Full Disk
 * Access: TCC answers EPERM ("Operation not permitted"), whereas file
 * permissions answer EACCES.
 */
export function isDiskAccessDenial(err: unknown, probe: DiskAccessProbe = defaultProbe): boolean {
  return probe.platform === "darwin" && errnoCode(err) === "EPERM" && diskAccess(probe) === "needed";
}

/**
 * The steps for the machine's owner, in English for the terminal and the log.
 * `opened`: System Settings and Finder were just opened for them; only then
 * do the steps say so (a service starting by itself opens nothing).
 */
export function diskAccessSteps(binary: string, opened: boolean): string[] {
  const why = "tunelo needs Full Disk Access on this Mac to work in Desktop, Documents, Downloads or iCloud Drive";
  if (opened) {
    return [
      why,
      "(and not hang on a macOS prompt nobody answers). System Settings and a Finder window showing tunelo are open:",
      "  1. Drag tunelo from the Finder window into the Full Disk Access list.",
      "  2. Turn on the switch next to tunelo. tunelo notices by itself; nothing to restart.",
      `If they did not open: System Settings > Privacy & Security > Full Disk Access, click + and pick ${binary}.`,
    ];
  }
  return [
    why,
    "(and not hang on a macOS prompt nobody answers). On the Mac:",
    "  1. Open System Settings > Privacy & Security > Full Disk Access.",
    `  2. Click + and pick ${binary} (or drag it into the list).`,
    "  3. Turn on the switch next to tunelo. tunelo notices by itself; nothing to restart.",
    "A paired device can also open that setting on this Mac from Chat.",
  ];
}

function openDetached(args: string[]): void {
  try {
    const child = spawn("open", args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The printed steps still say where the setting is.
  }
}

/**
 * Opens Full Disk Access in System Settings and a Finder window with the
 * binary selected, ready to drag into the list. Never throws: the steps say
 * where both are anyway.
 */
export function openDiskAccessSettings(binary: string): void {
  openDetached([FULL_DISK_ACCESS_SETTINGS]);
  openDetached(["-R", binary]);
}

/** What the watch looks at and does; Machine wires the real ones, tests fakes. */
export interface DiskAccessWatchOptions {
  /** This process's own access (the probe in this process). */
  check: () => DiskAccess;
  /**
   * A new process's access. macOS may give a grant only to processes started
   * after it; when a new one has it and this one still does not, this one has
   * to restart.
   */
  checkFresh: () => Promise<DiskAccess>;
  /** This process can use the access now. */
  onGranted: () => void;
  /** Only a restarted process would have it. */
  onGrantedAfterRestart: () => void;
  intervalMs?: number;
  /** Every how many checks a new process checks too. */
  freshEvery?: number;
}

/**
 * While tunelo lacks Full Disk Access, checks every few seconds whether the
 * owner granted it, so devices learn at once and nobody has to restart
 * anything. Stops once it is granted.
 */
export class DiskAccessWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticks = 0;
  private freshRunning = false;

  constructor(private readonly opts: DiskAccessWatchOptions) {}

  /** Starts watching when the access is missing; true when it does. */
  start(): boolean {
    if (this.timer || this.opts.check() !== "needed") return false;
    this.ticks = 0;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 3_000);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get watching(): boolean {
    return this.timer !== undefined;
  }

  private async tick(): Promise<void> {
    this.ticks += 1;
    if (this.opts.check() === "granted") {
      this.stop();
      this.opts.onGranted();
      return;
    }
    if (this.freshRunning || this.ticks % (this.opts.freshEvery ?? 5) !== 0) return;
    this.freshRunning = true;
    try {
      const fresh = await this.opts.checkFresh().catch((): DiskAccess => "not-applicable");
      if (fresh === "granted" && this.timer) {
        this.stop();
        this.opts.onGrantedAfterRestart();
      }
    } finally {
      this.freshRunning = false;
    }
  }
}

/** Runs `command` (tunelo's own `disk-access`) in a new process and reads its answer. */
export function freshDiskAccess(command: string[]): Promise<DiskAccess> {
  const [exe, ...args] = command;
  if (!exe) return Promise.resolve("not-applicable");
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: 10_000 }, (err, stdout) => {
      const answer = String(stdout).trim();
      resolve(!err && (answer === "granted" || answer === "needed") ? answer : "not-applicable");
    });
  });
}

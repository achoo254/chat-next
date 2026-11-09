// Full Disk Access on macOS. Without it, macOS (TCC) refuses tunelo and the AI
// sessions it starts the protected folders: Desktop, Documents, Downloads,
// iCloud Drive, other apps' data. For some of them it asks first, with a
// dialog on the machine's screen that nobody answers when the session runs
// from a device, so the session hangs.
//
// The probe reads the user's own TCC folder, which only a process with Full
// Disk Access may list. Unlike Desktop or Downloads, macOS never asks about
// it: it refuses outright, so probing shows no dialog.
import { spawn } from "node:child_process";
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

/** The steps for the machine's owner, in English for the terminal and the log. */
export function diskAccessSteps(binary: string): string[] {
  return [
    "tunelo needs Full Disk Access on this Mac, or its sessions cannot open Desktop, Documents,",
    "Downloads or iCloud Drive and may hang on a macOS prompt nobody answers. To grant it:",
    "  1. Open System Settings > Privacy & Security > Full Disk Access.",
    `  2. Click +, press Cmd+Shift+G, enter ${binary} and click Open; turn tunelo on.`,
    "  3. Run `tunelo stop` and then `tunelo start`.",
  ];
}

/** Opens Full Disk Access in System Settings; never throws (the steps say where it is anyway). */
export function openDiskAccessSettings(): void {
  try {
    const child = spawn("open", [FULL_DISK_ACCESS_SETTINGS], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The printed steps still say where the setting is.
  }
}

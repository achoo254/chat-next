// What `tunelo login` does for the machine once the account is signed in
// (tunnels/cli-login-command.ts signs in): the background service runs and
// starts at login, and it, never this command, adds the machine to the
// account's "AI Agent" in Chat; this command only asks it to try now and
// waits until Chat lists the machine. Running it again on a connected
// machine checks and reports: nothing is registered again, no secret changes.
//
// A machine that cannot run the service at all (Linux without a systemd user
// session) is told so before the sign-in, which then still serves tunnels.
import { ConfigStore } from "../config.ts";
import { CHAT_SERVER } from "../machine-api.ts";
import { callControl } from "../control-socket.ts";
import type { AppsReport } from "../registration-status.ts";
import { type DiskAccess, diskAccessSteps, openDiskAccessSettings } from "../safety/disk-access.ts";
import { checkServiceSupport, installService, keepRunningLoggedOut } from "../service.ts";

/** How long `tunelo login` waits for Chat to list the machine. */
export const CONNECT_WAIT_MS = 60_000;
/** How long the service just installed may take to answer. */
const START_WAIT_MS = 30_000;
const POLL_MS = 1_000;

/** What setting up the machine touches outside the config; tests replace it. */
export interface MachineSetupDeps {
  /** Throws when this machine cannot run the background service. */
  checkService: () => Promise<void>;
  isRunning: (dir: string) => Promise<boolean>;
  /** Registers the service to start at login and starts it; answers where. */
  installService: (dir: string) => Promise<string>;
  /** Asks the running service to add the machine to Chat now. */
  retryRegistration: (dir: string, signedInNow: boolean) => Promise<void>;
  /** Where the running service stands with each app; undefined while it does not answer. */
  apps: (dir: string) => Promise<AppsReport | undefined>;
  /** The machine's name as the running service reports it. */
  machineName: (dir: string) => Promise<string>;
  /** Linux: the command still needed so the service runs while nobody is logged in, or null. */
  keepRunningLoggedOut: () => Promise<string | null>;
  /** What macOS lets the started service open; "not-applicable" off macOS or when it does not answer. */
  serviceDiskAccess: (dir: string) => Promise<DiskAccess>;
  openDiskAccessSettings: (binary: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Asks the service just started, for up to 15 s, whether it has Full Disk Access. */
async function askServiceDiskAccess(dir: string): Promise<DiskAccess> {
  if (process.platform !== "darwin") return "not-applicable";
  for (const end = Date.now() + 15_000; Date.now() < end; ) {
    const status = (await callControl(dir, "GET", "/status").catch(() => undefined)) as { fullDiskAccess?: unknown } | undefined;
    const access = status?.fullDiskAccess;
    if (access === "granted" || access === "needed" || access === "not-applicable") return access;
    await sleep(500);
  }
  // A service still starting: show the steps anyway.
  return "needed";
}

export const defaultMachineSetupDeps: MachineSetupDeps = {
  checkService: checkServiceSupport,
  isRunning: (dir) =>
    callControl(dir, "GET", "/status").then(
      () => true,
      () => false,
    ),
  installService: (dir) => installService(dir),
  retryRegistration: async (dir, signedInNow) => {
    await callControl(dir, "POST", "/registration/retry", { signedInNow });
  },
  apps: (dir) => callControl(dir, "GET", "/apps").then((r) => r as AppsReport, () => undefined),
  machineName: (dir) =>
    callControl(dir, "GET", "/status").then(
      (r) => {
        const name = (r as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
      },
      () => "",
    ),
  keepRunningLoggedOut,
  serviceDiskAccess: askServiceDiskAccess,
  openDiskAccessSettings,
  sleep,
  now: Date.now,
  log: (line) => console.log(line),
};

/** Why this machine cannot run the background service, or null when it can. */
export async function serviceProblem(deps: Pick<MachineSetupDeps, "checkService"> = defaultMachineSetupDeps): Promise<string | null> {
  try {
    await deps.checkService();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The address of AI Agent in Chat. */
export function chatAgentUrl(server = CHAT_SERVER): string {
  return new URL("/ai", server).toString();
}

/**
 * After the sign-in: the service runs (installed now when it is not), adds
 * the machine to Chat by itself, and this waits up to a minute for that.
 * `signedInNow`: a new sign-in happened, so a machine removed on the web may
 * be added again. Resolves with the exit code.
 */
export async function connectMachine(dir: string, opts: { signedInNow: boolean }, deps: MachineSetupDeps = defaultMachineSetupDeps): Promise<number> {
  if (!(await deps.isRunning(dir))) {
    // Nothing else writes the config while the service is not running.
    if (opts.signedInNow && new ConfigStore(dir).get().machineRemoved) new ConfigStore(dir).update((c) => delete c.machineRemoved);
    const where = await deps.installService(dir);
    deps.log(`  tunelo runs in the background and starts at login (${where}).`);
    let up = false;
    for (const end = deps.now() + START_WAIT_MS; !up && deps.now() < end; ) {
      await deps.sleep(POLL_MS);
      up = await deps.isRunning(dir);
    }
    if (!up) {
      deps.log("  The background service did not answer yet; `tunelo status` shows when this machine is in AI Agent.");
      return 1;
    }
  }
  await deps.retryRegistration(dir, opts.signedInNow).catch(() => undefined);

  const chat = await waitForChat(dir, deps);
  await hints(dir, deps);
  if (chat?.status === "ok") {
    const name = await deps.machineName(dir);
    deps.log(`  ✓ Connected this machine${name ? ` (${name})` : ""}. Open ${chatAgentUrl()} to use it.`);
    return 0;
  }
  deps.log(`  This machine is not in AI Agent yet: ${chat?.detail ?? "the background service does not answer"}.`);
  deps.log("  `tunelo status` shows where it stands.");
  return 1;
}

/** Chat's state once it is settled (in AI Agent, or a reason no wait helps), or the last one seen. */
async function waitForChat(dir: string, deps: MachineSetupDeps): Promise<AppsReport["chat"] | undefined> {
  let last: AppsReport["chat"] | undefined;
  for (const end = deps.now() + CONNECT_WAIT_MS; ; ) {
    last = (await deps.apps(dir))?.chat ?? last;
    if (last && last.status !== "waiting" && (last.status !== "error" || last.retryAt === undefined)) return last;
    // An error that will be tried again soon may still pass within the wait.
    if (last?.status === "error" && last.retryAt !== undefined && last.retryAt > end) return last;
    if (deps.now() >= end) return last;
    await deps.sleep(POLL_MS);
  }
}

/** Running while logged out (Linux linger) and Full Disk Access (macOS) are the owner's to grant: shown, not forced. */
async function hints(dir: string, deps: MachineSetupDeps): Promise<void> {
  const lingerCommand = await deps.keepRunningLoggedOut().catch(() => null);
  // The install script shows these steps itself, in the page's language.
  if (process.env.TUNELO_DISK_ACCESS_HINT === "script") return;
  if (lingerCommand !== null) {
    deps.log(`  tunelo runs while you are logged in. To keep it running after you log out or the machine restarts, run once: ${lingerCommand}`);
  }
  if ((await deps.serviceDiskAccess(dir)) === "needed") {
    deps.openDiskAccessSettings(process.execPath);
    for (const line of diskAccessSteps(process.execPath, true)) deps.log(`  ${line}`);
  }
}

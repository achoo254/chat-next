// `tunelo install --trust <device key>`, run by the install script that the
// Chat page "Add this machine" shows: keeps the pairing secret (stdin only)
// for the first handshake of that browser, signs in with the account
// (`tunelo login`: tunnel, Chat and Localman at once) and starts the
// background service at login. The service then adds the machine to the
// account's "AI Agent" by itself; no install code is involved. The
// pairing stays end to end: the secret never leaves this machine.
//
// Nothing changes until the sign-in succeeded: an abandoned or refused
// sign-in leaves the machine, its config and its running service as they
// were. Should installing the service fail after that, the previous config
// comes back and the service is started again.
import type { Command } from "commander";
import { type AgentConfig, ConfigStore, configDir } from "../config.ts";
import { callControl } from "../control-socket.ts";
import { machineKey } from "../keystore.ts";
import { type DiskAccess, diskAccessSteps, openDiskAccessSettings } from "../safety/disk-access.ts";
import { installService, startService, stopService } from "../service.ts";
import { TUNNEL_SERVER } from "../tunnel.ts";
import { signInForServer } from "../tunnels/cli-login-command.js";

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** First line of stdin. The installer pipes exactly one line and closes it. */
async function readLine(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += Buffer.from(chunk as Uint8Array).toString("utf8");
    if (data.includes("\n")) break;
  }
  // PowerShell may prefix piped text with a byte order mark.
  return (data.split(/\r?\n/)[0] ?? "").replace(/^\uFEFF/, "");
}

/** What installing touches outside the config; tests replace it. */
export interface InstallDeps {
  readSecret: () => Promise<string>;
  signIn: () => Promise<unknown>;
  isRunning: (dir: string) => Promise<boolean>;
  stopService: (dir: string) => Promise<void>;
  startService: (dir: string) => Promise<void>;
  installService: (dir: string) => Promise<string>;
  ensureMachineKey: (dir: string) => Promise<unknown>;
  /** What macOS lets the started service open; "not-applicable" off macOS or when it does not answer. */
  serviceDiskAccess: (dir: string) => Promise<DiskAccess>;
  openDiskAccessSettings: (binary: string) => void;
  log: (line: string) => void;
}

/** Asks the service just started, for up to 15 s, whether it has Full Disk Access. */
async function askServiceDiskAccess(dir: string): Promise<DiskAccess> {
  if (process.platform !== "darwin") return "not-applicable";
  for (const end = Date.now() + 15_000; Date.now() < end; ) {
    const status = (await callControl(dir, "GET", "/status").catch(() => undefined)) as { fullDiskAccess?: unknown } | undefined;
    const access = status?.fullDiskAccess;
    if (access === "granted" || access === "needed" || access === "not-applicable") return access;
    await new Promise((r) => setTimeout(r, 500));
  }
  // An older service, or one still starting: show the steps anyway.
  return "needed";
}

const defaultDeps: InstallDeps = {
  readSecret: readLine,
  signIn: () => signInForServer(TUNNEL_SERVER),
  isRunning: (dir) =>
    callControl(dir, "GET", "/status").then(
      () => true,
      () => false,
    ),
  stopService,
  startService,
  installService,
  ensureMachineKey: machineKey,
  serviceDiskAccess: askServiceDiskAccess,
  openDiskAccessSettings,
  log: (line) => console.log(line),
};

export async function install(dir: string, options: { trust?: string }, deps: InstallDeps = defaultDeps): Promise<void> {
  const trust = options.trust ?? "";
  if (!KEY_RE.test(trust)) throw new Error("usage: tunelo install --trust <device key> (pairing secret on stdin)");
  const secret = (await deps.readSecret()).trim();
  if (!KEY_RE.test(secret)) throw new Error("the pairing secret must come on stdin");

  // First the sign-in, while everything else stays as it is.
  await deps.signIn();
  deps.log("Signed in.");

  // The running service owns the config: stop it before changing it.
  const wasRunning = await deps.isRunning(dir);
  if (wasRunning) {
    await deps.stopService(dir);
    for (const end = Date.now() + 15_000; Date.now() < end && (await deps.isRunning(dir)); ) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const config = new ConfigStore(dir);
  const previous: AgentConfig = structuredClone(config.get());
  try {
    await deps.ensureMachineKey(dir);
    // "Add this machine" adds a new machine, as each install always did: the
    // service registers it again, and the browser that showed the command
    // pairs through the secret.
    config.update((c) => {
      c.install = { deviceKey: trust, secret };
      delete c.machineId;
      delete c.machineSecret;
      delete c.claimed;
      delete c.machineRemoved;
    });
    const where = await deps.installService(dir);
    deps.log(`tunelo will start at login (${where}); this machine appears in AI Agent in a moment. You can close this window.`);
  } catch (err) {
    // Only the install and the machine's place changed: put them back.
    config.update((c) => {
      Object.assign(c, previous);
      if (previous.install === undefined) delete c.install;
    });
    if (wasRunning) await deps.startService(dir).catch(() => undefined);
    throw err;
  }
  // The machine is installed; Full Disk Access is the owner's to grant, so a
  // missing one only shows the way to it.
  // install.sh shows this step itself, in the page's language.
  if (process.env.TUNELO_DISK_ACCESS_HINT === "script") return;
  if ((await deps.serviceDiskAccess(dir)) === "needed") {
    for (const line of diskAccessSteps(process.execPath)) deps.log(line);
    deps.openDiskAccessSettings(process.execPath);
  }
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description("add this machine to AI Agent: sign in, pair the browser that showed the command (secret on stdin), start at login")
    .requiredOption("--trust <device key>", "the device that pairs first")
    .action(async (options: { trust?: string }) => {
      await install(configDir(), options);
      process.exit(0);
    });
}

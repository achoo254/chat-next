#!/usr/bin/env node
// tunelo: the one process of the ecosystem on the user's machine. Tunnels to
// localhost (the commands of the Tunelo CLI 1.x: http, tcp, login, whoami,
// link, watch, mcp…), and, as a background service, lets the user's own
// devices drive the AI coding CLI installed here, end-to-end encrypted.
import { Command } from "commander";
import { ConfigStore, configDir } from "./config.ts";
import { callControl, controlPid, serveControl } from "./control-socket.ts";
import { registerLocalForwardCommand } from "./commands/config.ts";
import { registerMcpLocalWritesCommand } from "./commands/mcp-local-writes.ts";
import { registerAuthenticatorCommand } from "./commands/authenticator.ts";
import { registerInstallCommand } from "./commands/install.ts";
import { registerProfilesCommand } from "./commands/profiles.ts";
import { registerSecretsCommand } from "./commands/secrets.ts";
import { registerBrowserCommand } from "./commands/browser.ts";
import { importLegacySignIns } from "./identity/legacy-import.ts";
import { Machine } from "./machine.ts";
import { logFile, tailLog } from "./log-tail.ts";
import { registerMcpCommand } from "./mcp/cli-mcp-command.js";
import { McpHost } from "./mcp/mcp-host.js";
import { goOnline } from "./online.ts";
import { startService, stopService, uninstallService } from "./service.ts";
import { diskAccess, diskAccessSteps } from "./safety/disk-access.ts";
import { dropInheritedMarkers } from "./startup-env.ts";
import { registerConfigCommand } from "./tunnels/cli-config-command.ts";
import { registerHttpCommand } from "./tunnels/cli-http-command.js";
import { registerLinkCommands } from "./tunnels/cli-link-command.js";
import { registerLoginCommands } from "./tunnels/cli-login-command.js";
import { registerKillCommand, tunnelRunLines } from "./tunnels/cli-status-commands.js";
import { registerTcpCommand } from "./tunnels/cli-tcp-command.js";
import { registerWatchCommand } from "./tunnels/cli-watch-command.js";
import { registerWhoamiCommand } from "./tunnels/cli-whoami-command.js";
import { Display } from "./tunnels/display.js";
import { TunnelService } from "./tunnels/tunnel-service.ts";
import { checkForUpdate, rollback, update } from "./update.ts";
import { AGENT_VERSION } from "./version.ts";
import type { SecretService } from "./sign-in-secrets/secret-service.ts";
import type { RemoteBrowser } from "./remote-browser/remote-browser.ts";

const log = (line: string) => console.log(line);

/** The pid of the agent answering on the control channel, or null when none does. */
async function runningPid(dir: string): Promise<number | null> {
  try {
    await callControl(dir, "GET", "/status");
  } catch {
    return null;
  }
  return controlPid(dir) ?? 0;
}

async function waitRunning(dir: string, ms: number): Promise<number | null> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    const pid = await runningPid(dir);
    if (pid !== null) return pid;
  }
  return null;
}

/**
 * Runs the agent in this process until it is stopped. Refuses while an agent
 * answers in this folder, so one machine never runs two.
 */
async function runAgent(dir: string, args: string[]): Promise<number> {
  const running = await runningPid(dir);
  if (running !== null) throw new Error(`tunelo is already running (pid ${running}, ${dir}); \`tunelo stop\` stops it`);
  await importLegacySignIns(dir);
  const config = new ConfigStore(dir);
  // A session's writes need the device's approval, except in bypassPermissions (set on the machine only).
  let sessionMode: (threadId: string) => string | undefined = () => undefined;
  let secrets: () => SecretService | undefined = () => undefined;
  let browser: () => RemoteBrowser | undefined = () => undefined;
  const mcp = new McpHost(dir, {
    log,
    enabledGroups: () => config.get().mcpGroups,
    sessionMode: (threadId) => sessionMode(threadId),
    secrets: () => secrets(),
    browser: () => browser(),
  });
  const machine = new Machine({ config, mcp });
  secrets = () => machine.secrets;
  browser = () => machine.browser;
  sessionMode = (threadId) => machine.core.permissionMode(threadId);
  const portIndex = args.indexOf("--port");
  const portArg = portIndex >= 0 ? args[portIndex + 1] : undefined;
  const port = await machine.start(portArg ? Number(portArg) : undefined);
  const tunnels = new TunnelService(dir);
  const online = goOnline(machine, port, log);
  const stopControl = serveControl({ dir, machine, registration: online.registration, tunnels, mcp });
  const shutdown = async () => {
    online.stop();
    tunnels.closeAll("closed because tunelo stopped");
    mcp.endAll();
    stopControl();
    await machine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return new Promise(() => undefined);
}

/** Runs a short command and exits with its code. */
function exits<A extends unknown[]>(run: (...args: A) => Promise<number>): (...args: A) => Promise<void> {
  return async (...args) => process.exit(await run(...args));
}

async function printJson(path: string): Promise<number> {
  console.log(JSON.stringify(await callControl(configDir(), "GET", path), null, 2));
  return 0;
}

/**
 * `tunelo status`: exit 1 when the background service is not running (the
 * Windows restart loop relies on it). For a person at a terminal, the
 * tunnels of this machine come first; with `--json` or when the output goes
 * to a program, only the service's JSON, as before.
 */
async function status(options: { json?: boolean }): Promise<number> {
  const dir = configDir();
  const forPeople = !options.json && process.stdout.isTTY === true;
  if (forPeople) for (const line of tunnelRunLines()) console.log(line);
  let service: unknown;
  try {
    service = await callControl(dir, "GET", "/status");
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  if (!forPeople) {
    console.log(JSON.stringify(service, null, 2));
    return 0;
  }
  const held = (await callControl(dir, "GET", "/tunnels").catch(() => ({ mcp: [] }))) as { mcp?: { id: string; protocol: string; url: string; localPort: number }[] };
  for (const t of held.mcp ?? []) console.log(`MCP ${t.id}  [${t.protocol}]  ${t.url} → :${t.localPort}`);
  console.log("Background service:");
  console.log(JSON.stringify(service, null, 2));
  if ((service as { fullDiskAccess?: unknown }).fullDiskAccess === "needed") {
    console.log("");
    for (const line of diskAccessSteps(process.execPath, false)) console.log(line);
  }
  return 0;
}

/** Shows download progress: one rewritten line on a terminal, a line per quarter when output is piped. */
function downloadProgressPrinter(): (received: number, total: number) => void {
  const mb = (n: number) => (n / 1_048_576).toFixed(1);
  const live = process.stdout.isTTY;
  let lastQuarter = -1;
  return (received, total) => {
    const percent = total > 0 ? Math.floor((received / total) * 100) : -1;
    const text = percent >= 0 ? `  ${percent}% (${mb(received)} / ${mb(total)} MB)` : `  ${mb(received)} MB`;
    if (live) {
      process.stdout.write(`\r${text}${total > 0 && received >= total ? "\n" : ""}`);
    } else if (percent >= 0 && Math.floor(percent / 25) > lastQuarter) {
      lastQuarter = Math.floor(percent / 25);
      console.log(text);
    }
  };
}

async function updateCommand(options: { check?: boolean; rollback?: boolean }): Promise<number> {
  if (options.check && options.rollback) {
    console.error("tunelo update: use --check or --rollback, not both.");
    return 1;
  }
  if (options.rollback) {
    const previous = await rollback((l) => console.log(l));
    await callControl(configDir(), "POST", "/restart").catch(() => undefined);
    console.log(`Rolled back to ${previous}. Open terminals keep running; new ones use the terminal process of ${previous} once none is open.`);
    return 0;
  }
  if (options.check) {
    const latest = await checkForUpdate();
    console.log(latest ? `Update available: ${AGENT_VERSION} → ${latest}. Run \`tunelo update\` to install it.` : `tunelo ${AGENT_VERSION} is the newest.`);
    return 0;
  }
  const v = await update((l) => console.log(l), downloadProgressPrinter());
  if (!v) {
    console.log(`tunelo ${AGENT_VERSION} is the newest.`);
    return 0;
  }
  // The service supervisor (launchd / logon task loop) starts the new file.
  await callControl(configDir(), "POST", "/restart").catch(() => undefined);
  if (v === AGENT_VERSION) {
    // Same version: only its missing terminal process was installed.
    console.log(`tunelo ${v} is the newest; installed its terminal process.`);
    return 0;
  }
  console.log(`Updated to ${v}. Restart any \`tunelo http\` or \`tunelo tcp\` you started yourself to run it.`);
  return 0;
}

async function start(): Promise<number> {
  const dir = configDir();
  const running = await runningPid(dir);
  if (running !== null) {
    console.log(`tunelo is already running in the background (pid ${running}).`);
  } else {
    await startService(dir);
    const pid = await waitRunning(dir, 30_000);
    console.log(pid === null ? "tunelo is starting; check `tunelo status` in a moment." : `tunelo is running in the background (pid ${pid}). You can close this terminal.`);
  }
  return 0;
}

async function logs(options: { lines: string; follow?: boolean }): Promise<void> {
  const n = Number(options.lines);
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  await tailLog(logFile(configDir()), { lines: Number.isFinite(n) ? n : 50, follow: options.follow === true, write: (s) => process.stdout.write(s), signal: stop.signal });
  process.exit(0);
}

async function setTrust(dir: string | undefined, trusted: boolean): Promise<number> {
  console.log(JSON.stringify(await callControl(configDir(), "POST", "/trust", { dir: dir ?? process.cwd(), trusted: trusted ? "true" : "false" })));
  return 0;
}

function buildProgram(): Command {
  const program = new Command();
  const display = new Display();
  program
    .name("tunelo")
    .version(AGENT_VERSION)
    .description("Tunnels to localhost, and your own devices driving the AI coding CLI of this machine, end-to-end encrypted")
    .hook("preAction", async () => {
      // Older installs left their sign-ins in plain text; move them under the key store once.
      await importLegacySignIns(configDir()).catch((err: Error) => console.error(`tunelo: could not move the earlier sign-in yet (${err.message})`));
    });

  // The background service and this machine in AI Agent.
  registerInstallCommand(program);
  program.command("start").description("run in the background (keeps running after the terminal closes)").action(exits(start));
  program
    .command("stop")
    .description("stop the background service until tunelo start or the next login")
    .action(
      exits(async () => {
        await stopService(configDir());
        console.log("tunelo stopped. `tunelo start` starts it again; it also starts at the next login.");
        return 0;
      }),
    );
  program
    .command("uninstall")
    .description("stop starting at login")
    .action(
      exits(async () => {
        await uninstallService(configDir());
        console.log("tunelo no longer starts at login. Remove the machine on the web to forget it there.");
        return 0;
      }),
    );
  program
    .command("update")
    .description("install the newest signed release and restart")
    .option("--check", "Only report whether an update exists")
    .option("--rollback", "Put back the release the last update replaced (signatures checked again), then restart")
    .action(exits(updateCommand));
  program
    .command("run")
    .description("run in this terminal only (closing it stops tunelo)")
    .option("--port <n>", "local port of the device link")
    .action(async (options: { port?: string }) => {
      await runAgent(configDir(), options.port ? ["--port", options.port] : []);
    });
  program
    .command("status")
    .description("show the tunnels of this machine, and machine, AI and session status")
    .option("--json", "only the status of the background service, as JSON (also when the output is not a terminal)")
    .action(exits(status));
  program
    .command("logs")
    .description("show the last lines of the log")
    .option("-n, --lines <count>", "how many lines", "50")
    .option("-f, --follow", "keep following it")
    .action(logs);
  const devices = program.command("devices").description("list or revoke paired devices");
  devices.command("list", { isDefault: true }).description("list paired devices").action(exits(() => printJson("/devices")));
  devices
    .command("revoke <key>")
    .description("revoke a paired device (first characters of its key)")
    .action(
      exits(async (key: string) => {
        console.log(JSON.stringify(await callControl(configDir(), "POST", "/devices/revoke", { key })));
        return 0;
      }),
    );
  program.command("audit").description("show the consent log").action(exits(() => printJson("/audit")));
  program
    .command("trust [dir]")
    .description("let a folder's own .claude settings load (default: current folder)")
    .action(exits((dir: string | undefined) => setTrust(dir, true)));
  program
    .command("untrust [dir]")
    .description("stop loading that folder's .claude settings")
    .action(exits((dir: string | undefined) => setTrust(dir, false)));
  program.command("trusted").description("list trusted folders").action(exits(() => printJson("/trust")));
  registerProfilesCommand(program, exits);
  registerAuthenticatorCommand(program, exits);
  registerSecretsCommand(program, exits);
  registerBrowserCommand(program, exits);
  // The running service asks a new copy of itself whether macOS granted Full Disk Access.
  program
    .command("disk-access", { hidden: true })
    .description("print whether this process has Full Disk Access (granted, needed, not-applicable)")
    .action(() => console.log(diskAccess()));
  program
    .command("version")
    .description("print the version")
    .action(() => console.log(AGENT_VERSION));

  // Tunnels: the commands of the Tunelo CLI 1.x.
  registerHttpCommand(program, display);
  registerTcpCommand(program, display);
  registerLoginCommands(program);
  registerWhoamiCommand(program);
  registerLinkCommands(program);
  registerMcpCommand(program);
  registerKillCommand(program);
  registerWatchCommand(program);
  const configCommand = registerConfigCommand(program);
  registerLocalForwardCommand(configCommand, exits);
  registerMcpLocalWritesCommand(configCommand, exits);
  return program;
}

dropInheritedMarkers();

// No command: the help, exit 0 (as before commander).
if (process.argv.length <= 2) {
  buildProgram().outputHelp();
  process.exit(0);
}
buildProgram()
  .parseAsync(process.argv)
  .catch((err: Error) => {
    console.error(`tunelo: ${err.message}`);
    process.exit(1);
  });

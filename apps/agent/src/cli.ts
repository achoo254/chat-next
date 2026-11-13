#!/usr/bin/env node
// tunelo: the one process of the ecosystem on the user's machine. As a
// background service it lets the devices of the user's account drive the AI
// coding CLI installed here, end-to-end encrypted; it also opens tunnels to
// localhost (http, tcp, kill, watch). `tunelo login` connects the machine,
// `tunelo logout` takes it out of the account, `tunelo uninstall` removes it.
import { Command } from "commander";
import { configureGroupedHelp } from "./cli-help.ts";
import { ConfigStore, configDir } from "./config.ts";
import { callControl, controlPid, serveControl } from "./control-socket.ts";
import { registerLocalForwardCommand } from "./commands/config.ts";
import { logout } from "./commands/logout.ts";
import { registerMcpLocalWritesCommand } from "./commands/mcp-local-writes.ts";
import { status } from "./commands/status.ts";
import { uninstall } from "./commands/uninstall.ts";
import { importLegacySignIns } from "./identity/legacy-import.ts";
import { Machine } from "./machine.ts";
import { logFile, tailLog } from "./log-tail.ts";
import { registerMcpCommand } from "./mcp/cli-mcp-command.js";
import { McpHost } from "./mcp/mcp-host.js";
import { goOnline } from "./online.ts";
import { startService, stopService } from "./service.ts";
import { diskAccess } from "./safety/disk-access.ts";
import { dropInheritedMarkers } from "./startup-env.ts";
import { registerConfigCommand } from "./tunnels/cli-config-command.ts";
import { registerHttpCommand } from "./tunnels/cli-http-command.js";
import { registerLoginCommand } from "./tunnels/cli-login-command.js";
import { registerKillCommand } from "./tunnels/cli-status-commands.js";
import { registerTcpCommand } from "./tunnels/cli-tcp-command.js";
import { registerWatchCommand } from "./tunnels/cli-watch-command.js";
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
  // A session's writes need the device's approval, except in its AI's bypass mode (set on the machine only).
  let sessionBypassed: (threadId: string) => boolean = () => false;
  let secrets: () => SecretService | undefined = () => undefined;
  let browser: () => RemoteBrowser | undefined = () => undefined;
  const mcp = new McpHost(dir, {
    log,
    enabledGroups: () => config.get().mcpGroups,
    sessionBypassed: (threadId) => sessionBypassed(threadId),
    secrets: () => secrets(),
    browser: () => browser(),
  });
  const machine = new Machine({ config, mcp });
  secrets = () => machine.secrets;
  browser = () => machine.browser;
  sessionBypassed = (threadId) => machine.core.bypassed(threadId);
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

export function buildProgram(): Command {
  const program = new Command();
  const display = new Display();
  program
    .name("tunelo")
    .version(AGENT_VERSION)
    .description("Your account's devices driving the AI coding CLI of this machine, end-to-end encrypted; and tunnels to localhost")
    .hook("preAction", async () => {
      // Older installs left their sign-ins in plain text; move them under the key store once.
      await importLegacySignIns(configDir()).catch((err: Error) => console.error(`tunelo: could not move the earlier sign-in yet (${err.message})`));
    });
  configureGroupedHelp(program);

  // The machine.
  registerLoginCommand(program);
  program
    .command("logout")
    .description("take this machine out of your account: Chat, Localman, the background service and the sign-in (keeps the binary)")
    .option("-f, --force", "without the network, forget the machine on this side anyway")
    .action(exits((options: { force?: boolean }) => logout(configDir(), { force: options.force === true })));
  program
    .command("status")
    .description("show the account, this machine in AI Agent, the background service and the tunnels")
    .option("--json", "as JSON (also when the output is not a terminal)")
    .action(exits(status));
  program
    .command("update")
    .description("install the newest signed release and restart")
    .option("--check", "Only report whether an update exists")
    .option("--rollback", "Put back the release the last update replaced (signatures checked again), then restart")
    .action(exits(updateCommand));
  program
    .command("uninstall")
    .description("log out, then remove tunelo from this machine: service, settings, keys, PATH entry and binary")
    .action(exits(() => uninstall(configDir())));
  program
    .command("logs")
    .description("show the last lines of the log")
    .option("-n, --lines <count>", "how many lines", "50")
    .option("-f, --follow", "keep following it")
    .action(logs);

  // Kept off the help: the service's own controls, and what only a person at
  // this machine may change (never offered to the AI or the web).
  program.command("start", { hidden: true }).description("run in the background (keeps running after the terminal closes)").action(exits(start));
  program
    .command("stop", { hidden: true })
    .description("stop the background service until tunelo login or the next login")
    .action(
      exits(async () => {
        await stopService(configDir());
        console.log("tunelo stopped. `tunelo login` starts it again; it also starts at the next login.");
        return 0;
      }),
    );
  program
    .command("run", { hidden: true })
    .description("run in this terminal only (closing it stops tunelo)")
    .option("--port <n>", "local port of the device link")
    .action(async (options: { port?: string }) => {
      await runAgent(configDir(), options.port ? ["--port", options.port] : []);
    });
  program
    .command("trust [dir]", { hidden: true })
    .description("let a folder's own .claude settings load (default: current folder)")
    .action(exits((dir: string | undefined) => setTrust(dir, true)));
  program
    .command("untrust [dir]", { hidden: true })
    .description("stop loading that folder's .claude settings")
    .action(exits((dir: string | undefined) => setTrust(dir, false)));
  program.command("trusted", { hidden: true }).description("list trusted folders").action(exits(() => printJson("/trust")));
  // The running service asks a new copy of itself whether macOS granted Full Disk Access.
  program
    .command("disk-access", { hidden: true })
    .description("print whether this process has Full Disk Access (granted, needed, not-applicable)")
    .action(() => console.log(diskAccess()));
  registerMcpCommand(program);

  // Tunnels.
  registerHttpCommand(program, display);
  registerTcpCommand(program, display);
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

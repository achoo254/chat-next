// `tunelo observatory …`: Observatory's commands on this machine.
// - install / uninstall: its hooks and OpenTelemetry settings in Claude
//   Code's settings.json, for the sessions started outside tunelo
//   (observatory/install/observatory-install.ts); install asks first, in a
//   terminal;
// - status, export, delete, content, rotate-token (observatory-actions.ts);
// - thresholds: the bottleneck rules' thresholds (observatory-thresholds.ts);
// - ci: the switch of the CI watcher (observatory-ci.ts);
// - hook <event> (hidden): what an installed hook runs. It reads the
//   payload, filters it and appends one line to the spool, nothing else: no
//   sign-in import, no key store, no network (cli.ts lets it skip its
//   preAction), and it exits within its deadline whatever happens.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { ConfigStore, configDir } from "../config.ts";
import { callControl, controlAnswers } from "../control-socket.ts";
import { checkManagedSettings } from "../observatory/install/managed-settings-check.ts";
import { type InstallDeps, type SettingsTarget, installObservatory, uninstallObservatory } from "../observatory/install/observatory-install.ts";
import { machineAccountNames } from "../observatory/privacy/home-and-account.ts";
import { TokenUnreadable, loadOrCreateTokens } from "../observatory/receiver/receiver-token.ts";
import { observatoryDataDir } from "../observatory/spool/observatory-data-dir.ts";
import { runObservatoryHook } from "../observatory/spool/run-observatory-hook.ts";
import { syncProfileConfig } from "../providers/claude/accounts/config-sync.ts";
import { defaultClaudeHome, profilesRoot } from "../providers/claude/accounts/paths.ts";
import { claudeHomesIn, findClaude } from "../providers/claude/index.ts";
import { AuditLog } from "../safety/audit-log.ts";
import { createSensitiveCheck } from "../safety/sensitive-paths.ts";
import { selfCommand } from "../service.ts";
import { repoKeyOf } from "../usage/repo-key.ts";
import {
  type ObservatoryCliDeps,
  observatoryContentCommand,
  observatoryDeleteCommand,
  observatoryExportCommand,
  observatoryRotateCommand,
  observatoryStatusCommand,
} from "./observatory-actions.ts";
import { type Terminal, processTerminal } from "./mcp-local-writes.ts";
import { registerObservatoryCiCommand } from "./observatory-ci.ts";
import { registerObservatoryThresholdsCommand } from "./observatory-thresholds.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

/** What `observatory install` made in settings.json, in the Observatory data folder (install-state-file.ts). */
const INSTALL_STATE_FILE = "install-state.json";

/** `inner` is `outer` or a folder inside it (case-insensitive on Windows). */
function isInside(inner: string, outer: string, platform: NodeJS.Platform): boolean {
  const fold = (p: string): string => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(fold(outer), fold(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The machine's Claude folder, whose settings.json the install changes: the
 * one CLAUDE_CONFIG_DIR names when the user set it, but never a tunelo profile's
 * home. A command run in a session of a profile (an AI's shell there) inherits
 * CLAUDE_CONFIG_DIR pointing at that profile; the agent's own service runs
 * without it, on ~/.claude, and the profiles copy that.
 */
export function machineClaudeHome(configDir: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  const machine = join(home, ".claude");
  if (!env.CLAUDE_CONFIG_DIR) return machine;
  const chosen = defaultClaudeHome(env);
  return isInside(chosen, profilesRoot(configDir), platform) ? machine : chosen;
}

export type SettingsTargetOptions = { env?: NodeJS.ProcessEnv; home?: string; dataDir?: string };

/** The machine's Claude settings and the profiles that copy them. */
export function claudeSettingsTarget(dir: string, print: (line: string) => void, opts: SettingsTargetOptions = {}): SettingsTarget {
  const claudeHome = machineClaudeHome(dir, opts.env, opts.home);
  return {
    claudeHome,
    // Every profile's home (claudeHomesIn lists the folder CLAUDE_CONFIG_DIR names first, then each profile).
    profileHomes: () => claudeHomesIn(dir).slice(1).filter((h) => !isInside(h, claudeHome, process.platform)),
    syncProfile: (home) => syncProfileConfig(home, claudeHome),
    stateFile: join(opts.dataDir ?? observatoryDataDir(), INSTALL_STATE_FILE),
    print,
  };
}

function cliDeps(term: Terminal): ObservatoryCliDeps {
  const dir = configDir();
  return {
    dir,
    dataDir: observatoryDataDir(),
    settings: claudeSettingsTarget(dir, (line) => term.print(line)),
    call: (method, path, input) => callControl(dir, method, path, input),
    running: () => controlAnswers(dir),
    term,
    now: Date.now,
  };
}

const run = promisify(execFile);

async function claudeVersion(): Promise<string | undefined> {
  const bin = await findClaude();
  if (!bin) return undefined;
  return run(bin, ["--version"], { timeout: 15_000, windowsHide: true }).then(
    (r) => r.stdout,
    () => undefined,
  );
}

/** The receiver's port (picked by the agent at its first start) and token; rejects with what to do when there is none. */
async function otlpClient(dir: string, dataDir: string): Promise<{ port: number; token: string }> {
  const config = new ConfigStore(dir).get().observatory;
  if (config?.enabled === false) throw new Error("Observatory is off in tunelo's settings.");
  const port = config?.otlpPort;
  if (port === undefined) throw new Error("tunelo has not picked the port of its receiver yet: start tunelo (`tunelo login`), then run this again.");
  try {
    return { port, token: (await loadOrCreateTokens(dataDir)).current };
  } catch (err) {
    if (err instanceof TokenUnreadable) throw new Error("the receiver's token file cannot be read: `tunelo observatory rotate-token --replace-unreadable` makes a new one.", { cause: err });
    throw err;
  }
}

async function confirmInTerminal(term: Terminal, change: readonly string[]): Promise<boolean> {
  for (const line of change) term.print(line);
  if (!term.interactive) {
    term.printError("tunelo: installing Observatory changes Claude Code's settings for every session on this machine: run `tunelo observatory install` yourself in a terminal and type yes when asked.");
    return false;
  }
  return (await term.ask('Type "yes" to change the file: ').catch(() => "")).trim().toLowerCase() === "yes";
}

export function installDeps(term: Terminal): InstallDeps {
  const dir = configDir();
  return {
    ...claudeSettingsTarget(dir, (line) => term.print(line)),
    hookCommand: selfCommand(),
    otlpClient: () => otlpClient(dir, observatoryDataDir()),
    claudeVersion,
    managed: () => checkManagedSettings(),
    env: process.env,
    confirm: (change) => confirmInTerminal(term, change),
    now: Date.now,
  };
}

async function install(term: Terminal): Promise<number> {
  const code = await installObservatory(installDeps(term));
  if (code === 0) new AuditLog(join(configDir(), "audit.jsonl")).write({ device: "local", action: "observatory_install", path: machineClaudeHome(configDir()), detail: "" });
  return code;
}

/** Takes Observatory out of Claude Code's settings (also run by `tunelo uninstall`). */
export async function uninstallObservatoryHooks(print: (line: string) => void): Promise<number> {
  const dir = configDir();
  const code = await uninstallObservatory(claudeSettingsTarget(dir, print));
  if (code === 0) new AuditLog(join(dir, "audit.jsonl")).write({ device: "local", action: "observatory_uninstall", path: machineClaudeHome(dir), detail: "" });
  return code;
}

/** `tunelo observatory hook <event>`: see the module comment. */
async function hook(event: string): Promise<void> {
  const home = homedir();
  await runObservatoryHook(event, {
    stdin: process.stdin,
    dataDir: observatoryDataDir(),
    home,
    isSensitive: createSensitiveCheck({ configDir: configDir() }),
    repoKey: repoKeyOf,
    accountNames: machineAccountNames(home),
  });
  // Ends a stdin read still pending; the hook never fails Claude Code (exit 0).
  process.exit(0);
}

export function registerObservatoryCommand(program: Command, exits: Exits): void {
  const observatory = program
    .command("observatory")
    .description("what Claude Code sessions on this machine did (timings, tools, tokens, cost), kept on this machine: install, status, export, delete, content");
  observatory
    .command("install")
    .description("report Claude Code sessions started outside tunelo too: adds tunelo's hooks and OpenTelemetry settings to the settings.json of your Claude folder (~/.claude, or the one CLAUDE_CONFIG_DIR names; asks first)")
    .action(exits(() => install(processTerminal())));
  observatory
    .command("uninstall")
    .description("take tunelo's hooks and OpenTelemetry settings out of every settings.json an install changed, leaving the rest as it was")
    .action(exits(() => uninstallObservatoryHooks((line) => console.log(line))));
  observatory
    .command("status")
    .description("whether it is installed, the receiver and its port, counts and the last event")
    .option("--json", "as JSON")
    .action(exits((options: { json?: boolean }) => observatoryStatusCommand(cliDeps(processTerminal()), options.json === true)));
  observatory
    .command("export <file>")
    .description("write everything stored to a JSON file")
    .option("-f, --force", "replace the file if it exists")
    .action(exits((file: string, options: { force?: boolean }) => observatoryExportCommand(cliDeps(processTerminal()), file, options.force === true)));
  observatory
    .command("delete")
    .description("delete everything stored and spooled (the settings stay)")
    .option("-y, --yes", "without asking")
    .action(exits((options: { yes?: boolean }) => observatoryDeleteCommand(cliDeps(processTerminal()), options.yes === true)));
  observatory
    .command("content <folder> <action>")
    .description("on or off: keep a redacted excerpt of prompts and tool content for the project of that folder (on by default)")
    .action(exits((folder: string, action: string) => observatoryContentCommand(cliDeps(processTerminal()), folder, action)));
  observatory
    .command("rotate-token")
    .description("a new token for the local receiver; the previous one keeps working until the next rotation")
    .option("--replace-unreadable", "replace a token file that cannot be read (sessions holding the old token stop reporting)")
    .action(exits((options: { replaceUnreadable?: boolean }) => observatoryRotateCommand(cliDeps(processTerminal()), options.replaceUnreadable === true)));
  registerObservatoryThresholdsCommand(observatory, exits, () => cliDeps(processTerminal()));
  registerObservatoryCiCommand(observatory, exits, () => cliDeps(processTerminal()));
  observatory.command("hook <event>", { hidden: true }).description("what an installed hook runs: one event from stdin to the spool").action(hook);
}

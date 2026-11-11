// The Linux supervisor of the background agent: a systemd user unit,
// ~/.config/systemd/user/tunelo.service, that runs `tunelo run`, starts it
// again whenever it exits (Restart=always, which `tunelo update` relies on)
// and appends its output to agent.log like launchd and the Windows loop do.
// A user unit lives in the user's own systemd manager: no root, no sudo.
// That manager runs while the user is logged in, or always once "linger" is
// on for the user; tunelo asks for linger without a password and otherwise
// prints the one command (with sudo) the owner can run for it.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const UNIT_NAME = "tunelo.service";

/** What the systemd backend touches outside its unit file; tests replace it. */
export interface SystemdHost {
  /** Runs a program; rejects like execFile (with `code` and `stderr`) when it fails or is missing. */
  run: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  /** True when systemd is the init system of this machine (sd_booted: /run/systemd/system exists). */
  booted: () => boolean;
  home: string;
  user: string;
  /** PATH of the process installing the unit; its folders are kept so the service finds the same `claude`. */
  path: string | undefined;
}

const execFileAsync = promisify(execFile);

/** The login name of a numeric user id in the text of /etc/passwd; undefined when it is not listed. */
export function nameFromPasswd(passwd: string, uid: number): string | undefined {
  for (const line of passwd.split("\n")) {
    const [name, , id] = line.split(":");
    if (name !== undefined && name !== "" && id === String(uid)) return name;
  }
  return undefined;
}

/**
 * The login name of this process's user. The passwd file answers by user id;
 * `os.userInfo` may read the environment instead and says "unknown" in a shell
 * that has no USER, which would put a wrong name in the `loginctl` command.
 */
function loginName(): string {
  const uid = process.getuid?.();
  if (uid !== undefined) {
    try {
      const listed = nameFromPasswd(readFileSync("/etc/passwd", "utf8"), uid);
      if (listed !== undefined) return listed;
    } catch {
      // No readable passwd file (a name service only): ask the OS below.
    }
  }
  return userInfo().username;
}

export function systemdHost(): SystemdHost {
  return {
    run: async (file, args) => {
      const { stdout, stderr } = await execFileAsync(file, [...args], { encoding: "utf8" });
      return { stdout, stderr };
    },
    booted: () => existsSync("/run/systemd/system"),
    home: homedir(),
    user: loginName(),
    path: process.env.PATH,
  };
}

export function unitPath(home: string): string {
  return join(home, ".config", "systemd", "user", UNIT_NAME);
}

/** A value systemd reads literally: `%` starts a specifier, so it is doubled; a line break would end the setting. */
function literal(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`a line break cannot go into a systemd unit: ${JSON.stringify(value)}`);
  return value.replace(/%/g, "%%");
}

/** One quoted word of ExecStart= or Environment=; ExecStart= also expands $NAME, so `$` is doubled there. */
function quoted(value: string, dollars: boolean): string {
  const escaped = literal(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${dollars ? escaped.replace(/\$/g, () => "$$") : escaped}"`;
}

/** The service's PATH: tunelo's own folder and the usual ones first, then the installing shell's folders. */
export function servicePath(home: string, current: string | undefined): string {
  const local = join(home, ".local", "bin");
  const base = ["%h/.local/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const seen = new Set([local, "/usr/local/bin", "/usr/bin", "/bin"]);
  const extra: string[] = [];
  for (const dir of (current ?? "").split(":")) {
    if (!dir.startsWith("/") || seen.has(dir)) continue;
    seen.add(dir);
    extra.push(literal(dir));
  }
  return [...base, ...extra].join(":");
}

export interface UnitOptions {
  /** The agent's command line: this binary and `run`. */
  command: readonly string[];
  /** The config folder; the agent log goes there and the service gets it as TUNELO_HOME. */
  configDir: string;
  home: string;
  path: string | undefined;
}

export function systemdUnit(o: UnitOptions): string {
  const log = literal(join(o.configDir, "agent.log"));
  return [
    "[Unit]",
    "Description=tunelo: tunnels and AI Agent of this machine",
    // Never give up restarting, like launchd's KeepAlive.
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${o.command.map((a) => quoted(a, true)).join(" ")}`,
    // The `PATH=` part stays inside the quotes; %h expands to the home folder.
    `Environment="PATH=${servicePath(o.home, o.path).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    // The manager's environment may lack XDG_CONFIG_HOME: the folder is always given.
    `Environment=${quoted(`TUNELO_HOME=${o.configDir}`, false)}`,
    "Restart=always",
    "RestartSec=10",
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function failure(err: unknown): { missing: boolean; detail: string } {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  return { missing: e.code === "ENOENT", detail: stderr || (typeof e.message === "string" ? e.message : String(err)) };
}

const NO_SYSTEMD =
  "tunelo needs systemd to run in the background on Linux, and this machine does not run it (a container, or WSL without systemd?). Run `tunelo run` yourself instead";

function noUserManager(host: SystemdHost, detail: string, cause: unknown): Error {
  return new Error(
    `systemctl --user cannot reach your systemd user session (${detail}). ` +
      "In an SSH, su or sudo shell run `export XDG_RUNTIME_DIR=/run/user/$(id -u)` and try again; " +
      `if it still fails, run once \`sudo loginctl enable-linger ${host.user}\`, log in again and retry`,
    { cause },
  );
}

/** `systemctl --user <args>`, with an error that says what to do. */
async function systemctl(host: SystemdHost, ...args: string[]): Promise<string> {
  try {
    return (await host.run("systemctl", ["--user", ...args])).stdout;
  } catch (err) {
    const { missing, detail } = failure(err);
    if (missing) throw new Error(NO_SYSTEMD, { cause: err });
    if (/connect to bus|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS/i.test(detail)) throw noUserManager(host, detail, err);
    throw new Error(`systemctl --user ${args.join(" ")} failed: ${detail}`, { cause: err });
  }
}

/** Throws a clear error unless the user's systemd manager answers here. */
export async function checkSystemd(host: SystemdHost): Promise<void> {
  if (!host.booted()) throw new Error(NO_SYSTEMD);
  try {
    await host.run("systemctl", ["--user", "show-environment"]);
  } catch (err) {
    const { missing, detail } = failure(err);
    throw missing ? new Error(NO_SYSTEMD, { cause: err }) : noUserManager(host, detail, err);
  }
}

/** Writes the unit, enables it for every start of the user's manager and (re)starts it now; returns the unit's path. */
export async function installSystemdService(host: SystemdHost, configDir: string, command: readonly string[]): Promise<string> {
  await checkSystemd(host);
  const file = unitPath(host.home);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(file, systemdUnit({ command, configDir, home: host.home, path: host.path }), { mode: 0o644 });
  await systemctl(host, "daemon-reload");
  await systemctl(host, "enable", UNIT_NAME);
  // restart also starts it; a running one (an older file) picks up the new unit.
  await systemctl(host, "restart", UNIT_NAME);
  return file;
}

function notInstalled(host: SystemdHost): Error {
  return new Error(`tunelo is not installed as a service on this machine (no ${unitPath(host.home)}); add the machine from the web first`);
}

export async function startSystemdService(host: SystemdHost): Promise<void> {
  await checkSystemd(host);
  if (!existsSync(unitPath(host.home))) throw notInstalled(host);
  await systemctl(host, "start", UNIT_NAME);
}

/** Stops the service until `tunelo start`, the next login or the next boot. */
export async function stopSystemdService(host: SystemdHost): Promise<void> {
  await checkSystemd(host);
  if (!existsSync(unitPath(host.home))) throw notInstalled(host);
  await systemctl(host, "stop", UNIT_NAME);
}

/** Stops and disables the service and removes its unit; nothing to do when none is installed. */
export async function uninstallSystemdService(host: SystemdHost): Promise<void> {
  const file = unitPath(host.home);
  if (!existsSync(file)) return;
  await checkSystemd(host);
  await systemctl(host, "disable", "--now", UNIT_NAME);
  rmSync(file, { force: true });
  await systemctl(host, "daemon-reload");
}

// --- the terminal process's own unit ----------------------------------------
// tunelo-term-host keeps the machine's terminals and must outlive restarts
// and updates of the agent, so it runs in a unit of its own (its own cgroup:
// stopping tunelo.service never reaches it). It starts on demand (no
// [Install] section), restarts after a crash, and stays down after a clean
// exit (idle, or `shutdown`) and after exit code 3 (another one holds the
// config folder).

export const TERM_HOST_UNIT_NAME = "tunelo-term-host.service";

export function termHostUnitPath(home: string): string {
  return join(home, ".config", "systemd", "user", TERM_HOST_UNIT_NAME);
}

export interface TermHostUnitOptions {
  /** The terminal process binary. */
  bin: string;
  configDir: string;
  home: string;
  path: string | undefined;
}

export function termHostSystemdUnit(o: TermHostUnitOptions): string {
  const log = literal(join(o.configDir, "term-host.log"));
  return [
    "[Unit]",
    "Description=tunelo: terminals of this machine",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quoted(o.bin, true)}`,
    // Shells inherit this environment: the same PATH as the agent's sessions.
    `Environment="PATH=${servicePath(o.home, o.path).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `Environment=${quoted(`TUNELO_HOME=${o.configDir}`, false)}`,
    "Restart=on-failure",
    "RestartSec=2",
    "RestartPreventExitStatus=3",
    // SIGTERM reaches the terminal process alone; it hangs up its shells in order.
    "KillMode=mixed",
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    "",
  ].join("\n");
}

/** True when the unit on disk is the one this tunelo would write for `bin`. */
export function termHostSystemdCurrent(host: SystemdHost, configDir: string, bin: string): boolean {
  try {
    return readFileSync(termHostUnitPath(host.home), "utf8") === termHostSystemdUnit({ bin, configDir, home: host.home, path: host.path });
  } catch {
    return false;
  }
}

/** Writes the unit and reloads the manager (a running terminal process is left as it is). */
export async function installTermHostSystemd(host: SystemdHost, configDir: string, bin: string): Promise<void> {
  await checkSystemd(host);
  const file = termHostUnitPath(host.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, termHostSystemdUnit({ bin, configDir, home: host.home, path: host.path }), { mode: 0o644 });
  await systemctl(host, "daemon-reload");
}

/** Starts the terminal process through its unit; nothing happens when it runs. */
export async function startTermHostSystemd(host: SystemdHost): Promise<void> {
  await checkSystemd(host);
  await systemctl(host, "start", TERM_HOST_UNIT_NAME);
}

/** Stops the unit (its process was asked to shut down first) and removes it; nothing to do when none is installed. */
export async function removeTermHostSystemd(host: SystemdHost): Promise<void> {
  const file = termHostUnitPath(host.home);
  if (!existsSync(file)) return;
  await checkSystemd(host);
  await systemctl(host, "stop", TERM_HOST_UNIT_NAME);
  rmSync(file, { force: true });
  await systemctl(host, "daemon-reload");
}

/**
 * Lets the user's manager, and so the service, run while nobody is logged
 * in. Never asks for a password. Returns null when linger is on, else the
 * command the owner can run once (tunelo itself never runs sudo).
 */
export async function enableLinger(host: SystemdHost): Promise<string | null> {
  const lingering = await host.run("loginctl", ["show-user", host.user, "--property=Linger", "--value"]).then(
    (r) => r.stdout.trim() === "yes",
    () => false,
  );
  if (lingering) return null;
  const enabled = await host.run("loginctl", ["--no-ask-password", "enable-linger", host.user]).then(
    () => true,
    () => false,
  );
  return enabled ? null : `sudo loginctl enable-linger ${host.user}`;
}

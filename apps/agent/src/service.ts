// Runs `tunelo run` at login and keeps it alive: a LaunchAgent on macOS,
// on Windows a value under HKCU\...\Run (no admin needed) that starts a
// hidden loop script restarting the agent if it exits, on Linux a systemd
// user unit (systemd-service.ts). `tunelo start` and
// `tunelo stop` drive the same supervisor, so closing a terminal never stops it.
// The macOS LaunchAgent lives in the user's GUI session (gui/<uid>): a Mac
// nobody is logged in to cannot bootstrap it.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultConfigDir } from "./config.ts";
import { callControl, controlPid } from "./control-socket.ts";
import {
  checkSystemd,
  enableLinger,
  installSystemdService,
  installTermHostSystemd,
  removeTermHostSystemd,
  startSystemdService,
  startTermHostSystemd,
  stopSystemdService,
  systemdHost,
  termHostSystemdCurrent,
  uninstallSystemdService,
} from "./systemd-service.ts";
import { type TermHostUnit, shutdownTermHost } from "./terminal/host-supervisor.ts";
import { AGENT_VERSION } from "./version.ts";

const run = promisify(execFile);
const LABEL = "com.hoandat.tunelo";
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const RUN_VALUE = "tunelo";

/** True inside a `bun build --compile` file, whose script lives in Bun's virtual FS. */
export function isCompiled(): boolean {
  const script = process.argv[1];
  return !script || /^\/\$bunfs\/|[\\/]~BUN[\\/]/.test(script);
}

/** True in the agent launchd started from tunelo's own LaunchAgent (it starts it again when it exits). */
export function underLaunchAgent(): boolean {
  return process.platform === "darwin" && process.env.XPC_SERVICE_NAME === LABEL;
}

/**
 * True when something starts the agent again after it exits (launchd, systemd,
 * the Windows loop), so an update that restarts it leaves it running.
 */
export function supervised(configDir: string): boolean {
  if (process.platform === "darwin") return underLaunchAgent();
  if (process.platform === "linux") return Boolean(process.env.INVOCATION_ID);
  return existsSync(join(configDir, "run-agent.cmd"));
}

/** tunelo itself with `args`: the compiled file, or bun + script in development. */
export function selfCommand(...args: string[]): string[] {
  const exe = process.execPath;
  const script = process.argv[1];
  return isCompiled() || !script ? [exe, ...args] : [exe, script, ...args];
}

/** The binary to run as the service. */
function command(): string[] {
  return selfCommand("run");
}

/** A config folder other than the default has to reach the agent the supervisor starts. */
const customHome = (configDir: string) => (configDir === defaultConfigDir() ? null : configDir);

function plist(args: string[], logDir: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const home = customHome(logDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(`${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>${home ? `<key>TUNELO_HOME</key><string>${esc(home)}</string>` : ""}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(join(logDir, "agent.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logDir, "agent.log"))}</string>
</dict>
</plist>
`;
}

const plistFile = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const launchdTarget = () => `gui/${process.getuid?.() ?? 0}/${LABEL}`;

/** Writes the hidden restart loop (Windows) and returns the script that starts it. */
function writeWindowsLoop(configDir: string, cmd: string[]): string {
  // A loop restarts the agent if it exits, like KeepAlive; a "stop" file ends it.
  mkdirSync(configDir, { recursive: true });
  const loop = join(configDir, "run-agent.cmd");
  const stop = join(configDir, "stop");
  const home = customHome(configDir);
  const quoted = cmd.map((a) => `"${a}"`).join(" ");
  const status = [...cmd.slice(0, -1), "status"].map((a) => `"${a}"`).join(" ");
  const lines = [
    "@echo off",
    // A custom config folder (tests, a second agent) must reach the agent too.
    ...(home ? [`set "TUNELO_HOME=${home}"`] : []),
    ":loop",
    `if exist "${stop}" exit /b`,
    // An agent already answers: another loop keeps it (a quick stop then start), so this one ends.
    `${status} >nul 2>&1 && exit /b`,
    `${quoted} >> "${join(configDir, "agent.log")}" 2>&1`,
    "timeout /t 10 /nobreak >nul",
    "goto loop",
  ];
  writeFileSync(loop, lines.join("\r\n") + "\r\n");
  const vbs = join(configDir, "run-agent.vbs");
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${loop}""", 0, False` + "\r\n");
  return vbs;
}

/**
 * Starts the loop through WMI, so its parent is the WMI service rather than
 * this terminal: a terminal that closes (and the job object it kills) no
 * longer takes the agent with it. Same user, same environment.
 */
async function launchDetached(vbs: string): Promise<void> {
  const line = `wscript.exe "${vbs}"`.replace(/'/g, "''");
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${line}' }; exit $r.ReturnValue`;
  try {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
  } catch {
    // WMI unavailable: start it directly (stops with this terminal on some hosts).
    spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
}

const UNSUPPORTED = "tunelo runs in the background on macOS, Windows and Linux (systemd) only; run `tunelo run` yourself";

/** Throws a clear error, before anything changes, when this machine cannot run the background service. */
export async function checkServiceSupport(): Promise<void> {
  if (process.platform === "darwin" || process.platform === "win32") return;
  if (process.platform === "linux") return checkSystemd(systemdHost());
  throw new Error(UNSUPPORTED);
}

/**
 * Linux: lets the service run while nobody is logged in, without a password.
 * Returns the command the owner still has to run for it, or null (also off Linux).
 */
export async function keepRunningLoggedOut(): Promise<string | null> {
  return process.platform === "linux" ? enableLinger(systemdHost()) : null;
}

/** Registers the supervisor and starts it; `cmd` is the agent command line (default: this binary, `run`). */
export async function installService(configDir: string, cmd = command()): Promise<string> {
  if (process.platform === "darwin") {
    const file = plistFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, plist(cmd, configDir));
    await run("launchctl", ["bootout", launchdTarget()]).catch(() => undefined);
    await run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, file]);
    return file;
  }
  if (process.platform === "win32") {
    rmSync(join(configDir, "stop"), { force: true });
    const vbs = writeWindowsLoop(configDir, cmd);
    await run("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `wscript.exe "${vbs}"`, "/f"]);
    await launchDetached(vbs);
    return RUN_KEY;
  }
  if (process.platform === "linux") return installSystemdService(systemdHost(), configDir, cmd);
  throw new Error(UNSUPPORTED);
}

/** Starts the background agent now (it already starts at login). */
export async function startService(configDir: string, cmd = command()): Promise<void> {
  if (process.platform === "darwin") {
    if (!existsSync(plistFile())) throw new Error("tunelo is not installed on this Mac; add the machine from the web first");
    await run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistFile()]).catch(() => undefined);
    await run("launchctl", ["kickstart", launchdTarget()]);
    return;
  }
  if (process.platform === "win32") {
    rmSync(join(configDir, "stop"), { force: true });
    await launchDetached(writeWindowsLoop(configDir, cmd));
    return;
  }
  if (process.platform === "linux") return startSystemdService(systemdHost());
  throw new Error(UNSUPPORTED);
}

/** Stops the background agent until `tunelo start` or the next login. */
export async function stopService(configDir: string): Promise<void> {
  if (process.platform === "darwin") {
    await run("launchctl", ["bootout", launchdTarget()]).catch(() => undefined);
  } else if (process.platform === "win32") {
    // The loop sees the file and ends instead of starting the agent again.
    writeFileSync(join(configDir, "stop"), "");
    const pid = controlPid(configDir);
    // Exits cleanly (sessions parked); only that pid is killed if it does not answer.
    await callControl(configDir, "POST", "/restart").catch(async () => {
      if (pid) await run("taskkill", ["/F", "/PID", String(pid)]).catch(() => undefined);
    });
  } else if (process.platform === "linux") {
    await stopSystemdService(systemdHost());
  } else {
    throw new Error(UNSUPPORTED);
  }
}

/**
 * Stops the agent and removes its supervisor, then shuts the terminal process
 * down (every shell ends), waits for it to exit and removes its unit. `warn`
 * hears how many terminal sessions were still open.
 */
export async function uninstallService(configDir: string, warn: (line: string) => void = (l) => console.log(l)): Promise<void> {
  if (process.platform === "linux") {
    // systemd stops, disables and removes in one go, and has nothing to do when no unit is installed.
    await uninstallSystemdService(systemdHost());
  } else {
    await stopService(configDir);
    if (process.platform === "darwin") {
      rmSync(plistFile(), { force: true });
    } else if (process.platform === "win32") {
      await run("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]).catch(() => undefined);
      rmSync(join(configDir, "run-agent.cmd"), { force: true });
      rmSync(join(configDir, "run-agent.vbs"), { force: true });
    }
  }
  await removeTermHost(configDir, termHostUnit(configDir), warn);
}

/** Shuts the terminal process down, waits for it to exit, then removes its unit. */
export async function removeTermHost(configDir: string, unit: TermHostUnit | undefined, warn: (line: string) => void): Promise<void> {
  // The Windows loop would start a killed process again.
  if (process.platform === "win32" && existsSync(configDir)) writeFileSync(join(configDir, "stop-term-host"), "");
  const outcome = await shutdownTermHost(configDir, AGENT_VERSION);
  if (outcome.openSessions > 0) {
    warn(`${outcome.openSessions} terminal session${outcome.openSessions === 1 ? " was" : "s were"} still open on this machine; their shells were closed.`);
  }
  await unit?.remove();
}

// --- the terminal process's own unit (macOS and Windows; Linux in systemd-service.ts) ---

export const TERM_HOST_LABEL = "com.hoandat.tunelo.term-host";
const TERM_HOST_RUN_VALUE = "tunelo-term-host";

/**
 * The terminal process's LaunchAgent: restarted after a crash, not after a
 * clean exit (idle or `shutdown`). launchd starts a job with this KeepAlive
 * once at load, so it also runs once at login and exits after 10 idle minutes.
 * Interactive: launchd must not throttle what echoes keystrokes.
 */
export function termHostPlist(o: { label: string; bin: string; configDir: string }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const home = customHome(o.configDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(o.bin)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(`${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>${home ? `<key>TUNELO_HOME</key><string>${esc(home)}</string>` : ""}</dict>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(join(o.configDir, "term-host.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(o.configDir, "term-host.log"))}</string>
</dict>
</plist>
`;
}

const launchdDomain = () => `gui/${process.getuid?.() ?? 0}`;

/**
 * Unloads a job and waits until launchd forgot it: `bootout` returns while
 * the job is still being torn down, and loading the same label again then fails.
 */
async function bootout(label: string): Promise<void> {
  const target = `${launchdDomain()}/${label}`;
  await run("launchctl", ["bootout", target]).catch(() => undefined);
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const loaded = await run("launchctl", ["print", target]).then(
      () => true,
      () => false,
    );
    if (!loaded) return;
  }
}

/** Writes a LaunchAgent and (re)loads it in the user's GUI session. */
export async function registerLaunchAgent(label: string, file: string, contents: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  await bootout(label);
  await run("launchctl", ["bootstrap", launchdDomain(), file]);
}

/** Starts a loaded LaunchAgent's job, loading it first when it is not. */
export async function startLaunchAgent(label: string, file: string): Promise<void> {
  try {
    await run("launchctl", ["kickstart", `${launchdDomain()}/${label}`]);
  } catch {
    await run("launchctl", ["bootstrap", launchdDomain(), file]);
  }
}

/** Unloads a LaunchAgent (its process ends) and deletes its file. */
export async function unregisterLaunchAgent(label: string, file: string): Promise<void> {
  await bootout(label);
  rmSync(file, { force: true });
}

/**
 * Windows: the loop that starts the terminal process and starts it again
 * after a crash; a clean exit (idle, `shutdown`), exit code 3 (another one
 * holds the folder) or the stop file ends it. Started hidden through WMI like
 * the agent's loop, at login by its own Run value and on demand by the agent.
 */
export function termHostWindowsLoop(o: { bin: string; configDir: string }): { cmd: string; vbs: string } {
  const home = customHome(o.configDir);
  const cmdFile = join(o.configDir, "run-term-host.cmd");
  const lines = [
    "@echo off",
    ...(home ? [`set "TUNELO_HOME=${home}"`] : []),
    ":loop",
    `if exist "${join(o.configDir, "stop-term-host")}" exit /b`,
    `"${o.bin}" >> "${join(o.configDir, "term-host.log")}" 2>&1`,
    "if %errorlevel% equ 0 exit /b",
    "if %errorlevel% equ 3 exit /b",
    "timeout /t 2 /nobreak >nul",
    "goto loop",
  ];
  return {
    cmd: lines.join("\r\n") + "\r\n",
    vbs: `CreateObject("WScript.Shell").Run """${cmdFile}""", 0, False` + "\r\n",
  };
}

/** The terminal process's unit on this OS; undefined where it cannot be supervised. */
export function termHostUnit(configDir: string): TermHostUnit | undefined {
  if (process.platform === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", `${TERM_HOST_LABEL}.plist`);
    const contents = (bin: string) => termHostPlist({ label: TERM_HOST_LABEL, bin, configDir });
    return {
      current: (bin) => existsSync(file) && readFileSync(file, "utf8") === contents(bin),
      install: (bin) => registerLaunchAgent(TERM_HOST_LABEL, file, contents(bin)),
      start: () => startLaunchAgent(TERM_HOST_LABEL, file),
      remove: () => unregisterLaunchAgent(TERM_HOST_LABEL, file),
    };
  }
  if (process.platform === "win32") {
    const cmdFile = join(configDir, "run-term-host.cmd");
    const vbsFile = join(configDir, "run-term-host.vbs");
    const stopFile = join(configDir, "stop-term-host");
    return {
      current: (bin) => existsSync(cmdFile) && readFileSync(cmdFile, "utf8") === termHostWindowsLoop({ bin, configDir }).cmd,
      install: async (bin) => {
        mkdirSync(configDir, { recursive: true });
        const loop = termHostWindowsLoop({ bin, configDir });
        writeFileSync(cmdFile, loop.cmd);
        writeFileSync(vbsFile, loop.vbs);
        await run("reg", ["add", RUN_KEY, "/v", TERM_HOST_RUN_VALUE, "/t", "REG_SZ", "/d", `wscript.exe "${vbsFile}"`, "/f"]);
      },
      start: async () => {
        rmSync(stopFile, { force: true });
        await launchDetached(vbsFile);
      },
      remove: async () => {
        await run("reg", ["delete", RUN_KEY, "/v", TERM_HOST_RUN_VALUE, "/f"]).catch(() => undefined);
        for (const f of [cmdFile, vbsFile, stopFile]) rmSync(f, { force: true });
      },
    };
  }
  if (process.platform === "linux") {
    const host = systemdHost();
    if (!host.booted()) return undefined;
    return {
      current: (bin) => termHostSystemdCurrent(host, configDir, bin),
      install: (bin) => installTermHostSystemd(host, configDir, bin),
      start: () => startTermHostSystemd(host),
      remove: () => removeTermHostSystemd(host),
    };
  }
  return undefined;
}

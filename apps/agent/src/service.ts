// Runs `tunelo run` at login and keeps it alive: a LaunchAgent on macOS,
// on Windows a value under HKCU\...\Run (no admin needed) that starts a
// hidden loop script restarting the agent if it exits. `tunelo start` and
// `tunelo stop` drive the same supervisor, so closing a terminal never stops it.
// The macOS LaunchAgent lives in the user's GUI session (gui/<uid>): a Mac
// nobody is logged in to cannot bootstrap it.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultConfigDir } from "./config.ts";
import { callControl, controlPid } from "./control-socket.ts";

const run = promisify(execFile);
const LABEL = "com.hoandat.tunelo";
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const RUN_VALUE = "tunelo";
/** Names the supervisor of hda (chat-agent before that) was registered under. */
const LEGACY_LABEL = "com.hoandat.chat-agent";
const LEGACY_RUN_VALUE = "chat-agent";

/** True inside a `bun build --compile` file, whose script lives in Bun's virtual FS. */
export function isCompiled(): boolean {
  const script = process.argv[1];
  return !script || /^\/\$bunfs\/|[\\/]~BUN[\\/]/.test(script);
}

/** tunelo itself with `args`: the compiled file, or bun + script in development. */
/** True in the agent launchd started from tunelo's own LaunchAgent (it starts it again when it exits). */
export function underLaunchAgent(): boolean {
  return process.platform === "darwin" && process.env.XPC_SERVICE_NAME === LABEL;
}

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

const plistFile = (label = LABEL) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const launchdTarget = (label = LABEL) => `gui/${process.getuid?.() ?? 0}/${label}`;

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
  throw new Error("only macOS and Windows are supported; run `tunelo run` yourself");
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
  throw new Error("only macOS and Windows are supported; run `tunelo run` yourself");
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
  }
}

export async function uninstallService(configDir: string): Promise<void> {
  await stopService(configDir);
  if (process.platform === "darwin") {
    rmSync(plistFile(), { force: true });
  } else if (process.platform === "win32") {
    await run("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]).catch(() => undefined);
    rmSync(join(configDir, "run-agent.cmd"), { force: true });
    rmSync(join(configDir, "run-agent.vbs"), { force: true });
  }
}

/** Stops the old hda agent, if one still answers: Windows only (on macOS bootoutLegacy stops it). */
export async function stopLegacyAgent(legacyDir: string): Promise<void> {
  if (process.platform !== "win32") return;
  // Its loop ends on the "stop" file the caller wrote; the agent exits cleanly.
  await callControl(legacyDir, "POST", "/restart").catch(() => undefined);
}

/** Removes the login entry of hda: the Run value (Windows) or the LaunchAgent file (macOS). */
export async function removeLegacyAutostart(): Promise<void> {
  if (process.platform === "darwin") {
    rmSync(plistFile(LEGACY_LABEL), { force: true });
  } else if (process.platform === "win32") {
    await run("reg", ["delete", RUN_KEY, "/v", LEGACY_RUN_VALUE, "/f"]).catch(() => undefined);
  }
}

/**
 * Unloads the LaunchAgent of hda. This kills its process, which may be the
 * very process calling it, so it has to be the last step.
 */
export async function bootoutLegacy(): Promise<void> {
  if (process.platform !== "darwin") return;
  await run("launchctl", ["bootout", launchdTarget(LEGACY_LABEL)]).catch(() => undefined);
}

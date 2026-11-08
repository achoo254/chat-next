// Runs `hda run` at login and keeps it alive: a LaunchAgent on macOS,
// on Windows a value under HKCU\...\Run (no admin needed) that starts a
// hidden loop script restarting the agent if it exits. `hda start` and
// `hda stop` drive the same supervisor, so closing a terminal never stops it.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { callControl, controlPid } from "./control-socket.ts";

const run = promisify(execFile);
const LABEL = "com.hoandat.chat-agent";
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const RUN_VALUE = "chat-agent";

/** The binary to run: the compiled file itself, or bun + script in development. */
function command(): string[] {
  const exe = process.execPath;
  const script = process.argv[1];
  // Inside a `bun build --compile` file the script lives in Bun's virtual FS.
  const compiled = !script || /^\/\$bunfs\/|[\\/]~BUN[\\/]/.test(script);
  return compiled ? [exe, "run"] : [exe, script, "run"];
}

function plist(args: string[], logDir: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(`${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
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
function writeWindowsLoop(configDir: string): string {
  // A loop restarts the agent if it exits, like KeepAlive; a "stop" file ends it.
  mkdirSync(configDir, { recursive: true });
  const loop = join(configDir, "run-agent.cmd");
  const stop = join(configDir, "stop");
  const cmd = command();
  const quoted = cmd.map((a) => `"${a}"`).join(" ");
  const status = [...cmd.slice(0, -1), "status"].map((a) => `"${a}"`).join(" ");
  const lines = [
    "@echo off",
    // A custom config folder (tests, a second agent) must reach the agent too.
    ...(process.env.CHAT_AGENT_HOME ? [`set "CHAT_AGENT_HOME=${configDir}"`] : []),
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

export async function installService(configDir: string): Promise<string> {
  if (process.platform === "darwin") {
    const file = plistFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, plist(command(), configDir));
    await run("launchctl", ["bootout", launchdTarget()]).catch(() => undefined);
    await run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, file]);
    return file;
  }
  if (process.platform === "win32") {
    rmSync(join(configDir, "stop"), { force: true });
    const vbs = writeWindowsLoop(configDir);
    await run("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `wscript.exe "${vbs}"`, "/f"]);
    await launchDetached(vbs);
    return RUN_KEY;
  }
  throw new Error("only macOS and Windows are supported; run `hda run` yourself");
}

/** Starts the background agent now (it already starts at login). */
export async function startService(configDir: string): Promise<void> {
  if (process.platform === "darwin") {
    if (!existsSync(plistFile())) throw new Error("hda is not installed on this Mac; add the machine from the web first");
    await run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistFile()]).catch(() => undefined);
    await run("launchctl", ["kickstart", launchdTarget()]);
    return;
  }
  if (process.platform === "win32") {
    rmSync(join(configDir, "stop"), { force: true });
    await launchDetached(writeWindowsLoop(configDir));
    return;
  }
  throw new Error("only macOS and Windows are supported; run `hda run` yourself");
}

/** Stops the background agent until `hda start` or the next login. */
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

// Runs `chat-agent run` at login and keeps it alive: a LaunchAgent on macOS,
// a per-user Scheduled Task on Windows (restarted by a small loop script).
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const LABEL = "com.hoandat.chat-agent";
const TASK = "chat-agent";

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

export async function installService(configDir: string): Promise<string> {
  const args = command();
  if (process.platform === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, plist(args, configDir));
    const uid = process.getuid?.() ?? 0;
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => undefined);
    await run("launchctl", ["bootstrap", `gui/${uid}`, file]);
    return file;
  }
  if (process.platform === "win32") {
    // A loop restarts the agent if it exits, like KeepAlive; hidden window.
    const loop = join(configDir, "run-agent.cmd");
    const quoted = args.map((a) => `"${a}"`).join(" ");
    writeFileSync(loop, `@echo off\r\n:loop\r\n${quoted} >> "${join(configDir, "agent.log")}" 2>&1\r\ntimeout /t 10 /nobreak >nul\r\ngoto loop\r\n`);
    const vbs = join(configDir, "run-agent.vbs");
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${loop}""", 0, False\r\n`);
    await run("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", TASK, "/TR", `wscript.exe "${vbs}"`]);
    await run("schtasks", ["/Run", "/TN", TASK]);
    return TASK;
  }
  throw new Error("only macOS and Windows are supported; run `chat-agent run` yourself");
}

export async function uninstallService(configDir: string): Promise<void> {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => undefined);
    rmSync(join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`), { force: true });
  } else if (process.platform === "win32") {
    await run("schtasks", ["/Delete", "/F", "/TN", TASK]).catch(() => undefined);
    await run("taskkill", ["/F", "/FI", `WINDOWTITLE eq ${TASK}`]).catch(() => undefined);
    rmSync(join(configDir, "run-agent.cmd"), { force: true });
    rmSync(join(configDir, "run-agent.vbs"), { force: true });
  }
}

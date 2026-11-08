// Runs `hda run` at login and keeps it alive: a LaunchAgent on macOS,
// on Windows a value under HKCU\...\Run (no admin needed) that starts a
// hidden loop script restarting the agent if it exits.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

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
    // A loop restarts the agent if it exits, like KeepAlive; a "stop" file ends it.
    const loop = join(configDir, "run-agent.cmd");
    const stop = join(configDir, "stop");
    const quoted = args.map((a) => `"${a}"`).join(" ");
    rmSync(stop, { force: true });
    const lines = [
      "@echo off",
      ":loop",
      `if exist "${stop}" exit /b`,
      `${quoted} >> "${join(configDir, "agent.log")}" 2>&1`,
      "timeout /t 10 /nobreak >nul",
      "goto loop",
    ];
    writeFileSync(loop, lines.join("\r\n") + "\r\n");
    const vbs = join(configDir, "run-agent.vbs");
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${loop}""", 0, False` + "\r\n");
    await run("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `wscript.exe "${vbs}"`, "/f"]);
    spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return RUN_KEY;
  }
  throw new Error("only macOS and Windows are supported; run `hda run` yourself");
}

export async function uninstallService(configDir: string): Promise<void> {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => undefined);
    rmSync(join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`), { force: true });
  } else if (process.platform === "win32") {
    await run("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]).catch(() => undefined);
    writeFileSync(join(configDir, "stop"), "");
    await run("taskkill", ["/F", "/IM", "hda.exe"]).catch(() => undefined);
    rmSync(join(configDir, "run-agent.cmd"), { force: true });
    rmSync(join(configDir, "run-agent.vbs"), { force: true });
  }
}

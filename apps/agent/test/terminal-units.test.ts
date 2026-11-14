// The terminal process's own supervised units (launchd, systemd, the Windows
// Run loop) as text, one real launchd register/unregister on macOS with a
// throwaway label, and which binary the agent picks.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultConfigDir } from "../src/config.ts";
import { registerLaunchAgent, termHostPlist, termHostWindowsLoop, unregisterLaunchAgent } from "../src/service.ts";
import { termHostSystemdUnit } from "../src/systemd-service.ts";
import { TERM_HOST_BINARY, locateTermHost, restorePreviousTermHost, switchStagedTermHost } from "../src/terminal/host-supervisor.ts";
import { tempDir } from "./harness.ts";

const run = promisify(execFile);

describe("the terminal process's units", () => {
  it("launchd: its own label, restarted only after a crash, interactive, the config folder passed on", () => {
    const plist = termHostPlist({ label: "com.hoandat.tunelo.term-host", bin: "/opt/t&t/tunelo-term-host", configDir: "/tmp/cfg" });
    expect(plist).toContain("<key>Label</key><string>com.hoandat.tunelo.term-host</string>");
    expect(plist).toContain("<array><string>/opt/t&amp;t/tunelo-term-host</string></array>");
    expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(plist).toContain("<key>ProcessType</key><string>Interactive</string>");
    expect(plist).toContain("<key>TUNELO_HOME</key><string>/tmp/cfg</string>");
    expect(plist).toContain("/tmp/cfg/term-host.log");
    // Nothing that would change how the agent's own unit treats its children.
    expect(plist).not.toMatch(/AbandonProcessGroup|RunAtLoad/);
    // The default folder is not written out.
    expect(termHostPlist({ label: "x", bin: "/b", configDir: defaultConfigDir() })).not.toContain("TUNELO_HOME");
  });

  it("systemd: a unit of its own, restarted on failure but not for exit code 3, started on demand", () => {
    const unit = termHostSystemdUnit({ bin: "/home/u/.config/tunelo/term-host/bin/current/tunelo-term-host", configDir: "/home/u/.config/tunelo", home: "/home/u", path: "/usr/bin:/snap/bin" });
    expect(unit).toContain('ExecStart="/home/u/.config/tunelo/term-host/bin/current/tunelo-term-host"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartPreventExitStatus=3");
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain('Environment="TUNELO_HOME=/home/u/.config/tunelo"');
    expect(unit).toContain("/snap/bin");
    expect(unit).toContain("StandardError=append:/home/u/.config/tunelo/term-host.log");
    // Started by the agent when needed, never enabled at boot.
    expect(unit).not.toContain("[Install]");
    expect(() => termHostSystemdUnit({ bin: "/a\nb", configDir: "/c", home: "/h", path: undefined })).toThrow(/line break/);
  });

  it("Windows: its own loop, ended by a clean exit, exit code 3 or its stop file", () => {
    const { cmd, vbs } = termHostWindowsLoop({ bin: String.raw`C:\Users\u\AppData\Roaming\tunelo\term-host\bin\current\tunelo-term-host.exe`, configDir: String.raw`C:\tmp\cfg` });
    const lines = cmd.split("\r\n");
    expect(lines).toContain(String.raw`set "TUNELO_HOME=C:\tmp\cfg"`);
    expect(lines).toContain("if %errorlevel% equ 0 exit /b");
    expect(lines).toContain("if %errorlevel% equ 3 exit /b");
    expect(lines.some((l) => l.includes("stop-term-host") && l.startsWith("if exist"))).toBe(true);
    expect(lines.some((l) => l.includes("tunelo-term-host.exe") && l.includes("term-host.log"))).toBe(true);
    expect(cmd).not.toContain("run-agent");
    expect(vbs).toContain("run-term-host.cmd");
    expect(vbs).toContain(", 0, False");
  });

  it.runIf(process.platform === "darwin")("launchd really loads and unloads a job under a throwaway label, leaving nothing behind", async () => {
    const uid = process.getuid?.() ?? 0;
    const gui = await run("launchctl", ["print", `gui/${uid}`]).then(
      () => true,
      () => false,
    );
    if (!gui) {
      console.warn("SKIPPED: no GUI launchd session for this user");
      return;
    }
    const dir = tempDir("launchd-");
    const script = join(dir, "job.sh");
    writeFileSync(script, "#!/bin/sh\nexec /bin/sleep 600\n");
    chmodSync(script, 0o755);
    const label = `com.hoandat.tunelo.term-host.test-${process.pid}-${Date.now()}`;
    const file = join(dir, `${label}.plist`);
    try {
      await registerLaunchAgent(label, file, termHostPlist({ label, bin: script, configDir: dir }));
      // KeepAlive with SuccessfulExit starts the job once it loads.
      let pid = 0;
      for (let i = 0; i < 50 && !pid; i++) {
        const out = (await run("launchctl", ["print", `gui/${uid}/${label}`])).stdout;
        pid = Number(/\bpid = (\d+)/.exec(out)?.[1] ?? 0);
        if (!pid) await new Promise((r) => setTimeout(r, 100));
      }
      expect(pid).toBeGreaterThan(0);
      await unregisterLaunchAgent(label, file);
      await expect(run("launchctl", ["print", `gui/${uid}/${label}`])).rejects.toThrow();
      expect(existsSync(file)).toBe(false);
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await run("launchctl", ["bootout", `gui/${uid}/${label}`]).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which terminal process binary runs", () => {
  it("TUNELO_TERM_HOST_BIN first, then the config folder's current one, then the agent's own folder", () => {
    const cfg = tempDir("bin-");
    const exeDir = tempDir("exe-");
    const execPath = join(exeDir, "tunelo");
    expect(locateTermHost(cfg, {}, execPath)).toBeUndefined();
    writeFileSync(join(exeDir, TERM_HOST_BINARY), "");
    expect(locateTermHost(cfg, {}, execPath)).toBe(join(exeDir, TERM_HOST_BINARY));
    const current = join(cfg, "term-host", "bin", "current");
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, TERM_HOST_BINARY), "");
    expect(locateTermHost(cfg, {}, execPath)).toBe(join(current, TERM_HOST_BINARY));
    expect(locateTermHost(cfg, { TUNELO_TERM_HOST_BIN: execPath }, execPath)).toBeUndefined();
    writeFileSync(execPath, "");
    expect(locateTermHost(cfg, { TUNELO_TERM_HOST_BIN: execPath }, execPath)).toBe(execPath);
  });

  it("a staged newer binary becomes the current one, the old one kept to go back to (only called while none runs)", () => {
    const cfg = tempDir("bin-");
    const bin = join(cfg, "term-host", "bin");
    expect(switchStagedTermHost(cfg)).toBe(false);
    mkdirSync(join(bin, "current"), { recursive: true });
    writeFileSync(join(bin, "current", TERM_HOST_BINARY), "old");
    mkdirSync(join(bin, "next"), { recursive: true });
    writeFileSync(join(bin, "next", TERM_HOST_BINARY), "new");
    expect(switchStagedTermHost(cfg)).toBe(true);
    expect(readFileSync(join(bin, "current", TERM_HOST_BINARY), "utf8")).toBe("new");
    expect(existsSync(join(bin, "next"))).toBe(false);
    expect(readFileSync(join(bin, "previous", TERM_HOST_BINARY), "utf8")).toBe("old");
    // The new one does not start: back to the old one.
    restorePreviousTermHost(cfg);
    expect(readFileSync(join(bin, "current", TERM_HOST_BINARY), "utf8")).toBe("old");
    expect(existsSync(join(bin, "previous"))).toBe(false);
  });
});

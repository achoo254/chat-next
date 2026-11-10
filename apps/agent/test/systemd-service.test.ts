// The Linux service: a systemd user unit, driven through `systemctl --user`.
// The host is faked, so this runs anywhere without touching a real systemd.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SystemdHost,
  checkSystemd,
  enableLinger,
  installSystemdService,
  nameFromPasswd,
  servicePath,
  startSystemdService,
  stopSystemdService,
  systemdUnit,
  uninstallSystemdService,
  unitPath,
} from "../src/systemd-service.ts";

/** An execFile-like failure: missing program (ENOENT) or a non-zero exit with stderr. */
const failed = (stderr: string, code: string | number = 1) => Object.assign(new Error(`Command failed: ${stderr}`), { code, stderr });

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tunelo-systemd-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakeHost(answers: Record<string, () => { stdout: string } | Error> = {}, booted = true): { host: SystemdHost; calls: string[] } {
  const calls: string[] = [];
  const host: SystemdHost = {
    run: async (file, args) => {
      const line = [file, ...args].join(" ");
      calls.push(line);
      const answer = answers[line]?.() ?? { stdout: "" };
      if (answer instanceof Error) throw answer;
      return { stdout: answer.stdout, stderr: "" };
    },
    booted: () => booted,
    home,
    user: "dat",
    path: "/home/dat/.nvm/versions/node/v24/bin:/usr/bin:relative/bin:/opt/50%/bin",
  };
  return { host, calls };
}

const configDir = () => join(home, ".config", "tunelo");
const placeUnit = () => {
  mkdirSync(dirname(unitPath(home)), { recursive: true });
  writeFileSync(unitPath(home), "[Unit]\n");
};

describe("systemd unit", () => {
  it("runs the agent, restarts it forever and appends its output to agent.log", () => {
    const unit = systemdUnit({ command: ["/home/dat/.local/bin/tunelo", "run"], configDir: "/home/dat/.config/tunelo", home: "/home/dat", path: undefined });
    expect(unit).toContain('ExecStart="/home/dat/.local/bin/tunelo" "run"');
    expect(unit).toContain('Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"');
    expect(unit).toContain('Environment="TUNELO_HOME=/home/dat/.config/tunelo"');
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^RestartSec=10$/m);
    expect(unit).toMatch(/^StartLimitIntervalSec=0$/m);
    expect(unit).toContain("StandardOutput=append:/home/dat/.config/tunelo/agent.log");
    expect(unit).toContain("StandardError=append:/home/dat/.config/tunelo/agent.log");
    expect(unit).toMatch(/\[Install\]\nWantedBy=default\.target/);
  });

  it("keeps the installing shell's folders on PATH, so the service finds the same claude", () => {
    expect(servicePath("/home/dat", "/home/dat/.local/bin:/home/dat/.nvm/versions/node/v24/bin:/usr/bin:relative:/opt/50%/bin")).toBe(
      "%h/.local/bin:/usr/local/bin:/usr/bin:/bin:/home/dat/.nvm/versions/node/v24/bin:/opt/50%%/bin",
    );
  });

  it("quotes what systemd would otherwise expand or split", () => {
    const unit = systemdUnit({ command: ['/opt/my "tools"/50%/$HOME/tunelo', "run"], configDir: "/srv/a b", home: "/home/dat", path: undefined });
    expect(unit).toContain('ExecStart="/opt/my \\"tools\\"/50%%/$$HOME/tunelo" "run"');
    expect(unit).toContain('Environment="TUNELO_HOME=/srv/a b"');
    expect(() => systemdUnit({ command: ["/bin/tunelo\nExecStartPre=/bin/evil", "run"], configDir: "/c", home: "/h", path: undefined })).toThrow(/line break/);
  });
});

describe("systemd service", () => {
  it("installs the unit in ~/.config/systemd/user, enables it and starts it", async () => {
    const { host, calls } = fakeHost();
    const file = await installSystemdService(host, configDir(), ["/home/dat/.local/bin/tunelo", "run"]);
    expect(file).toBe(join(home, ".config", "systemd", "user", "tunelo.service"));
    expect(readFileSync(file, "utf8")).toContain('ExecStart="/home/dat/.local/bin/tunelo" "run"');
    expect(readFileSync(file, "utf8")).toContain("/home/dat/.nvm/versions/node/v24/bin");
    // The log folder exists before systemd opens agent.log in it.
    expect(existsSync(configDir())).toBe(true);
    expect(calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      "systemctl --user enable tunelo.service",
      "systemctl --user restart tunelo.service",
    ]);
  });

  it("start and stop drive the unit", async () => {
    placeUnit();
    const { host, calls } = fakeHost();
    await startSystemdService(host);
    await stopSystemdService(host);
    expect(calls.filter((c) => !c.endsWith("show-environment"))).toEqual(["systemctl --user start tunelo.service", "systemctl --user stop tunelo.service"]);
  });

  it("start and stop without an installed unit say so instead of doing nothing", async () => {
    const { host } = fakeHost();
    await expect(startSystemdService(host)).rejects.toThrow(/not installed as a service/);
    await expect(stopSystemdService(host)).rejects.toThrow(/not installed as a service/);
  });

  it("uninstall stops, disables and removes the unit", async () => {
    placeUnit();
    const { host, calls } = fakeHost();
    await uninstallSystemdService(host);
    expect(existsSync(unitPath(home))).toBe(false);
    expect(calls).toEqual(["systemctl --user show-environment", "systemctl --user disable --now tunelo.service", "systemctl --user daemon-reload"]);
  });

  it("uninstall with no unit has nothing to do", async () => {
    const { host, calls } = fakeHost({}, false);
    await uninstallSystemdService(host);
    expect(calls).toEqual([]);
  });

  it("a failing systemctl is reported, not swallowed", async () => {
    placeUnit();
    const { host } = fakeHost({ "systemctl --user stop tunelo.service": () => failed("Access denied") });
    await expect(stopSystemdService(host)).rejects.toThrow("systemctl --user stop tunelo.service failed: Access denied");
  });
});

describe("no systemd", () => {
  it("a machine not booted with systemd (container, WSL without it) needs systemd", async () => {
    const { host, calls } = fakeHost({}, false);
    await expect(checkSystemd(host)).rejects.toThrow(/needs systemd/);
    await expect(installSystemdService(host, configDir(), ["/t", "run"])).rejects.toThrow(/needs systemd/);
    expect(existsSync(unitPath(home))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("no systemctl program also needs systemd", async () => {
    const { host } = fakeHost({ "systemctl --user show-environment": () => failed("spawn systemctl ENOENT", "ENOENT") });
    await expect(checkSystemd(host)).rejects.toThrow(/needs systemd/);
  });

  it("no user session bus (an su or SSH shell): shows how to reach it", async () => {
    const { host } = fakeHost({ "systemctl --user show-environment": () => failed("Failed to connect to bus: No medium found") });
    await expect(checkSystemd(host)).rejects.toThrow(/export XDG_RUNTIME_DIR=\/run\/user\/\$\(id -u\)/);
    await expect(checkSystemd(host)).rejects.toThrow(/sudo loginctl enable-linger dat/);
  });
});

describe("linger", () => {
  it("already on: nothing to do", async () => {
    const { host, calls } = fakeHost({ "loginctl show-user dat --property=Linger --value": () => ({ stdout: "yes\n" }) });
    expect(await enableLinger(host)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("turned on without a password", async () => {
    const { host, calls } = fakeHost({ "loginctl show-user dat --property=Linger --value": () => ({ stdout: "no\n" }) });
    expect(await enableLinger(host)).toBeNull();
    expect(calls).toContain("loginctl --no-ask-password enable-linger dat");
  });

  it("refused: the sudo command to run once, never sudo itself", async () => {
    const { host, calls } = fakeHost({
      "loginctl show-user dat --property=Linger --value": () => failed("User dat is not logged in or lingering"),
      "loginctl --no-ask-password enable-linger dat": () => failed("Interactive authentication required."),
    });
    expect(await enableLinger(host)).toBe("sudo loginctl enable-linger dat");
    expect(calls.some((c) => c.startsWith("sudo"))).toBe(false);
  });
});

describe("the login name of a user id", () => {
  const passwd = ["root:x:0:0:root:/root:/bin/bash", "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin", "dat:x:1000:1000:Dat,,,:/home/dat:/bin/bash", "# a comment", ""].join("\n");

  it("reads it from the passwd text by id, not from the environment", () => {
    expect(nameFromPasswd(passwd, 1000)).toBe("dat");
    expect(nameFromPasswd(passwd, 0)).toBe("root");
  });

  it("is undefined for an id that is not listed, so another source answers", () => {
    expect(nameFromPasswd(passwd, 4242)).toBeUndefined();
    expect(nameFromPasswd("", 0)).toBeUndefined();
  });
});

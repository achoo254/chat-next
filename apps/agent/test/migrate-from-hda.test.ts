import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportPrivateKey, generateKeyPair, toBase64Url } from "@achoo254/chat-remote-protocol";
import { copyLegacyMachineKey, machineKey } from "../src/keystore.ts";
import {
  MIGRATED_MARKER,
  type MigrationPaths,
  type MigrationSystem,
  addToShellProfile,
  copyConfigFolder,
  migrateFromHda,
  removeLegacyBinaries,
  runAsHda,
} from "../src/migrate-from-hda.ts";
import { tempDir } from "./harness.ts";

type Step = Exclude<keyof MigrationSystem, "isRunning" | "sleep">;

/** A fake OS: records the calls, starts tunelo when its service is installed, fails a step on demand. */
function fakeSystem(paths: MigrationPaths, opts: { failAt?: Step; neverStarts?: boolean; legacyRunning?: boolean } = {}) {
  const calls: string[] = [];
  const state = { newRunning: false, legacyRunning: opts.legacyRunning ?? false, failAt: opts.failAt, neverStarts: opts.neverStarts ?? false };
  const step = (name: Step, effect: () => void = () => undefined) => async () => {
    calls.push(name);
    if (state.failAt === name) throw new Error(`${name} failed`);
    effect();
  };
  const sys: MigrationSystem = {
    copyMachineKey: step("copyMachineKey"),
    addToPath: step("addToPath"),
    checkBinary: step("checkBinary"),
    installService: async (dir, cmd) => {
      calls.push(`installService ${cmd.join(" ")}`);
      if (state.failAt === "installService") throw new Error("installService failed");
      expect(dir).toBe(paths.newDir);
      if (!state.neverStarts) state.newRunning = true;
    },
    stopLegacyAgent: step("stopLegacyAgent", () => (state.legacyRunning = false)),
    removeLegacyAutostart: step("removeLegacyAutostart"),
    bootoutLegacy: step("bootoutLegacy"),
    isRunning: async (dir) => (dir === paths.newDir ? state.newRunning : dir === paths.legacyDir ? state.legacyRunning : false),
    sleep: async () => undefined,
  };
  return { sys, calls, state };
}

/** A home folder with an hda install the way 0.2.4 leaves it, plus the old Tunelo CLI's config. */
function hdaHome() {
  const root = tempDir("migrate-");
  const home = join(root, "home");
  const legacyDir = join(home, ".config", "chat-agent");
  const paths: MigrationPaths = {
    legacyDir,
    newDir: join(home, ".config", "tunelo"),
    currentExe: join(home, ".local", "bin", "hda"),
    newExe: join(home, ".local", "bin", "tunelo"),
    home,
  };
  mkdirSync(join(legacyDir, "data", "threads"), { recursive: true });
  const config = { machineName: "mini", machineId: "m-123", machineSecret: "s".repeat(43), devices: [{ key: "k".repeat(43), name: "phone", addedAt: 1 }], subdomain: "m-abc" };
  writeFileSync(join(legacyDir, "config.json"), JSON.stringify(config));
  writeFileSync(join(legacyDir, "machine-key"), "private-key");
  writeFileSync(join(legacyDir, "tunelo-session.json"), '{"refresh":"r"}');
  writeFileSync(join(legacyDir, "data", "threads", "t1.jsonl"), '{"seq":1}\n');
  // Runtime files of the old process and its supervisor.
  writeFileSync(join(legacyDir, "control.json"), '{"port":1,"token":"t","pid":1}');
  writeFileSync(join(legacyDir, "agent.log"), "log\n");
  writeFileSync(join(legacyDir, "run-agent.cmd"), "@echo off\n");
  writeFileSync(join(legacyDir, "config.json.42.tmp"), "half");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(paths.currentExe, "BINARY");
  chmodSync(paths.currentExe, 0o755);
  mkdirSync(join(home, ".tunelo"), { recursive: true });
  const cli = JSON.stringify({ server: "https://tunnel.example.test/", key: "tunelo_secret", session: { refreshToken: "secret" } });
  writeFileSync(join(home, ".tunelo", "config.json"), cli);
  return { paths, config, cli };
}

const mode = (p: string) => statSync(p).mode & 0o777;
const posix = process.platform !== "win32";

function expectMoved(paths: MigrationPaths, config: object) {
  const { legacyDir, newDir } = paths;
  const copied = JSON.parse(readFileSync(join(newDir, "config.json"), "utf8")) as Record<string, unknown>;
  expect(copied).toMatchObject(config);
  expect(copied.tunnelServer).toBe("https://tunnel.example.test");
  expect(readFileSync(join(newDir, "machine-key"), "utf8")).toBe("private-key");
  expect(readFileSync(join(newDir, "tunelo-session.json"), "utf8")).toBe('{"refresh":"r"}');
  expect(readFileSync(join(newDir, "data", "threads", "t1.jsonl"), "utf8")).toBe('{"seq":1}\n');
  for (const f of ["control.json", "agent.log", "run-agent.cmd", "stop", MIGRATED_MARKER, "config.json.42.tmp"]) expect(existsSync(join(newDir, f))).toBe(false);
  expect(existsSync(`${newDir}.from-hda`)).toBe(false);
  if (posix) {
    expect(mode(newDir)).toBe(0o700);
    expect(mode(join(newDir, "data", "threads"))).toBe(0o700);
    expect(mode(join(newDir, "machine-key"))).toBe(0o600);
    expect(mode(paths.newExe)).toBe(0o755);
  }
  expect(readFileSync(paths.newExe, "utf8")).toBe("BINARY");
  // The old install stays whole for a way back; it is only told to stop.
  expect(readFileSync(join(legacyDir, "machine-key"), "utf8")).toBe("private-key");
  expect(existsSync(join(legacyDir, "config.json"))).toBe(true);
  expect(existsSync(join(legacyDir, "stop"))).toBe(true);
  expect(existsSync(join(legacyDir, MIGRATED_MARKER))).toBe(true);
}

const quiet = () => undefined;

describe("moving hda to tunelo", () => {
  it("copies the machine, starts tunelo, then stops hda, removes its login entry and unloads it last", async () => {
    const { paths, config, cli } = hdaHome();
    const { sys, calls } = fakeSystem(paths);
    await migrateFromHda(paths, sys, quiet);
    expectMoved(paths, config);
    expect(calls).toEqual([
      "copyMachineKey",
      "addToPath",
      "checkBinary",
      `installService ${paths.newExe} run`,
      "stopLegacyAgent",
      "removeLegacyAutostart",
      "bootoutLegacy",
    ]);
    // Only the tunnel server comes from the old CLI; its secrets and file stay untouched.
    expect(readFileSync(join(paths.home, ".tunelo", "config.json"), "utf8")).toBe(cli);
    expect(readFileSync(join(paths.newDir, "config.json"), "utf8")).not.toContain("secret");
  });

  it("runs twice without changing a finished copy or restarting tunelo", async () => {
    const { paths, config } = hdaHome();
    const { sys, calls } = fakeSystem(paths);
    await migrateFromHda(paths, sys, quiet);
    writeFileSync(join(paths.newDir, "devices-added-later"), "x");
    writeFileSync(join(paths.legacyDir, "config.json"), JSON.stringify({ machineId: "other" }));
    calls.length = 0;
    await migrateFromHda(paths, sys, quiet);
    expectMoved(paths, config);
    expect(existsSync(join(paths.newDir, "devices-added-later"))).toBe(true);
    expect(calls).not.toContain(`installService ${paths.newExe} run`);
  });

  const steps: Step[] = ["copyMachineKey", "addToPath", "checkBinary", "installService", "stopLegacyAgent", "removeLegacyAutostart", "bootoutLegacy"];
  it.each(steps)("finishes after stopping at %s, then starting again as hda", async (failAt) => {
    const { paths, config } = hdaHome();
    const fake = fakeSystem(paths, { failAt });
    await expect(migrateFromHda(paths, fake.sys, quiet)).rejects.toThrow(`${failAt} failed`);
    const beforeStep3 = steps.indexOf(failAt) < steps.indexOf("stopLegacyAgent");
    // Until tunelo answers, hda is neither told to stop nor marked as moved.
    expect(existsSync(join(paths.legacyDir, "stop"))).toBe(!beforeStep3);
    expect(existsSync(join(paths.legacyDir, MIGRATED_MARKER))).toBe(!beforeStep3);

    fake.state.failAt = undefined;
    fake.calls.length = 0;
    let legacyAgent = 0;
    const code = await runAsHda(paths, fake.sys, quiet, async () => ++legacyAgent);
    expect(code).toBe(0);
    expect(legacyAgent).toBe(0);
    expectMoved(paths, config);
    expect(fake.state.newRunning).toBe(true);
    expect(fake.calls.slice(-2)).toEqual(["removeLegacyAutostart", "bootoutLegacy"]);
  });

  it("does not stop hda when tunelo never starts, and hda keeps the machine online", async () => {
    const { paths } = hdaHome();
    const fake = fakeSystem(paths, { neverStarts: true });
    let legacyAgent = 0;
    const code = await runAsHda(paths, fake.sys, quiet, async () => ++legacyAgent);
    expect(code).toBe(1);
    expect(legacyAgent).toBe(1);
    expect(existsSync(join(paths.legacyDir, "stop"))).toBe(false);
    expect(existsSync(join(paths.legacyDir, MIGRATED_MARKER))).toBe(false);
    expect(fake.calls).not.toContain("removeLegacyAutostart");
    expect(fake.calls).not.toContain("bootoutLegacy");
  });

  it("moves while an old hda agent still runs (the install script): tunelo waits, then hda is stopped", async () => {
    const { paths, config } = hdaHome();
    const fake = fakeSystem(paths, { neverStarts: true, legacyRunning: true });
    await migrateFromHda(paths, fake.sys, quiet);
    expectMoved(paths, config);
    expect(fake.state.legacyRunning).toBe(false);
    expect(fake.calls).toContain("stopLegacyAgent");
  });

  it("hda run never starts an agent once moved: it keeps tunelo running and exits", async () => {
    const { paths } = hdaHome();
    const fake = fakeSystem(paths);
    await migrateFromHda(paths, fake.sys, quiet);
    fake.state.newRunning = false;
    fake.calls.length = 0;
    let legacyAgent = 0;
    expect(await runAsHda(paths, fake.sys, quiet, async () => ++legacyAgent)).toBe(0);
    expect(legacyAgent).toBe(0);
    expect(fake.calls).toEqual(["stopLegacyAgent", `installService ${paths.newExe} run`, "removeLegacyAutostart", "bootoutLegacy"]);

    // tunelo cannot start: hda run fails (its supervisor tries again) and still starts no agent.
    fake.state.newRunning = false;
    fake.state.failAt = "installService";
    await expect(runAsHda(paths, fake.sys, quiet, async () => ++legacyAgent)).rejects.toThrow("installService failed");
    expect(legacyAgent).toBe(0);
  });

  it("refuses without an hda install or when both names share one folder", async () => {
    const { paths } = hdaHome();
    const { sys } = fakeSystem(paths);
    await expect(migrateFromHda({ ...paths, legacyDir: join(paths.home, "none") }, sys, quiet)).rejects.toThrow(/no hda install/);
    await expect(migrateFromHda({ ...paths, newDir: paths.legacyDir }, sys, quiet)).rejects.toThrow(/would share/);
  });

  it("recovers from a copy cut short: a leftover staging folder and a new folder without config.json", () => {
    const { paths } = hdaHome();
    mkdirSync(`${paths.newDir}.from-hda`, { recursive: true });
    writeFileSync(join(`${paths.newDir}.from-hda`, "junk"), "x");
    mkdirSync(join(paths.newDir, "data"), { recursive: true });
    writeFileSync(join(paths.newDir, "data", "keep"), "k");
    expect(copyConfigFolder(paths.legacyDir, paths.newDir)).toBe("copied");
    expect(existsSync(join(paths.newDir, "config.json"))).toBe(true);
    expect(existsSync(join(paths.newDir, "machine-key"))).toBe(true);
    expect(readFileSync(join(paths.newDir, "data", "keep"), "utf8")).toBe("k");
    expect(existsSync(join(paths.newDir, "junk"))).toBe(false);
    expect(existsSync(`${paths.newDir}.from-hda`)).toBe(false);
    expect(copyConfigFolder(paths.legacyDir, paths.newDir)).toBe("kept");
  });

  it("deletes the old hda files only after the move", () => {
    const { paths } = hdaHome();
    const old = [join(paths.home, "hda.exe"), join(paths.home, "hda.exe.old")];
    for (const f of old) writeFileSync(f, "x");
    removeLegacyBinaries(paths.legacyDir, old);
    expect(old.every((f) => existsSync(f))).toBe(true);
    writeFileSync(join(paths.legacyDir, MIGRATED_MARKER), "{}");
    removeLegacyBinaries(paths.legacyDir, [...old, join(paths.home, "missing.exe")]);
    expect(old.some((f) => existsSync(f))).toBe(false);
  });

  it("puts the bin folder on PATH once", () => {
    const home = tempDir("profile-");
    writeFileSync(join(home, ".bash_profile"), "# mine\n");
    addToShellProfile(home, join(home, ".local", "bin"));
    addToShellProfile(home, join(home, ".local", "bin"));
    const line = 'export PATH="$HOME/.local/bin:$PATH"';
    for (const rc of [".zprofile", ".bash_profile"]) expect(readFileSync(join(home, rc), "utf8").split(line).length - 1).toBe(1);
  });
});

describe.runIf(process.platform === "darwin")("machine key in the Keychain under the old name", () => {
  const saved = { path: process.env.PATH, a: process.env.TUNELO_KEYSTORE, b: process.env.CHAT_AGENT_KEYSTORE, store: process.env.FAKE_KEYCHAIN };
  let store = "";

  beforeEach(() => {
    // A stand-in for `security` that keeps each service's secret in a file.
    const bin = tempDir("fake-security-");
    store = tempDir("fake-keychain-");
    writeFileSync(
      join(bin, "security"),
      [
        "#!/bin/sh",
        'if [ "$1" = "find-generic-password" ]; then [ -f "$FAKE_KEYCHAIN/$3" ] || exit 44; cat "$FAKE_KEYCHAIN/$3"; exit 0; fi',
        'if [ "$1" = "-i" ]; then read -r cmd u sflag service aflag account wflag value; printf "%s\\n" "$value" > "$FAKE_KEYCHAIN/$service"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );
    chmodSync(join(bin, "security"), 0o755);
    process.env.PATH = `${bin}:${saved.path ?? ""}`;
    process.env.FAKE_KEYCHAIN = store;
    delete process.env.TUNELO_KEYSTORE;
    delete process.env.CHAT_AGENT_KEYSTORE;
  });

  afterEach(() => {
    process.env.PATH = saved.path;
    const restore = (v: string | undefined) => v ?? "";
    // An empty value reads as unset everywhere these are used.
    process.env.TUNELO_KEYSTORE = restore(saved.a);
    process.env.CHAT_AGENT_KEYSTORE = restore(saved.b);
    process.env.FAKE_KEYCHAIN = restore(saved.store);
  });

  const privateKey = async () => toBase64Url(await exportPrivateKey((await generateKeyPair(true)).privateKey));

  it("reads the old entry while the new one is missing, then copies it and keeps the old one", async () => {
    const key = await privateKey();
    writeFileSync(join(store, "com.hoandat.chat-agent"), `${key}\n`);
    const before = await machineKey(tempDir());
    expect(existsSync(join(store, "com.hoandat.tunelo"))).toBe(false);
    await copyLegacyMachineKey();
    await copyLegacyMachineKey();
    expect(readFileSync(join(store, "com.hoandat.tunelo"), "utf8").trim()).toBe(key);
    expect(readFileSync(join(store, "com.hoandat.chat-agent"), "utf8").trim()).toBe(key);
    const after = await machineKey(tempDir());
    expect(toBase64Url(after.publicKey)).toBe(toBase64Url(before.publicKey));
  });

  it("refuses two different keys and does nothing without an old one", async () => {
    await copyLegacyMachineKey();
    expect(existsSync(join(store, "com.hoandat.tunelo"))).toBe(false);
    writeFileSync(join(store, "com.hoandat.chat-agent"), `${await privateKey()}\n`);
    writeFileSync(join(store, "com.hoandat.tunelo"), `${await privateKey()}\n`);
    await expect(copyLegacyMachineKey()).rejects.toThrow(/two different machine keys/);
  });
});

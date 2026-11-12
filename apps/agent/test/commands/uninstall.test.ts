// `tunelo uninstall` on each OS, in a temporary home: what it deletes, the
// PATH line it takes out (only when ~/.local/bin holds nothing else), and on
// Windows the folders handed to a command that runs after exit. Nothing of
// the real machine is touched: logout, the key store, the user PATH and the
// detached command are stand-ins.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PATH_LINE, type UninstallDeps, type UninstallEnvironment, uninstall, uninstallTargets, withoutPathLine } from "../../src/commands/uninstall.ts";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tunelo-uninstall-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function deps(environment: UninstallEnvironment, over: Partial<UninstallDeps> = {}) {
  const steps: string[] = [];
  const d: UninstallDeps = {
    environment,
    logout: vi.fn(async () => {
      steps.push("logout");
      return 0;
    }),
    removeService: vi.fn(async () => {
      steps.push("service");
    }),
    deleteKeyStore: vi.fn(async () => {
      steps.push("keys");
    }),
    removeUserPath: vi.fn(async (dir: string) => {
      steps.push(`path ${dir}`);
    }),
    deleteAfterExit: vi.fn((dirs: string[]) => {
      steps.push(`after exit ${dirs.join(" | ")}`);
    }),
    log: () => undefined,
    ...over,
  };
  return { d, steps };
}

const profile = (text: string) => `# mine\nalias ll='ls -l'\n${text}`;

describe("uninstall targets", () => {
  test("macOS: the config folder in use and Application Support, the binaries in ~/.local/bin, the shell profiles", () => {
    const t = uninstallTargets({ platform: "darwin", home: "/Users/u", env: {}, configDir: "/Users/u/.config/tunelo", binary: "/Users/u/.local/bin/tunelo" });
    expect(t).toEqual({
      dirs: ["/Users/u/.config/tunelo", "/Users/u/Library/Application Support/tunelo"],
      files: ["/Users/u/.local/bin/tunelo", "/Users/u/.local/bin/tunelo-term-host"],
      profiles: [".zprofile", ".bash_profile", ".profile", ".bashrc", ".zshrc"].map((p) => `/Users/u/${p}`),
      pathDir: "/Users/u/.local/bin",
    });
  });

  test("Linux: a binary outside ~/.local/bin leaves PATH alone; a development run deletes no binary", () => {
    expect(uninstallTargets({ platform: "linux", home: "/home/u", env: {}, configDir: "/home/u/.config/tunelo", binary: "/opt/tunelo/tunelo" }).pathDir).toBeUndefined();
    expect(uninstallTargets({ platform: "linux", home: "/home/u", env: {}, configDir: "/home/u/.config/tunelo", binary: undefined })).toMatchObject({
      dirs: ["/home/u/.config/tunelo"],
      files: [],
      pathDir: undefined,
    });
  });

  test("Windows: %APPDATA%\\\\tunelo and %LOCALAPPDATA%\\\\tunelo, and the user PATH entry", () => {
    const env = { APPDATA: "C:\\\\Users\\\\u\\\\AppData\\\\Roaming", LOCALAPPDATA: "C:\\\\Users\\\\u\\\\AppData\\\\Local" };
    const t = uninstallTargets({ platform: "win32", home: "C:\\\\Users\\\\u", env, configDir: win32.join(env.APPDATA, "tunelo"), binary: "C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\tunelo\\\\tunelo.exe" });
    expect(t).toEqual({
      dirs: [win32.join(env.APPDATA, "tunelo"), win32.join(env.LOCALAPPDATA, "tunelo")],
      files: [],
      profiles: [],
      pathDir: win32.join(env.LOCALAPPDATA, "tunelo"),
    });
  });

  test("the PATH line goes with the blank line before it; the rest of a profile stays", () => {
    expect(withoutPathLine(profile(`\n${PATH_LINE}\n`))).toBe(profile(""));
    expect(withoutPathLine(profile(""))).toBe(profile(""));
  });
});

describe("tunelo uninstall", () => {
  function unixMachine(): UninstallEnvironment {
    const bin = join(home, ".local", "bin");
    const config = join(home, ".config", "tunelo");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(config, "term-host"), { recursive: true });
    for (const f of ["tunelo", "tunelo.old", "tunelo-term-host"]) writeFileSync(join(bin, f), "x");
    writeFileSync(join(config, "config.json"), "{}");
    writeFileSync(join(home, ".zprofile"), profile(`\n${PATH_LINE}\n`));
    writeFileSync(join(home, ".bashrc"), profile(""));
    return { platform: "linux", home, env: {}, configDir: config, binary: join(bin, "tunelo") };
  }

  test("Unix: logs out, deletes keys, settings and binaries, and the PATH line once ~/.local/bin is empty", async () => {
    const e = unixMachine();
    const { d, steps } = deps(e);
    expect(await uninstall(e.configDir, d)).toBe(0);
    expect(steps).toEqual(["logout", "keys"]);
    expect(existsSync(e.configDir)).toBe(false);
    for (const f of ["tunelo", "tunelo.old", "tunelo-term-host"]) expect(existsSync(join(home, ".local", "bin", f))).toBe(false);
    expect(readFileSync(join(home, ".zprofile"), "utf8")).toBe(profile(""));
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(profile(""));
  });

  test("Unix: another program in ~/.local/bin keeps the PATH line", async () => {
    const e = unixMachine();
    writeFileSync(join(home, ".local", "bin", "other-tool"), "x");
    const { d } = deps(e);
    await uninstall(e.configDir, d);
    expect(readFileSync(join(home, ".zprofile"), "utf8")).toContain(PATH_LINE);
    expect(existsSync(join(home, ".local", "bin", "other-tool"))).toBe(true);
  });

  test("a logout that fails early still removes the service, and the rest goes on", async () => {
    const e = unixMachine();
    const { d, steps } = deps(e, {
      logout: async () => {
        throw new Error("config unreadable");
      },
    });
    expect(await uninstall(e.configDir, d)).toBe(0);
    expect(steps).toEqual(["service", "keys"]);
    expect(existsSync(e.configDir)).toBe(false);
  });

  test("Windows: takes the folder out of the user PATH and deletes both folders after exit", async () => {
    const env = { APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local") };
    const e: UninstallEnvironment = { platform: "win32", home, env, configDir: win32.join(env.APPDATA, "tunelo"), binary: win32.join(env.LOCALAPPDATA, "tunelo", "tunelo.exe") };
    const { d, steps } = deps(e);
    expect(await uninstall(e.configDir, d)).toBe(0);
    expect(steps).toEqual([
      "logout",
      "keys",
      `path ${win32.join(env.LOCALAPPDATA, "tunelo")}`,
      `after exit ${win32.join(env.APPDATA, "tunelo")} | ${win32.join(env.LOCALAPPDATA, "tunelo")}`,
    ]);
  });
});

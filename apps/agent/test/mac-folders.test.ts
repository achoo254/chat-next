// Folders macOS protects: which paths fall in one, what tunelo may do in
// each, and asking macOS only once the user agreed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { MacFolderRefused, MacFolders, type MacFoldersOptions, type ProbeAnswer, probeHere, protectedFolderOf } from "../src/safety/mac-folders.ts";
import { tempDir } from "./harness.ts";

// macOS folder logic is built on POSIX paths (/Users/...).
const posix = process.platform !== "win32";

const HOME = "/Users/an";
const notStartup = () => false;

describe("protectedFolderOf", () => {
  test.skipIf(!posix)("Desktop, Documents, Downloads and iCloud Drive, at any depth", () => {
    expect(protectedFolderOf(`${HOME}/Documents`, HOME, notStartup)).toBe(`${HOME}/Documents`);
    expect(protectedFolderOf(`${HOME}/Desktop/a/b`, HOME, notStartup)).toBe(`${HOME}/Desktop`);
    expect(protectedFolderOf(`${HOME}/Downloads/x`, HOME, notStartup)).toBe(`${HOME}/Downloads`);
    expect(protectedFolderOf(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/p`, HOME, notStartup)).toBe(`${HOME}/Library/Mobile Documents`);
  });

  test.skipIf(!posix)("each cloud provider's folder and each other volume is its own", () => {
    expect(protectedFolderOf(`${HOME}/Library/CloudStorage/GoogleDrive-an/My Drive`, HOME, notStartup)).toBe(`${HOME}/Library/CloudStorage/GoogleDrive-an`);
    expect(protectedFolderOf("/Volumes/USB/work", HOME, notStartup)).toBe("/Volumes/USB");
    expect(protectedFolderOf("/Volumes/Macintosh HD/Users", HOME, (v) => v === "/Volumes/Macintosh HD")).toBeUndefined();
  });

  test("anything else is outside them, including names that only start alike", () => {
    for (const path of [HOME, `${HOME}/work`, `${HOME}/Documents2`, `${HOME}/Library/CloudStorage`, "/tmp", "/Volumes"]) {
      expect(protectedFolderOf(path, HOME, notStartup)).toBeUndefined();
    }
  });
});

function folders(over: Partial<MacFoldersOptions> = {}) {
  const saved: Record<string, "granted" | "denied"> = {};
  const changes: number[] = [];
  const probes: string[] = [];
  let finish: (a: ProbeAnswer | undefined) => void = () => undefined;
  const f = new MacFolders({
    platform: "darwin",
    home: HOME,
    saved: () => saved,
    save: (folder, a) => (saved[folder] = a),
    forget: (folder) => Reflect.deleteProperty(saved, folder),
    fullDiskAccess: () => false,
    probe: (folder) => {
      probes.push(folder);
      return new Promise((r) => (finish = r));
    },
    onChange: () => changes.push(changes.length),
    log: () => undefined,
    folders: () => [`${HOME}/Desktop`, `${HOME}/Documents`],
    isStartupVolume: notStartup,
    ...over,
  });
  return { f, saved, changes, probes, finish: (a: ProbeAnswer | undefined) => finish(a) };
}

describe("MacFolders", () => {
  test.skipIf(!posix)("taking a folder back forgets macOS's answer, fences the AI out again and says so; nothing to take back with Full Disk Access", () => {
    const { f, saved, changes } = folders();
    saved[`${HOME}/Documents`] = "granted";
    expect(f.allows(`${HOME}/Documents/p`)).toBe(true);
    expect(f.aiFences().deny).not.toContain(`${HOME}/Documents`);
    expect(f.revoke(`${HOME}/Documents`)).toBe("revoked");
    expect(saved[`${HOME}/Documents`]).toBeUndefined();
    expect(f.access(`${HOME}/Documents`)).toBe("not-asked");
    expect(f.aiFences().deny).toContain(`${HOME}/Documents`);
    expect(changes.length).toBeGreaterThan(0);
    // Not one of the protected folders: nothing happens.
    expect(f.revoke(`${HOME}/work`)).toBe("not-protected");
    expect(f.revoke(`${HOME}/Documents/p`)).toBe("not-protected");
    const fda = folders({ fullDiskAccess: () => true });
    expect(fda.f.revoke(`${HOME}/Documents`)).toBe("full-disk-access");
  });


  test.skipIf(!posix)("a folder never asked for is refused, with the folder it falls in", () => {
    const { f } = folders();
    expect(f.allows(`${HOME}/work`)).toBe(true);
    expect(f.allows(`${HOME}/Documents/p`)).toBe(false);
    expect(() => f.assert(`${HOME}/Documents/p`)).toThrow(MacFolderRefused);
    try {
      f.assert(`${HOME}/Documents/p`);
    } catch (err) {
      expect(err).toMatchObject({ folder: `${HOME}/Documents`, access: "not-asked" });
    }
  });

  test("Full Disk Access given before opens every folder; a saved answer counts", () => {
    expect(folders({ fullDiskAccess: () => true }).f.allows(`${HOME}/Desktop/x`)).toBe(true);
    const { f, saved } = folders();
    saved[`${HOME}/Desktop`] = "granted";
    saved[`${HOME}/Documents`] = "denied";
    expect(f.list()).toEqual([
      { path: `${HOME}/Desktop`, access: "granted" },
      { path: `${HOME}/Documents`, access: "denied" },
    ]);
  });

  test.skipIf(!posix)("asks macOS only for a protected folder itself, once at a time, and keeps its answer", async () => {
    const { f, saved, changes, probes, finish } = folders();
    expect(f.ask(`${HOME}/Documents/p`)).toBe(false);
    expect(f.ask(`${HOME}/work`)).toBe(false);
    expect(f.ask(`${HOME}/Documents`)).toBe(true);
    expect(f.ask(`${HOME}/Documents`)).toBe(true);
    expect(probes).toEqual([`${HOME}/Documents`]);
    expect(f.access(`${HOME}/Documents`)).toBe("asking");
    expect(changes).toHaveLength(1);
    finish("granted");
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(saved).toEqual({ [`${HOME}/Documents`]: "granted" });
    expect(f.allows(`${HOME}/Documents/p`)).toBe(true);
  });

  test.skipIf(!posix)("a prompt nobody answered, or a folder that is gone, leaves it not asked", async () => {
    for (const answer of [undefined, "missing"] as const) {
      const { f, saved, changes, finish } = folders();
      f.ask(`${HOME}/Desktop`);
      finish(answer);
      await vi.waitFor(() => expect(changes).toHaveLength(2));
      expect(saved).toEqual({});
      expect(f.access(`${HOME}/Desktop`)).toBe("not-asked");
    }
  });

  test("off macOS nothing is protected", () => {
    const { f } = folders({ platform: "linux" });
    expect(f.allows(`${HOME}/Documents/p`)).toBe(true);
    expect(f.list()).toEqual([]);
    expect(f.ask(`${HOME}/Documents`)).toBe(false);
  });
});

describe("probeHere", () => {
  test("granted for a readable folder, missing for none", () => {
    const dir = join(tempDir(), "readable");
    mkdirSync(dir);
    expect(probeHere(dir)).toBe("granted");
    expect(probeHere(join(dir, "gone"))).toBe("missing");
  });
});

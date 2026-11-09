// `tunelo install` changes nothing before the sign-in succeeded, and puts
// the previous config and service back when installing the service fails.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type InstallDeps, install } from "../../src/commands/install.ts";
import { ConfigStore } from "../../src/config.ts";
import type { DiskAccess } from "../../src/safety/disk-access.ts";

const KEY = "K".repeat(43);
const SECRET = "S".repeat(43);

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-install-"));
  new ConfigStore(dir).update((c) => {
    c.machineId = "5";
    c.machineSecret = "o".repeat(43);
    c.claimed = true;
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(over: Partial<InstallDeps> = {}) {
  let running = true;
  const d = {
    readSecret: vi.fn(async () => `${SECRET}\n`),
    signIn: vi.fn(async () => undefined),
    isRunning: vi.fn(async () => running),
    stopService: vi.fn(async () => {
      running = false;
    }),
    startService: vi.fn(async () => {
      running = true;
    }),
    installService: vi.fn(async () => "launchd"),
    ensureMachineKey: vi.fn(async () => undefined),
    serviceDiskAccess: vi.fn(async (): Promise<DiskAccess> => "granted"),
    openDiskAccessSettings: vi.fn(),
    log: vi.fn(),
    ...over,
  };
  return d;
}

describe("tunelo install", () => {
  test("an abandoned sign-in leaves the machine, its config and its service as they were", async () => {
    const d = deps({ signIn: vi.fn(async () => Promise.reject(new Error("The code expired"))) });
    await expect(install(dir, { trust: KEY }, d)).rejects.toThrow("The code expired");
    expect(d.stopService).not.toHaveBeenCalled();
    expect(d.installService).not.toHaveBeenCalled();
    expect(new ConfigStore(dir).get()).toMatchObject({ machineId: "5", claimed: true });
    expect(new ConfigStore(dir).get().install).toBeUndefined();
  });

  test("a service that cannot be installed puts the previous config back and starts the service again", async () => {
    const d = deps({ installService: vi.fn(async () => Promise.reject(new Error("launchctl failed"))) });
    await expect(install(dir, { trust: KEY }, d)).rejects.toThrow("launchctl failed");
    expect(d.stopService).toHaveBeenCalledTimes(1);
    expect(d.startService).toHaveBeenCalledTimes(1);
    const c = new ConfigStore(dir).get();
    expect(c).toMatchObject({ machineId: "5", machineSecret: "o".repeat(43), claimed: true });
    expect(c.install).toBeUndefined();
  });

  test("signed in: the machine is added again, paired with the browser that showed the command", async () => {
    const d = deps();
    await install(dir, { trust: KEY }, d);
    const signedIn = vi.mocked(d.signIn).mock.invocationCallOrder[0] ?? 0;
    const stopped = vi.mocked(d.stopService).mock.invocationCallOrder[0] ?? 0;
    const installed = vi.mocked(d.installService).mock.invocationCallOrder[0] ?? 0;
    expect(signedIn).toBeGreaterThan(0);
    expect(stopped).toBeGreaterThan(signedIn);
    expect(installed).toBeGreaterThan(stopped);
    const c = new ConfigStore(dir).get();
    expect(c.install).toEqual({ deviceKey: KEY, secret: SECRET });
    expect(c.machineId).toBeUndefined();
    expect(c.claimed).toBeUndefined();
  });

  test("a service without Full Disk Access: the steps are shown and the setting opens", async () => {
    const d = deps({ serviceDiskAccess: vi.fn(async (): Promise<DiskAccess> => "needed") });
    await install(dir, { trust: KEY }, d);
    expect(d.openDiskAccessSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.log).mock.calls.flat().join("\n")).toMatch(/Full Disk Access/);
  });

  test("a service with Full Disk Access, or off macOS: nothing opens", async () => {
    for (const access of ["granted", "not-applicable"] as const) {
      const d = deps({ serviceDiskAccess: vi.fn(async (): Promise<DiskAccess> => access) });
      await install(dir, { trust: KEY }, d);
      expect(d.openDiskAccessSettings).not.toHaveBeenCalled();
    }
  });

  test("refuses a malformed key or secret before signing in", async () => {
    const d = deps({ readSecret: vi.fn(async () => "short") });
    await expect(install(dir, { trust: KEY }, d)).rejects.toThrow(/stdin/);
    await expect(install(dir, { trust: "bad" }, deps())).rejects.toThrow(/usage/);
    expect(d.signIn).not.toHaveBeenCalled();
  });
});

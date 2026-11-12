// `tunelo logout`: Chat and Localman first, nothing changed when they cannot
// be reached (unless --force), then the service, the sign-in and the
// machine's place; the binary and the machine key stay.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type LogoutDeps, logout } from "../../src/commands/logout.ts";
import { ConfigStore } from "../../src/config.ts";
import { SessionExpiredError } from "../../src/identity/session.ts";
import { MachineApiError } from "../../src/machine-api.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-logout-"));
  new ConfigStore(dir).update((c) => {
    c.machineId = "5";
    c.machineSecret = "o".repeat(43);
    c.trustedDevices = { list: [{ key: "k", name: "phone", platform: "ios", createdAt: 1 }], syncedAt: 1 };
    c.localman = { sub: "acc", deviceId: "tunelo.5", linkedAt: 1 };
  });
  // The machine key stays.
  writeFileSync(join(dir, "machine-key"), "key");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(over: Partial<LogoutDeps> = {}) {
  const steps: string[] = [];
  const d: LogoutDeps = {
    unregister: vi.fn(async (secret: string) => steps.push(`unregister ${secret.slice(0, 3)}`)),
    tunnelToken: vi.fn(async () => "tunnel-token"),
    listLinks: vi.fn(async () => [
      { id: "l1", deviceId: "tunelo.5" },
      { id: "l2", deviceId: "tunelo.9" },
    ]),
    revokeLink: vi.fn(async (_t: string, id: string) => {
      steps.push(`revoke ${id}`);
    }),
    removeService: vi.fn(async () => {
      steps.push("service");
    }),
    signOut: vi.fn(async () => {
      steps.push("sign-out");
      return { issuer: "https://auth.example" };
    }),
    forgetLegacyKey: vi.fn(() => false),
    log: () => undefined,
    ...over,
  };
  return { d, steps };
}

describe("tunelo logout", () => {
  test("removes the machine in Chat, its Localman link only, stops the service, signs out, forgets its place", async () => {
    const { d, steps } = deps();
    expect(await logout(dir, { force: false }, d)).toBe(0);
    expect(steps).toEqual(["unregister ooo", "revoke l1", "service", "sign-out"]);
    const c = new ConfigStore(dir).get();
    for (const field of ["machineId", "machineSecret", "trustedDevices", "localman", "machineRemoved"]) expect(c).not.toHaveProperty(field);
    expect(existsSync(join(dir, "machine-key"))).toBe(true);
  });

  test("without the network nothing changes and --force is suggested", async () => {
    const lines: string[] = [];
    const { d, steps } = deps({
      unregister: async () => {
        throw new TypeError("fetch failed");
      },
      log: (l) => lines.push(l),
    });
    expect(await logout(dir, { force: false }, d)).toBe(1);
    expect(steps).toEqual([]);
    expect(new ConfigStore(dir).get().machineId).toBe("5");
    expect(lines.join("\n")).toContain("tunelo logout --force");
  });

  test("--force goes on without the network and forgets the machine here", async () => {
    const { d, steps } = deps({
      unregister: async () => {
        throw new TypeError("fetch failed");
      },
      listLinks: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await logout(dir, { force: true }, d)).toBe(0);
    expect(steps).toEqual(["service", "sign-out"]);
    expect(new ConfigStore(dir).get().machineId).toBeUndefined();
  });

  test("a machine Chat already removed, and a sign-in that no longer opens, still log out", async () => {
    const { d, steps } = deps({
      unregister: async () => {
        throw new MachineApiError("unauthenticated", "machine secret not accepted");
      },
      tunnelToken: async () => {
        throw new SessionExpiredError();
      },
    });
    expect(await logout(dir, { force: false }, d)).toBe(0);
    expect(steps).toEqual(["service", "sign-out"]);
  });

  test("a machine that never joined Chat only signs out", async () => {
    new ConfigStore(dir).update((c) => {
      delete c.machineId;
      delete c.machineSecret;
    });
    const { d, steps } = deps();
    expect(await logout(dir, { force: false }, d)).toBe(0);
    expect(d.unregister).not.toHaveBeenCalled();
    expect(d.tunnelToken).not.toHaveBeenCalled();
    expect(steps).toEqual(["service", "sign-out"]);
  });
});

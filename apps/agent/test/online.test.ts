// Chat or Localman failing never holds back the machine tunnel: a machine that
// already has its place in Chat opens its tunnel at once, whatever Chat or
// Localman answer; a new one opens it as soon as Chat adds it, and links
// itself to Localman then. Each heartbeat hands the account's devices to the
// machine; a removal on the web closes everything until a new sign-in.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore, type TrustedDevice } from "../src/config.ts";
import { DeviceTrust } from "../src/device-trust.ts";
import type { Machine } from "../src/machine.ts";

const state = vi.hoisted(() => ({
  opened: [] as string[],
  openedWith: [] as Record<string, unknown>[],
  registerFails: true,
  links: [] as string[],
  beats: [] as { secret: string; connected: number }[],
  reply: undefined as undefined | Record<string, unknown>,
}));

vi.mock("@tunelo/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tunelo/client")>();
  return {
    ...real,
    linkMachineToApp: async (o: { deviceId: string }) => {
      state.links.push(o.deviceId);
      throw new real.SelfLinkError(503, null);
    },
  };
});

vi.mock("../src/tunnel.ts", () => ({
  TUNNEL_SERVER: "https://tunnel.example",
  isSignedIn: () => true,
  openTunnel: (opts: { deviceId: string }) => {
    state.opened.push(opts.deviceId);
    state.openedWith.push({ ...opts });
    return () => undefined;
  },
}));

vi.mock("../src/identity/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/identity/session.ts")>()),
  identitySession: () => ({
    info: () => ({ issuer: "https://auth.example", sub: "acc_1", clientId: "tunelo-agent" }),
    covers: () => true,
    getAppToken: async () => "token",
  }),
}));

vi.mock("../src/machine-api.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/machine-api.ts")>();
  return {
    ...real,
    registerMachine: async () => {
      if (state.registerFails) throw new real.MachineApiError("failed_precondition", "chat_account_missing: open the chat first");
      return { machineId: "12", machineSecret: "n".repeat(43) };
    },
    heartbeat: async (secret: string, body: { connectedDeviceKeys: Uint8Array[] }) => {
      state.beats.push({ secret, connected: body.connectedDeviceKeys.length });
      if (!state.reply) throw new Error("Chat is down");
      return state.reply;
    },
    notifyNeedsInput: async () => ({}),
    notifyUsageHint: async () => ({}),
  };
});

const { goOnline } = await import("../src/online.ts");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-online-"));
  state.opened = [];
  state.openedWith = [];
  state.registerFails = true;
  state.links = [];
  state.beats = [];
  state.reply = undefined;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type FakeMachine = Machine & { applied: TrustedDevice[][]; left: number };

function fakeMachine(config: ConfigStore): FakeMachine {
  const fake = {
    config,
    applied: [] as TrustedDevice[][],
    left: 0,
    keyPair: { publicKey: new Uint8Array(32) },
    trust: new DeviceTrust({ config }),
    setNotify: () => undefined,
    setNotifyUsage: () => undefined,

    connectedDeviceKeys: () => [new Uint8Array(32).fill(9)],
    applyTrustedDevices(list: TrustedDevice[]) {
      fake.applied.push(list);
      config.syncTrustedDevices(list);
    },
    leftAccount() {
      fake.left++;
    },
    audit: { write: () => undefined },
    localForward: {
      state: () => ({ enabled: true, available: false, blockedPorts: [] }),
      tunnelConnected: () => undefined,
      tunnelDisconnected: () => undefined,
    },
  };
  // Only these members are reached while going online.
  return fake as unknown as FakeMachine;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("going online", () => {
  test("a machine with a place in Chat opens its tunnel although Chat fails", async () => {
    const config = new ConfigStore(dir);
    config.update((c) => {
      c.machineId = "5";
      c.machineSecret = "o".repeat(43);
    });
    const online = goOnline(fakeMachine(config), 1234, () => undefined);
    await settle();
    expect(state.opened).toEqual(["tunelo.5"]);
    // Already in Chat: nothing to register, and a heartbeat that failed changes nothing.
    expect(online.registration.report().chat.status).toBe("ok");
    expect(state.beats.length).toBeGreaterThan(0);
    expect(state.links).toEqual(["tunelo.5"]);
    expect(online.registration.report().localman.status).toBe("waiting");
    online.stop();
  });

  test("a new machine waits for Chat without failing, then opens its tunnel once added", async () => {
    const config = new ConfigStore(dir);
    const online = goOnline(fakeMachine(config), 1234, () => undefined);
    await settle();
    expect(state.opened).toEqual([]);
    expect(online.registration.report().chat.status).toBe("waiting");
    state.registerFails = false;
    online.registration.retryNow();
    await settle();
    expect(state.opened).toEqual(["tunelo.12"]);
    expect(state.links).toEqual(["tunelo.12"]);
    online.stop();
  });

  test("a machine added again opens the tunnel of its new id, never the name its old id held", async () => {
    // Removed on the web as machine 1, added again by `tunelo login` as
    // machine 3: the config still holds the subdomain machine 1's tunnel got.
    // The relay derives the name from the account and the device id and
    // refuses any other, which held the machine offline for good.
    const config = new ConfigStore(dir);
    config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
      c.subdomain = "m-708503bbc4a9c5958a61b600e9274c";
    });
    const online = goOnline(fakeMachine(config), 1234, () => undefined);
    await settle();
    expect(state.opened).toEqual(["tunelo.3"]);
    expect(state.openedWith[0]).not.toHaveProperty("subdomain");
    online.stop();
  });
});

describe("heartbeats", () => {
  const device: TrustedDevice = { key: "k".repeat(43), name: "phone", platform: "ios", createdAt: 1_000 };

  test("hand the account's devices to the machine and report the connected ones", async () => {
    const config = new ConfigStore(dir);
    config.update((c) => {
      c.machineId = "5";
      c.machineSecret = "o".repeat(43);
    });
    state.reply = { revoked: false, minAgentVersion: "3.0.0", tunnelRefused: false, trustedDevices: [device] };
    const m = fakeMachine(config);
    const online = goOnline(m, 1234, () => undefined);
    await settle();
    expect(m.applied.at(-1)).toEqual([device]);
    expect(state.beats.at(-1)).toEqual({ secret: "o".repeat(43), connected: 1 });
    online.stop();
  });

  test("a device the machine does not know makes it beat at once", async () => {
    const config = new ConfigStore(dir);
    config.update((c) => {
      c.machineId = "5";
      c.machineSecret = "o".repeat(43);
    });
    state.reply = { revoked: false, minAgentVersion: "3.0.0", tunnelRefused: false, trustedDevices: [] };
    const m = fakeMachine(config);
    const online = goOnline(m, 1234, () => undefined);
    await settle();
    const before = state.beats.length;
    expect(await m.trust.check(new Uint8Array(32).fill(3))).toBe("unknown");
    expect(state.beats.length).toBe(before + 1);
    online.stop();
  });

  test("a removal on the web closes every link and stops; a new sign-in adds the machine with a new secret", async () => {
    const config = new ConfigStore(dir);
    config.update((c) => {
      c.machineId = "5";
      c.machineSecret = "o".repeat(43);
    });
    state.reply = { revoked: true, minAgentVersion: "3.0.0", tunnelRefused: false, trustedDevices: [] };
    const m = fakeMachine(config);
    const online = goOnline(m, 1234, () => undefined);
    await settle();
    expect(m.left).toBe(1);
    expect(config.get()).toMatchObject({ machineRemoved: true });
    expect(config.get().machineSecret).toBeUndefined();
    expect(online.registration.report().chat.status).toBe("off");

    state.reply = { revoked: false, minAgentVersion: "3.0.0", tunnelRefused: false, trustedDevices: [device] };
    state.registerFails = false;
    online.registration.retryNow(true);
    await settle();
    await settle();
    expect(state.opened).toEqual(["tunelo.5", "tunelo.12"]);
    expect(state.beats.at(-1)?.secret).toBe("n".repeat(43));
    online.stop();
  });
});

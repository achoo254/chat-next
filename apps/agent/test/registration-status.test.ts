// The machine's place in Chat after `tunelo login`: added by the service
// with the account and its machine key, waiting with backoff while the
// account has not opened Chat, never holding back the machine tunnel when
// Chat fails, and out after a removal on the web until a new sign-in.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeyPair, generateKeyPair } from "@achoo254/chat-remote-protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { type AppName, ResourceNotGrantedError, type SessionInfo } from "../src/identity/session.ts";
import { MachineApiError } from "../src/machine-api.ts";
import {
  type AppSession,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  Registration,
  type RegistrationDeps,
  describeApps,
  retryDelay,
  storedReport,
} from "../src/registration-status.ts";

const AGENT: SessionInfo = { issuer: "https://auth.example", sub: "acc_1", clientId: "tunelo-agent" };
const CLI: SessionInfo = { issuer: "https://auth.example", sub: "acc_1", clientId: "tunelo-cli" };

let dir = "";
let machineKey: KeyPair;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-registration-"));
  machineKey = await generateKeyPair();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeSession(info: SessionInfo | undefined): AppSession & { asked: AppName[] } {
  const asked: AppName[] = [];
  const agent = info?.clientId === "tunelo-agent";
  return {
    asked,
    info: () => info,
    covers: (app) => info !== undefined && (agent || app === "tunnel"),
    getAppToken: async (app) => {
      asked.push(app);
      if (!agent && app !== "tunnel") throw new ResourceNotGrantedError(app);
      return `token-${app}`;
    },
  };
}

const missingAccount = () => new MachineApiError("failed_precondition", "chat_account_missing: this account has not opened the chat yet");

function setup(info: SessionInfo | undefined, api: Partial<RegistrationDeps["api"]> = {}) {
  const config = new ConfigStore(dir);
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const registered = vi.fn();
  const register = vi.fn(api.register ?? (async () => ({ machineId: "7", machineSecret: "s".repeat(43) })));
  const session = fakeSession(info);
  let now = 1_000_000;
  const registration = new Registration({
    config,
    session,
    api: { register },
    machineKey: () => machineKey,
    agentVersion: "3.0.0",
    onRegistered: registered,
    log: () => undefined,
    now: () => now,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  /** Runs the newest pending retry, as its timer would. */
  const fire = async () => {
    const t = timers.filter((x) => !x.cancelled).at(-1);
    if (!t) throw new Error("no retry pending");
    t.cancelled = true;
    now += t.ms;
    t.fn();
    await settle();
  };
  return { config, registration, register, registered, timers, session, fire };
}

/** Lets the registration's run finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("registration status", () => {
  test("backoff: 1 minute, doubling, at most 1 hour", () => {
    expect([1, 2, 3, 4, 6, 7, 50].map(retryDelay)).toEqual([60_000, 120_000, 240_000, 480_000, 1_920_000, RETRY_MAX_MS, RETRY_MAX_MS]);
    expect(retryDelay(1)).toBe(RETRY_FIRST_MS);
  });

  test("signed in with the account: the machine is added with its key, and its tunnel opens", async () => {
    const s = setup(AGENT);
    s.registration.start();
    await settle();
    expect(s.register).toHaveBeenCalledWith("token-chat", machineKey, "3.0.0");
    expect(s.session.asked).toEqual(["chat"]);
    expect(s.config.get()).toMatchObject({ machineId: "7", machineSecret: "s".repeat(43) });
    expect(s.registered).toHaveBeenCalledTimes(1);
    expect(s.registration.report().chat).toEqual({ status: "ok", detail: "in AI Agent (machine 7)" });
    expect(s.registration.report().localman.status).toBe("ok");
  });

  test("an account that never opened Chat waits with backoff; the tunnel state is left alone", async () => {
    let fails = 3;
    const s = setup(AGENT, {
      register: async () => {
        if (fails-- > 0) throw missingAccount();
        return { machineId: "8", machineSecret: "t".repeat(43) };
      },
    });
    s.registration.setTunnel({ status: "ok", detail: "online at wss://x" });
    s.registration.start();
    await settle();
    expect(s.registration.report().chat).toMatchObject({ status: "waiting", retryAt: 1_000_000 + 60_000 });
    expect(s.registration.report().tunnel).toEqual({ status: "ok", detail: "online at wss://x" });
    expect(s.timers.map((t) => t.ms)).toEqual([60_000]);
    await s.fire();
    await s.fire();
    expect(s.timers.map((t) => t.ms)).toEqual([60_000, 120_000, 240_000]);
    expect(s.registered).not.toHaveBeenCalled();
    await s.fire();
    expect(s.registration.report().chat.status).toBe("ok");
    expect(s.registered).toHaveBeenCalledTimes(1);
    expect(s.config.get().machineId).toBe("8");
  });

  test("tunelo login retries at once and forgets the backoff", async () => {
    let fail = true;
    const s = setup(AGENT, {
      register: async () => {
        if (fail) throw new Error("fetch failed");
        return { machineId: "9", machineSecret: "u".repeat(43) };
      },
    });
    s.registration.start();
    await settle();
    expect(s.registration.report().chat).toMatchObject({ status: "error", detail: expect.stringContaining("fetch failed") });
    fail = false;
    s.registration.retryNow();
    await settle();
    expect(s.timers[0]?.cancelled).toBe(true);
    expect(s.registration.report().chat.status).toBe("ok");
  });

  test("a registered machine is not registered again: tunelo login keeps its id and secret", async () => {
    const s = setup(AGENT);
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
    });
    s.registration.start();
    s.registration.retryNow(true);
    await settle();
    expect(s.register).not.toHaveBeenCalled();
    expect(s.config.get()).toMatchObject({ machineId: "3", machineSecret: "o".repeat(43) });
    expect(s.registration.report().chat).toEqual({ status: "ok", detail: "in AI Agent (machine 3)" });
  });

  test("a refused key proof or too many machines is an error with backoff", async () => {
    const s = setup(AGENT, {
      register: async () => {
        throw new MachineApiError("resource_exhausted", "too_many_machines: the account has 20 machines");
      },
    });
    s.registration.start();
    await settle();
    expect(s.registration.report().chat).toMatchObject({ status: "error", detail: expect.stringContaining("20 machines") });
    expect(s.timers).toHaveLength(1);
  });

  test("a tunnel Chat does not list shows as a Chat error until it is listed again", async () => {
    const s = setup(AGENT);
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
    });
    s.registration.tunnelListed(false);
    expect(s.registration.report().chat).toMatchObject({ status: "error", detail: expect.stringContaining("another account") });
    s.registration.tunnelListed(true);
    expect(s.registration.report().chat.status).toBe("ok");
  });

  test("a tunnel-only sign-in asks for tunelo login and calls nothing", async () => {
    const s = setup(CLI);
    s.registration.start();
    await settle();
    expect(s.session.asked).toEqual([]);
    expect(s.register).not.toHaveBeenCalled();
    expect(s.registration.report()).toMatchObject({ chat: { status: "sign-in" }, localman: { status: "sign-in" } });
    expect(s.timers).toHaveLength(0);
  });

  test("a machine removed on the web is not added again until a new sign-in", async () => {
    const s = setup(AGENT);
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
      c.localman = { sub: "acc_1", deviceId: "tunelo.3", linkedAt: 1 };
    });
    s.registration.removed();
    expect(s.config.get()).toMatchObject({ machineRemoved: true });
    expect(s.config.get().localman).toBeUndefined();
    // `tunelo login` without a new sign-in: still out.
    s.registration.retryNow(false);
    await settle();
    expect(s.register).not.toHaveBeenCalled();
    expect(s.config.get().machineId).toBeUndefined();
    expect(s.registration.report().chat).toMatchObject({ status: "off", detail: expect.stringContaining("tunelo login") });
    // A new sign-in adds it again (a new row in Chat, with a new id).
    s.registration.retryNow(true);
    expect(s.registration.report().chat.status).toBe("waiting");
    await settle();
    expect(s.register).toHaveBeenCalledTimes(1);
    expect(s.config.get()).toMatchObject({ machineId: "7" });
    expect(s.config.get().machineRemoved).toBeUndefined();
    expect(s.registered).toHaveBeenCalledTimes(1);
  });

  test("status lines name each app, and the stored report works without the service", () => {
    const config = new ConfigStore(dir);
    const report = storedReport(config, fakeSession(AGENT));
    expect(report.tunnel.status).toBe("off");
    const lines = describeApps({ ...report, chat: { status: "waiting", detail: "open Chat once", retryAt: 1_000_000 + 120_000 } }, 1_000_000);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Tunnel\s+off/);
    expect(lines[1]).toBe("Chat      waiting  open Chat once (next try in 2 min)");
    expect(lines[2]).toMatch(/^Localman\s+ok/);
  });
});

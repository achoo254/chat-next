// The machine's place in Chat after `tunelo login`: added (or claimed) with
// the account, waiting with backoff while the account has not opened Chat,
// and never holding back the machine tunnel when Chat fails.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-registration-"));
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
  const claim = vi.fn(api.claim ?? (async () => ({ machineId: "7" })));
  const session = fakeSession(info);
  let now = 1_000_000;
  const registration = new Registration({
    config,
    session,
    api: { register, claim },
    publicKey: () => new Uint8Array(32).fill(5),
    agentVersion: "2.1.0",
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
  return { config, registration, register, claim, registered, timers, session, fire };
}

/** Lets the registration's run finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("registration status", () => {
  test("backoff: 1 minute, doubling, at most 1 hour", () => {
    expect([1, 2, 3, 4, 6, 7, 50].map(retryDelay)).toEqual([60_000, 120_000, 240_000, 480_000, 1_920_000, RETRY_MAX_MS, RETRY_MAX_MS]);
    expect(retryDelay(1)).toBe(RETRY_FIRST_MS);
  });

  test("signed in with the account: the machine is added, claimed, and its tunnel opens", async () => {
    const s = setup(AGENT);
    s.registration.start();
    await settle();
    expect(s.register).toHaveBeenCalledWith("token-chat", new Uint8Array(32).fill(5), "2.1.0");
    expect(s.session.asked).toEqual(["chat"]);
    expect(s.config.get()).toMatchObject({ machineId: "7", machineSecret: "s".repeat(43), claimed: true });
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

  test("a machine of an install code is claimed once signed in with the account, and keeps its place", async () => {
    const s = setup(AGENT);
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
    });
    s.registration.start();
    await settle();
    expect(s.claim).toHaveBeenCalledWith("token-chat", "o".repeat(43));
    expect(s.register).not.toHaveBeenCalled();
    expect(s.config.get()).toMatchObject({ machineId: "3", claimed: true });
    // Already claimed: nothing more to ask.
    s.registration.retryNow();
    await settle();
    expect(s.claim).toHaveBeenCalledTimes(1);
  });

  test("a claim refused for another account is an error with backoff, not a new machine", async () => {
    const s = setup(AGENT, {
      claim: async () => {
        throw new MachineApiError("permission_denied", "claim_wrong_account: the machine belongs to another account");
      },
    });
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
    });
    s.registration.start();
    await settle();
    expect(s.registration.report().chat).toMatchObject({ status: "error", detail: expect.stringContaining("another Chat account") });
    expect(s.register).not.toHaveBeenCalled();
    expect(s.timers).toHaveLength(1);
  });

  test("a machine removed on the web while unclaimed stops trying", async () => {
    const s = setup(AGENT, {
      claim: async () => {
        throw new MachineApiError("permission_denied", "machine_revoked: the machine was removed from the account");
      },
    });
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
    });
    s.registration.start();
    await settle();
    expect(s.registration.report().chat.status).toBe("off");
    expect(s.timers).toHaveLength(0);
    expect(s.config.get().machineId).toBeUndefined();
  });

  test("a tunnel Chat does not list shows as a Chat error until it is listed again", async () => {
    const s = setup(AGENT);
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
      c.claimed = true;
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

  test("the heartbeat asks for a claim when the server lost it", async () => {
    const s = setup(AGENT);
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
      c.claimed = true;
    });
    s.registration.claimNeeded();
    await settle();
    expect(s.claim).toHaveBeenCalledTimes(1);
    expect(s.config.get().claimed).toBe(true);
  });

  test("a machine removed on the web is not added again", async () => {
    const s = setup(AGENT);
    s.config.update((c) => {
      c.machineId = "3";
      c.machineSecret = "o".repeat(43);
      c.claimed = true;
    });
    s.registration.removed();
    s.registration.retryNow();
    await settle();
    expect(s.register).not.toHaveBeenCalled();
    expect(s.config.get().machineId).toBeUndefined();
    expect(s.registration.report().chat.status).toBe("off");
  });

  test("whoami lines name each app, and the stored report works without the service", () => {
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

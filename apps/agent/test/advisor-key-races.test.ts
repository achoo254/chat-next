// Advisor's key while several requests overlap: opening the key to hand it on
// waits on the OS key store, and a key set or removed during that wait stays
// set or removed; an older account key never replaces a newer one, and a set
// time far past the machine's clock is brought back to it.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorKeyStore, MAX_SET_AHEAD_MS } from "../src/advisor/advisor-key-store.ts";
import { forgetSecrets } from "../src/mcp/redact.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { SecretStore } from "../src/sign-in-secrets/secret-store.ts";
import { tempDir } from "./harness.ts";

process.env.TUNELO_KEYSTORE = "file";

/** Unseals wait for this gate while it is held: the OS key store answering slowly. */
const gate = vi.hoisted(() => ({ held: false, waiting: [] as Array<() => void> }));

vi.mock("../src/keystore.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/keystore.ts")>();
  return {
    ...real,
    unseal: async (dir: string, sealed: string) => {
      if (gate.held) await new Promise<void>((resolve) => gate.waiting.push(resolve));
      return real.unseal(dir, sealed);
    },
  };
});

function hold(): void {
  gate.held = true;
}

function release(): void {
  gate.held = false;
  for (const resolve of gate.waiting.splice(0)) resolve();
}

/** Lets pending promise work run, so a request reaches its wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const K1 = "ts_live_1111111111111111111111111111111111";
const K2 = "ts_live_2222222222222222222222222222222222";
const NOW = 1_700_000_000_000;

afterEach(() => {
  release();
  forgetSecrets();
});

function setup() {
  const dir = tempDir("advisor-races-");
  const store = new AdvisorKeyStore({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")), now: () => NOW });
  return { dir, store };
}

describe("Advisor's key under overlapping requests", () => {
  it("a removal asked while the key is opened to hand on stays removed", async () => {
    const { store } = setup();
    await store.set(K1, "phone", { source: "account", setAt: NOW });
    hold();
    const share = store.shareAccountKey("laptop", "a1b2c3d4e5f6");
    await settle();
    const removed = store.remove("phone", "account");
    await settle();
    release();
    await share;
    await removed;
    expect(store.status().keySet).toBe(false);
    expect(await store.key()).toBeUndefined();
  });

  it("a new key pasted while the old one is opened to hand on is the one kept", async () => {
    const { store } = setup();
    await store.set(K1, "phone", { source: "account", setAt: NOW - 10 });
    hold();
    const share = store.shareAccountKey("laptop", "a1b2c3d4e5f6");
    await settle();
    const pasted = store.set(K2, "phone", { source: "account", setAt: NOW });
    await settle();
    release();
    expect((await share).key).toBe(K1);
    await pasted;
    expect(await store.key()).toBe(K2);
  });

  it("marking a key used never writes back a key removed while it was opened", async () => {
    const dir = tempDir("advisor-reveal-");
    const secrets = new SecretStore(dir, () => NOW, "reveal-test.json");
    const saved = await secrets.save("https://api.typesafe.ai", "TYPESAFE_API_KEY", K1);
    hold();
    const opened = secrets.reveal(saved.id);
    await settle();
    secrets.remove(saved.id);
    release();
    expect(await opened).toBe(K1);
    expect(secrets.list()).toHaveLength(0);
  });

  it("an older account key handed on late leaves the newer one in place", async () => {
    const { store } = setup();
    await store.set(K2, "phone", { source: "account", setAt: NOW });
    await store.receive({ key: K1, setAt: NOW - 1, setByDevice: "tablet" }, "laptop", "a1b2c3d4e5f6");
    expect(await store.key()).toBe(K2);
    await store.set(K1, "tablet", { source: "account", setAt: NOW - 1 });
    expect(await store.key()).toBe(K2);
    // A newer one replaces it.
    await store.receive({ key: K1, setAt: NOW + 1, setByDevice: "tablet" }, "laptop", "a1b2c3d4e5f6");
    expect(await store.key()).toBe(K1);
  });

  it("a set time far past the machine's clock counts as the clock plus the allowed lead", async () => {
    const { store } = setup();
    await store.set(K1, "phone", { source: "account", setAt: NOW + 60 * 60_000 });
    expect(store.status().setAt).toBe(NOW + MAX_SET_AHEAD_MS);
    await store.receive({ key: K2, setAt: NOW + 2 * 60 * 60_000, setByDevice: "tablet" }, "laptop", "a1b2c3d4e5f6");
    // Both clamped to the same time: the fingerprint orders them, as on every device.
    expect(store.status().setAt).toBe(NOW + MAX_SET_AHEAD_MS);
  });
});

// Saved Antigravity accounts on a fake Keychain: a switch writes the saved
// sign-in, reads it back and puts the old one back when the read is wrong;
// it is refused while agy runs; agy's refreshed token is kept; a sign-in too
// long for `security -i` is refused, never cut.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountError } from "../src/accounts/errors.ts";
import { AccountsStore } from "../src/accounts/store.ts";
import { AgyAccounts } from "../src/providers/antigravity/accounts.ts";
import { AgyAcp, AgyBusy } from "../src/providers/antigravity/acp-process.ts";
import { fakeAgy } from "./support/fake-agy.ts";
import { type AgyKeychain, KeychainError, MAX_LINE, emailOf, writeLine } from "../src/providers/antigravity/keychain.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { tempDir } from "./harness.ts";

const signIn = (email: string, token = "t1") => `go-keyring-base64:${Buffer.from(JSON.stringify({ token: { access_token: token, note: 'a "quoted" value\nwith a line' }, auth_method: "oauth-personal", id_token_email: email })).toString("base64")}`;

function fakeKeychain(initial?: string) {
  const k = { value: initial, writes: 0, breakReadback: false };
  const keychain: AgyKeychain = {
    async read() {
      return k.breakReadback && k.writes > 0 ? signIn("someone-else@example.com") : k.value;
    },
    async write(value) {
      writeLine(value);
      k.writes += 1;
      k.value = value;
    },
  };
  return { k, keychain };
}

function setup(initial = signIn("a@example.com")) {
  const configDir = tempDir("agy-accounts-");
  const { k, keychain } = fakeKeychain(initial);
  const state = { busy: [] as string[], others: [] as number[], stops: 0, selects: [] as string[] };
  const accounts = new AgyAccounts({
    configDir,
    store: new AccountsStore(configDir),
    audit: new AuditLog(join(configDir, "audit.jsonl")),
    keychain,
    busySessions: () => state.busy,
    withAgyStopped: async (fn) => {
      if (state.busy.length > 0) throw new AgyBusy(state.busy[0] ?? "");
      state.stops += 1;
      return fn();
    },
    runningAgy: async () => state.others,
    log: () => undefined,
  });
  accounts.listen({ onSelect: (id) => state.selects.push(id) });
  return { accounts, k, state };
}

/** Saves a@ (signed in now), then b@ (after agy signed in as b@). */
async function twoAccounts() {
  const s = setup();
  await s.accounts.captureCurrent("phone");
  s.k.value = signIn("b@example.com");
  await s.accounts.captureCurrent("phone");
  const ids = Object.fromEntries((await s.accounts.list()).accounts.filter((a) => a.id !== "").map((a) => [a.email, a.id]));
  return { ...s, a: ids["a@example.com"] ?? "", b: ids["b@example.com"] ?? "" };
}

describe("Antigravity accounts", () => {
  it("saves who agy is signed in as and switches between saved accounts", async () => {
    const { accounts, k, state, a, b } = await twoAccounts();
    expect((await accounts.list()).selectedId).toBe(b);
    await accounts.select(a, "phone");
    expect(emailOf(k.value ?? "")).toBe("a@example.com");
    expect(accounts.view().selectedId).toBe(a);
    expect(state.stops).toBe(1);
    expect(state.selects).toEqual([a]);
    const own = accounts.view().accounts[0];
    expect(own).toMatchObject({ id: "", email: "a@example.com" });
  });

  it("keeps agy's refreshed token with its account", async () => {
    const { accounts, k, a, b } = await twoAccounts();
    k.value = signIn("b@example.com", "refreshed");
    await accounts.select(a, "phone");
    await accounts.select(b, "phone");
    expect(k.value).toBe(signIn("b@example.com", "refreshed"));
  });

  it("refuses while a turn runs or agy runs in a terminal, and changes nothing", async () => {
    const { accounts, k, state, a } = await twoAccounts();
    state.busy = ["Fix the build"];
    await expect(accounts.select(a, "phone")).rejects.toMatchObject({ kind: "switch-blocked", subject: "Fix the build" });
    state.busy = [];
    state.others = [4242];
    await expect(accounts.select(a, "phone")).rejects.toMatchObject({ kind: "switch-blocked", subject: "agy pid 4242" });
    expect(emailOf(k.value ?? "")).toBe("b@example.com");
    expect(k.writes).toBe(0);
  });

  it("puts the old sign-in back when the Keychain reads back wrong", async () => {
    const { accounts, k, a } = await twoAccounts();
    const before = k.value;
    k.breakReadback = true;
    await expect(accounts.select(a, "phone")).rejects.toBeInstanceOf(AccountError);
    expect(k.value).toBe(before);
  });

  it("runs one change at a time", async () => {
    const { accounts, k, a, b } = await twoAccounts();
    await Promise.all([accounts.select(a, "p1"), accounts.select(b, "p2"), accounts.select(a, "p3")]);
    expect(emailOf(k.value ?? "")).toBe("a@example.com");
    expect(accounts.view().selectedId).toBe(a);
  });

  it("never removes the account agy is signed in as", async () => {
    const { accounts, a, b } = await twoAccounts();
    await expect(accounts.remove(b, "phone")).rejects.toMatchObject({ kind: "in-use" });
    await accounts.remove(a, "phone");
    expect(accounts.view().accounts.map((x) => x.email)).toEqual(["b@example.com", "b@example.com"]);
    await expect(accounts.remove("", "phone")).rejects.toMatchObject({ kind: "default-permanent" });
  });

  it("a locked Keychain is a refusal with a reason, not a crash", async () => {
    const configDir = tempDir("agy-locked-");
    const accounts = new AgyAccounts({
      configDir,
      store: new AccountsStore(configDir),
      audit: new AuditLog(join(configDir, "audit.jsonl")),
      keychain: {
        read: async () => {
          throw new KeychainError("locked");
        },
        write: async () => undefined,
      },
      busySessions: () => [],
      withAgyStopped: (fn) => fn(),
      log: () => undefined,
    });
    await expect(accounts.captureCurrent("phone")).rejects.toMatchObject({ kind: "switch-blocked", subject: "locked" });
  });
});

describe("tunelo's agy during a switch", () => {
  it("starts no agy while a switch holds it stopped, and refuses with nothing stopped while a turn runs", async () => {
    const agy = fakeAgy();
    const acp = new AgyAcp({ findBinary: async () => "agy", log: () => undefined, spawnProcess: agy.spawnProcess });
    await acp.get();
    expect(agy.log.launches).toHaveLength(1);
    let started = false;
    await acp.whileStopped(
      () => [],
      async () => {
        void acp.get().then(() => (started = true));
        await new Promise((r) => setTimeout(r, 20));
        expect(started).toBe(false);
      },
    );
    await acp.get();
    expect(agy.log.launches).toHaveLength(2);
    await expect(acp.whileStopped(() => ["Fix the build"], async () => undefined)).rejects.toBeInstanceOf(AgyBusy);
    expect(acp.openSessions()).toBe(0);
    await acp.stop();
  });
});

describe("the Keychain line", () => {
  it("writes any value as hex and refuses one too long, never cutting it", () => {
    const line = writeLine('a b "c"\nd');
    expect(line).toMatch(/^add-generic-password -U -s gemini -a antigravity -X [0-9a-f]+\n$/);
    expect(() => writeLine("x".repeat(MAX_LINE))).toThrow(KeychainError);
  });

  it("reads the email of agy's sign-in, nothing else", () => {
    expect(emailOf(signIn("me@example.com"))).toBe("me@example.com");
    expect(emailOf("plain")).toBeUndefined();
  });
});

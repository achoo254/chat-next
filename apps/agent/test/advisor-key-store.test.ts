// Advisor's TypeSafe key: sealed in a store of its own, apart from the sign-in
// secrets, so no AI session reaches it through request_secret or a command's
// environment; devices only ever see its fingerprint, and no refusal, log line
// or file next to it carries the key.
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADVISOR_KEY_ORIGIN, ADVISOR_SECRETS_FILE, AdvisorKeyError, AdvisorKeyStore, MIN_KEY_CHARS } from "../src/advisor/advisor-key-store.ts";
import { type KeyTerminal, NEEDS_TERMINAL, runAdvisorCommand } from "../src/advisor/cli-advisor-command.ts";
import { forgetSecrets, redact, secretVariants } from "../src/mcp/redact.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { SecretService } from "../src/sign-in-secrets/secret-service.ts";
import { SECRETS_FILE } from "../src/sign-in-secrets/secret-store.ts";
import { tempDir } from "./harness.ts";

process.env.TUNELO_KEYSTORE = "file";

const KEY = "ts_live_4f9c2a7e1b8d4c6f9a0e3b5d7c1f2a8e";
const FINGERPRINT = createHash("sha256").update(KEY).digest("hex").slice(0, 6);

afterEach(() => forgetSecrets());

function setup(now: () => number = () => 1_700_000_000_000) {
  const dir = tempDir("advisor-key-");
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const logs: string[] = [];
  const store = new AdvisorKeyStore({ configDir: dir, audit, now, log: (l) => logs.push(l) });
  return { dir, audit, store, logs };
}

/** Every file tunelo wrote in the folder, as text. */
function everyFile(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(dir, e.name), "latin1"))
    .join("\n");
}

describe("Advisor's key store", () => {
  it("keeps the key sealed with its fingerprint, who set it and when; it is still there after a restart", async () => {
    const { dir, store } = setup();
    expect(store.status()).toEqual({ keySet: false, fingerprint: "", setByDevice: "", setAt: 0 });

    const status = await store.set(`  ${KEY}\n`, "phone");
    expect(status).toEqual({ keySet: true, fingerprint: FINGERPRINT, setByDevice: "phone", setAt: 1_700_000_000_000 });
    expect(await store.key()).toBe(KEY);

    // A new process (the service restarted) reads the same file.
    const again = new AdvisorKeyStore({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")) });
    expect(again.status()).toEqual(status);
    expect(await again.key()).toBe(KEY);

    // No file holds the key in clear; the consent log has the fingerprint only.
    for (const form of secretVariants(KEY)) expect(everyFile(dir)).not.toContain(form);
    const log = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(log).toContain('"action":"advisor_key_set"');
    expect(log).toContain(FINGERPRINT);
  });

  it("replaces the key, and forgets it with an entry in the consent log", async () => {
    const { dir, store } = setup();
    await store.set(KEY, "phone");
    const other = `${KEY}x`;
    expect((await store.set(other, "laptop")).setByDevice).toBe("laptop");
    expect(await store.key()).toBe(other);

    expect(await store.remove("laptop")).toEqual({ keySet: false, fingerprint: "", setByDevice: "", setAt: 0 });
    expect(await store.key()).toBeUndefined();
    // Forgetting again is no error and logs nothing more.
    await store.remove("laptop");
    const removals = readFileSync(join(dir, "audit.jsonl"), "utf8").split("\n").filter((l) => l.includes('"advisor_key_remove"'));
    expect(removals).toHaveLength(1);
  });

  it("refuses a malformed key with a fixed message, and hides it from every output first", async () => {
    const { store } = setup();
    for (const bad of ["", "   ", "abc", "k".repeat(MIN_KEY_CHARS - 1), `${KEY} ${KEY}`, `${KEY}\u0007`, "k".repeat(4097)]) {
      const err = await store.set(bad, "phone").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdvisorKeyError);
      expect((err as AdvisorKeyError).kind).toBe("invalid");
      if (bad.trim().length >= 3) expect((err as Error).message).not.toContain(bad.trim());
    }
    // The spaced key was remembered before it was refused: echoed anywhere, it is hidden.
    expect(redact(`echo ${KEY} ${KEY}`)).not.toContain(KEY);
    expect(store.status().keySet).toBe(false);
  });

  it("a string too short to be a key is refused without being hidden from the process's output", async () => {
    const { store } = setup();
    const err = await store.set("test", "phone").catch((e: unknown) => e);
    expect((err as AdvisorKeyError).kind).toBe("invalid");
    expect(redact("npm test passed")).toBe("npm test passed");
  });

  it("changes land in the order asked: a removal right after a set wins", async () => {
    const { store } = setup();
    const set = store.set(KEY, "phone");
    const removed = store.remove("phone");
    await set;
    expect((await removed).keySet).toBe(false);
    expect(store.status().keySet).toBe(false);
    expect(await store.key()).toBeUndefined();
  });

  it("a key store that cannot seal: a fixed refusal, the log line without the key, nothing saved", async () => {
    const { dir, store, logs } = setup();
    chmodSync(dir, 0o500);
    try {
      const err = await store.set(KEY, "phone").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdvisorKeyError);
      expect((err as AdvisorKeyError).kind).toBe("not_saved");
      expect((err as Error).message).not.toContain(KEY);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(logs.join("\n")).not.toContain(KEY);
    expect(store.status().keySet).toBe(false);
  });

  it("a damaged file reads as no key (logged), never overwritten", () => {
    const { dir, store, logs } = setup();
    writeFileSync(join(dir, ADVISOR_SECRETS_FILE), "{ not json");
    expect(store.status().keySet).toBe(false);
    expect(logs.some((l) => l.startsWith("advisor: the key store cannot be read"))).toBe(true);
    expect(readFileSync(join(dir, ADVISOR_SECRETS_FILE), "utf8")).toBe("{ not json");
  });

  it("request_secret and a command's environment never reach it", async () => {
    const { dir, store, audit } = setup();
    await store.set(KEY, "phone");
    const prompts: string[] = [];
    const service = new SecretService({ configDir: dir, audit });
    service.onEvent((e) => {
      if (e.type === "prompt") prompts.push(e.prompt.name);
    });
    const session = { key: "ticket-a", threadId: "thread-a" };

    // The sign-in secrets know nothing of it: listing, finding and asking all come up empty.
    expect(service.list()).toEqual([]);
    expect(service.store.findSaved(ADVISOR_KEY_ORIGIN, "TYPESAFE_API_KEY")).toBeUndefined();
    const asked = service.request(session, { name: "TYPESAFE_API_KEY", purpose: "call TypeSafe", origin: ADVISOR_KEY_ORIGIN });
    // Not handed over: the user is asked instead, as for any secret the machine does not keep.
    expect(prompts).toEqual(["TYPESAFE_API_KEY"]);
    expect(await service.envFor(session, ["TYPESAFE_API_KEY"])).toEqual({ env: {}, missing: ["TYPESAFE_API_KEY"] });
    service.close();
    await asked.catch(() => undefined);

    // Two files, each its own: the sign-in secrets' file never gets the advisor entry.
    const signIn = readdirSync(dir).includes(SECRETS_FILE) ? readFileSync(join(dir, SECRETS_FILE), "utf8") : "";
    expect(signIn).not.toContain("TYPESAFE_API_KEY");
  });
});

describe("tunelo advisor", () => {
  function terminal(interactive: boolean, typed: string | Error = KEY) {
    const out: string[] = [];
    const err: string[] = [];
    let asked = 0;
    const term: KeyTerminal = {
      interactive,
      readHidden: async () => {
        asked++;
        if (typed instanceof Error) throw typed;
        return typed;
      },
      print: (l) => out.push(l),
      printError: (l) => err.push(l),
    };
    return { term, out, err, asked: () => asked };
  }

  it("set-key refuses a pipe or a script: the key is read only from a terminal", async () => {
    const { dir } = setup();
    const t = terminal(false);
    let notified = 0;
    expect(await runAdvisorCommand("set-key", { dir, term: t.term, notify: async () => notified++ })).toBe(1);
    expect(t.err).toEqual([NEEDS_TERMINAL]);
    expect(t.asked()).toBe(0);
    expect(notified).toBe(0);
    expect(new AdvisorKeyStore({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")) }).status().keySet).toBe(false);
  });

  it("set-key from a terminal saves the key as local, prints the fingerprint only and tells the service", async () => {
    const { dir } = setup();
    const t = terminal(true);
    let notified = 0;
    expect(await runAdvisorCommand("set-key", { dir, term: t.term, notify: async () => notified++ })).toBe(0);
    expect(notified).toBe(1);
    expect(t.out.join("\n")).toContain(FINGERPRINT);
    expect(t.out.join("\n")).not.toContain(KEY);
    const status = new AdvisorKeyStore({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")) }).status();
    expect(status).toMatchObject({ keySet: true, setByDevice: "local", fingerprint: FINGERPRINT });

    // status prints the fingerprint; remove-key works without a running service.
    const s = terminal(true);
    expect(await runAdvisorCommand("status", { dir, term: s.term, notify: async () => undefined })).toBe(0);
    expect(s.out.join("\n")).toContain(FINGERPRINT);
    const piped = terminal(false);
    expect(await runAdvisorCommand("remove-key", { dir, term: piped.term, notify: async () => undefined })).toBe(1);
    expect(piped.err).toEqual([NEEDS_TERMINAL]);
    expect(new AdvisorKeyStore({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")) }).status().keySet).toBe(true);
    const r = terminal(true);
    const down = async () => {
      throw new Error("tunelo is not running");
    };
    expect(await runAdvisorCommand("remove-key", { dir, term: r.term, notify: down })).toBe(0);
    expect(r.out.join("\n")).toContain("none on this machine");
    expect(r.out.join("\n")).toContain("applies when it starts");
  });

  it("a refused key, Ctrl-C or stdin ending: one line, exit 1, nothing saved, never the key", async () => {
    const { dir } = setup();
    const short = terminal(true, "too-short");
    expect(await runAdvisorCommand("set-key", { dir, term: short.term, notify: async () => undefined })).toBe(1);
    expect(short.err).toHaveLength(1);
    expect(short.err[0]).toMatch(/^tunelo: the key is too short/);
    const cancelled = terminal(true, new Error("cancelled; nothing was changed"));
    expect(await runAdvisorCommand("set-key", { dir, term: cancelled.term, notify: async () => undefined })).toBe(1);
    expect(cancelled.err).toEqual(["tunelo: cancelled; nothing was changed"]);
    expect(new AdvisorKeyStore({ configDir: dir, audit: new AuditLog(join(dir, "audit.jsonl")) }).status().keySet).toBe(false);
  });

  it("an unknown action is refused", async () => {
    const { dir } = setup();
    const t = terminal(true);
    expect(await runAdvisorCommand("show-key", { dir, term: t.term, notify: async () => undefined })).toBe(1);
    expect(t.err.join("\n")).toContain("unknown action");
  });
});

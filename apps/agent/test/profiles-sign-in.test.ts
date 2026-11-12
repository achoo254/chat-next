// Claude profiles against a fake `claude` that prints its sign-in link and
// waits for a code: signing in from a device, a wrong code, an account that
// is already there, one attempt at a time (also when two start together),
// a cancel or expiry while a profile is being kept, expiry, a claude that
// shows no link, the terminal way, picking, usage limits, settings that
// follow the machine, removal (refused when the sign-out fails), a damaged
// profiles.json, and that no claude process outlives its attempt.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeEnv, expiryMs } from "../src/profiles/account.ts";
import { profileDir, profileHome } from "../src/profiles/paths.ts";
import { ClaudeProfiles } from "../src/profiles/service.ts";
import { extractSignInUrl, validCode } from "../src/profiles/sign-in.ts";
import { GOOD_CODE, LOGIN_EXPIRES, livePids, signInDefault } from "./support/fake-claude.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

const posix = process.platform !== "win32";
const ENV = ["CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_EMAIL", "FAKE_CLAUDE_ORG", "FAKE_CLAUDE_SILENT", "FAKE_CLAUDE_STATUS_DELAY_MS", "FAKE_CLAUDE_LOGOUT_FAIL", "FAKE_CLAUDE_PID_DIR"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of ENV.slice(1)) Reflect.deleteProperty(process.env, k);
});

afterEach(() => {
  for (const k of ENV) {
    const v = saved[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function addProfile(profiles: ClaudeProfiles) {
  const begun = await profiles.beginRemote();
  if (!begun.ok) throw new Error(begun.error);
  return profiles.submitCode(begun.attemptId, GOOD_CODE);
}

/** Every kept profile has its folder, signed in. */
function consistent(f: ReturnType<typeof profilesFixture>): void {
  for (const p of f.profiles.store.get().profiles) {
    expect(existsSync(join(profileHome(f.configDir, p.id), "fake-auth.json")), `profile ${p.id} has its signed-in folder`).toBe(true);
  }
}

describe("sign-in link", () => {
  it("takes the link out of claude's OSC 8 hyperlink", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=s";
    const out = `Opening browser…\nIf the browser didn't open, visit: \u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\\nPaste code here if prompted > `;
    expect(extractSignInUrl(out)).toBe(url);
  });

  it("accepts only claude's own sign-in pages", () => {
    expect(extractSignInUrl("visit https://evil.example/?code=true")).toBeNull();
    expect(extractSignInUrl("visit https://claude.ai.evil.example/oauth?code=true")).toBeNull();
    expect(extractSignInUrl("visit https://claude.ai/oauth/authorize?code=false")).toBeNull();
    expect(extractSignInUrl("visit https://claude.ai/oauth/authorize?code=true&x=1")).toBe("https://claude.ai/oauth/authorize?code=true&x=1");
  });

  it("takes codes as the page shows them, nothing with spaces or control characters", () => {
    expect(validCode(GOOD_CODE)).toBe(true);
    expect(validCode("short")).toBe(false);
    expect(validCode("has a space in it")).toBe(false);
    expect(validCode("line\nbreak-123456")).toBe(false);
  });

  it("runs a profile's claude on its own sign-in only, not on account variables of the service", () => {
    const env = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-x";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-x";
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-x";
    try {
      const forProfile = claudeEnv("/p/home");
      expect(forProfile.CLAUDE_CONFIG_DIR).toBe("/p/home");
      expect([forProfile.ANTHROPIC_API_KEY, forProfile.CLAUDE_CODE_OAUTH_TOKEN, forProfile.ANTHROPIC_AUTH_TOKEN]).toEqual([undefined, undefined, undefined]);
      // The default profile runs as the machine set it up.
      expect(claudeEnv(undefined).ANTHROPIC_API_KEY).toBe("sk-ant-api-x");
    } finally {
      for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
        if (env[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = env[k];
      }
    }
  });
});

describe.skipIf(!posix)("signing in from a device", () => {
  it("adds the account after the code, without picking it", async () => {
    const f = profilesFixture({ defaultEmail: "owner@example.com" });
    const begun = await f.profiles.beginRemote();
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.url).toMatch(/^https:\/\/claude\.com\/.*code=true/);
    const out = await f.profiles.submitCode(begun.attemptId, GOOD_CODE);
    expect(out).toEqual({ ok: true, id: begun.attemptId, email: "second@example.com", organization: "Org One" });
    expect(existsSync(join(profileDir(f.configDir, begun.attemptId), "attempt"))).toBe(false);
    const list = await f.profiles.list();
    expect(list.selectedId).toBe("");
    expect(list.profiles.map((p) => [p.id === "" ? "default" : "added", p.email, p.signedIn])).toEqual([
      ["default", "owner@example.com", true],
      ["added", "second@example.com", true],
    ]);
    expect(f.audit.list().map((e) => [e.action, e.detail])).toEqual([["profile_add", "second@example.com"]]);
    expect(livePids(f.pidDir)).toEqual([]);
  });

  it("ends the attempt on a wrong code: no folder, no claude left running", async () => {
    const f = profilesFixture();
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    expect(livePids(f.pidDir)).toHaveLength(1);
    expect(await f.profiles.submitCode(begun.attemptId, "WRONGCODE-0000#nope")).toEqual({ ok: false, error: "code-rejected" });
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(false);
    expect(livePids(f.pidDir)).toEqual([]);
    expect(await f.profiles.submitCode(begun.attemptId, GOOD_CODE)).toEqual({ ok: false, error: "expired" });
    expect((await f.profiles.list()).profiles).toHaveLength(1);
  });

  it("refuses the account of the default profile, ignoring the e-mail's case, and signs the copy out", async () => {
    const f = profilesFixture({ defaultEmail: "Owner@Example.com" });
    process.env.FAKE_CLAUDE_EMAIL = "owner@example.com";
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    expect(await f.profiles.submitCode(begun.attemptId, GOOD_CODE)).toEqual({ ok: false, error: "duplicate" });
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(false);
    expect(readFileSync(join(f.claudeHome, "fake-auth.json"), "utf8")).toContain("Owner@Example.com");
  });

  it("refuses an account another profile has, but takes the same e-mail in another organization", async () => {
    const f = profilesFixture();
    expect((await addProfile(f.profiles)).ok).toBe(true);
    expect(await addProfile(f.profiles)).toEqual({ ok: false, error: "duplicate" });
    process.env.FAKE_CLAUDE_ORG = "org-2";
    expect((await addProfile(f.profiles)).ok).toBe(true);
    expect((await f.profiles.list()).profiles).toHaveLength(3);
  });

  it("runs one attempt at a time: a new one cancels the one before, its folder and its claude", async () => {
    const f = profilesFixture();
    const first = await f.profiles.beginRemote();
    const second = await f.profiles.beginRemote();
    if (!first.ok || !second.ok) throw new Error("no link");
    expect(existsSync(profileDir(f.configDir, first.attemptId))).toBe(false);
    expect(livePids(f.pidDir)).toHaveLength(1);
    expect(await f.profiles.submitCode(first.attemptId, GOOD_CODE)).toEqual({ ok: false, error: "expired" });
    expect((await f.profiles.submitCode(second.attemptId, GOOD_CODE)).ok).toBe(true);
  });

  it("keeps one attempt when two start together", async () => {
    const f = profilesFixture();
    const [a, b] = await Promise.all([f.profiles.beginRemote(), f.profiles.beginRemote()]);
    if (!a.ok || !b.ok) throw new Error("no link");
    const folders = readdirSync(join(f.configDir, "claude-profiles")).filter((n) => n !== "profiles.json");
    expect(folders).toEqual([b.attemptId]);
    expect(livePids(f.pidDir)).toHaveLength(1);
    expect((await f.profiles.submitCode(b.attemptId, GOOD_CODE)).ok).toBe(true);
    expect(livePids(f.pidDir)).toEqual([]);
  });

  it("never keeps a profile whose folder a cancel or the expiry removed while it was being kept", async () => {
    const f = profilesFixture({ ttlMs: 1_500 });
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    // `auth status` takes 0.8 s, twice: the expiry and another device's sign-in land meanwhile.
    process.env.FAKE_CLAUDE_STATUS_DELAY_MS = "800";
    const submitted = f.profiles.submitCode(begun.attemptId, GOOD_CODE);
    await new Promise((r) => setTimeout(r, 200));
    const other = f.profiles.beginRemote();
    const [first, second] = await Promise.all([submitted, other]);
    Reflect.deleteProperty(process.env, "FAKE_CLAUDE_STATUS_DELAY_MS");
    expect(first).toMatchObject({ ok: true, id: begun.attemptId });
    expect(second.ok).toBe(true);
    expect(f.profiles.store.get().profiles.map((p) => p.id)).toEqual([begun.attemptId]);
    consistent(f);
    await new Promise((r) => setTimeout(r, 1_700));
    consistent(f);
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(true);
  });

  it("ends an attempt left alone, with its claude", async () => {
    const f = profilesFixture({ ttlMs: 300 });
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    await new Promise((r) => setTimeout(r, 700));
    expect(await f.profiles.submitCode(begun.attemptId, GOOD_CODE)).toEqual({ ok: false, error: "expired" });
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(false);
    expect(livePids(f.pidDir)).toEqual([]);
  });

  it("says to sign in on the machine when claude shows no link", async () => {
    const f = profilesFixture({ urlTimeoutMs: 500 });
    process.env.FAKE_CLAUDE_SILENT = "1";
    expect(await f.profiles.beginRemote()).toEqual({ ok: false, error: "sign-in-on-machine" });
    expect(readdirSync(join(f.configDir, "claude-profiles")).filter((n) => n !== "profiles.json")).toEqual([]);
    expect(livePids(f.pidDir)).toEqual([]);
  });

  it("cancels on request, claude included", async () => {
    const f = profilesFixture();
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    await f.profiles.cancel(begun.attemptId);
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(false);
    expect(livePids(f.pidDir)).toEqual([]);
  });
});

describe.skipIf(!posix)("leftovers and a damaged profiles.json", () => {
  it("cleans only folders marked as an unfinished sign-in", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    mkdirSync(profileHome(f.configDir, "unfinished"), { recursive: true });
    writeFileSync(join(profileDir(f.configDir, "unfinished"), "attempt"), "");
    mkdirSync(profileHome(f.configDir, "unknown"), { recursive: true });
    await f.profiles.cleanLeftovers();
    expect(existsSync(profileDir(f.configDir, "unfinished"))).toBe(false);
    expect(existsSync(profileDir(f.configDir, "unknown"))).toBe(true);
    expect(existsSync(profileDir(f.configDir, added.id))).toBe(true);
  });

  it("keeps the file and every profile when profiles.json is damaged, and says so", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    await f.profiles.select(added.id, "x");
    const file = join(f.configDir, "claude-profiles", "profiles.json");
    const damaged = readFileSync(file, "utf8").replace(/"createdAt": \d+/, '"createdAt": "soon"');
    writeFileSync(file, damaged);
    const again = new ClaudeProfiles({ configDir: f.configDir, audit: f.audit, claudeHome: f.claudeHome, findBinary: async () => f.bin, probeUsage: async () => null });
    expect(again.store.damaged).toMatch(/damaged/);
    await again.cleanLeftovers();
    expect(readFileSync(file, "utf8")).toBe(damaged);
    expect(readdirSync(join(f.configDir, "claude-profiles")).some((n) => n.startsWith("profiles.json.corrupt-"))).toBe(true);
    // Not signed out, not deleted.
    expect(existsSync(join(profileHome(f.configDir, added.id), "fake-auth.json"))).toBe(true);
    await expect(again.list()).rejects.toThrow(/damaged/);
    await expect(again.select("", "x")).rejects.toThrow(/damaged/);
    await expect(again.beginRemote()).rejects.toThrow(/damaged/);
    await expect(again.remove(added.id, "x")).rejects.toThrow(/damaged/);
    expect(() => again.sessionProfile()).toThrow(/damaged/);
  });
});

describe.skipIf(!posix)("profiles on the machine", () => {
  it("adds through the terminal way: a prepared folder, then a check of the account", async () => {
    const f = profilesFixture();
    const { id, home } = await f.profiles.prepareTerminal();
    expect(await f.profiles.finishTerminal(id)).toEqual({ ok: false, error: "failed" });
    const again = await f.profiles.prepareTerminal();
    signInDefault(again.home, "terminal@example.com");
    expect(home).not.toBe(again.home);
    expect(await f.profiles.finishTerminal(again.id)).toMatchObject({ ok: true, email: "terminal@example.com" });
  });

  it("picks a profile for new sessions, logs it, and gives sessions its folder", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    expect(f.profiles.sessionProfile()).toEqual({ id: "" });
    await f.profiles.select(added.id, "phone (abcd1234)");
    expect(f.profiles.sessionProfile()).toEqual({ id: added.id, accountDir: profileHome(f.configDir, added.id) });
    expect(f.profiles.selectedAccountDir()).toBe(profileHome(f.configDir, added.id));
    expect(f.audit.list()[0]).toMatchObject({ device: "phone (abcd1234)", action: "profile_select", detail: "second@example.com" });
    await expect(f.profiles.select("nope", "x")).rejects.toThrow(/no such profile/);
    await f.profiles.select("", "x");
    expect(f.profiles.sessionProfile()).toEqual({ id: "" });
  });

  it("brings the machine's settings to the profile at every session start", async () => {
    const f = profilesFixture();
    writeFileSync(join(f.claudeHome, "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    await f.profiles.select(added.id, "x");
    const own = join(profileHome(f.configDir, added.id), "settings.json");
    expect(JSON.parse(readFileSync(own, "utf8"))).toEqual({ permissions: { defaultMode: "bypassPermissions" } });
    const safer = { permissions: { deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [] } };
    writeFileSync(join(f.claudeHome, "settings.json"), JSON.stringify(safer));
    f.profiles.sessionProfile();
    expect(JSON.parse(readFileSync(own, "utf8"))).toEqual(safer);
    // The machine dropped its settings: the profile keeps none either.
    writeFileSync(join(f.claudeHome, "settings.json"), "{}");
    f.profiles.sessionProfile();
    expect(readFileSync(own, "utf8")).toBe("{}");
  });

  it("reads usage at most once per interval and once at a time per profile", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const f = profilesFixture({
      probe: async () => {
        calls += 1;
        await new Promise<void>((r) => (release = r));
        return { fiveHour: { utilization: 12, resetsAt: 1 } };
      },
    });
    const together = Promise.all([f.profiles.refreshUsage(""), f.profiles.refreshUsage("")]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await together;
    expect(calls).toBe(1);
    await f.profiles.refreshUsage("");
    expect(calls).toBe(1);
    const list = await f.profiles.list();
    expect(list.profiles[0]?.lastUsage?.fiveHour?.utilization).toBe(12);
  });

  it("refreshes usage per profile and keeps it with the time", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    await f.profiles.refreshUsage(added.id);
    await f.profiles.refreshUsage("");
    expect(f.probed).toEqual([profileHome(f.configDir, added.id), undefined]);
    expect(f.pushed.map(([id]) => id)).toEqual([added.id, ""]);
    for (const p of (await f.profiles.list()).profiles) {
      expect(p.lastUsage?.fiveHour?.utilization).toBe(12);
      expect(p.lastUsage?.updatedAt).toBeGreaterThan(0);
    }
  });

  it("removes a profile: signed out, folder gone, the shared folder intact, selection back to default", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    await f.profiles.select(added.id, "x");
    f.busy.add(added.id);
    await expect(f.profiles.remove(added.id, "x")).rejects.toThrow(/open/);
    expect((await f.profiles.list()).selectedId).toBe(added.id);
    f.busy.clear();
    const shared = readdirSync(f.claudeHome, { recursive: true }).sort();
    await f.profiles.remove(added.id, "phone");
    expect(existsSync(profileDir(f.configDir, added.id))).toBe(false);
    expect(readdirSync(f.claudeHome, { recursive: true }).sort()).toEqual(shared);
    expect((await f.profiles.list()).selectedId).toBe("");
    await expect(f.profiles.remove("", "x")).rejects.toThrow(/default/);
    expect(f.audit.list()[0]).toMatchObject({ action: "profile_remove", detail: "second@example.com" });
  });

  it("tells from claude whether an added profile is still signed in, checked again once the last check is old", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    const view = async () => (await f.profiles.list()).profiles.find((p) => p.id === added.id);
    expect(await view()).toMatchObject({ signedIn: true, loginExpiresAt: Date.parse(LOGIN_EXPIRES) });
    // Signed out behind tunelo's back: the recent check still stands…
    const auth = join(profileHome(f.configDir, added.id), "fake-auth.json");
    const kept = readFileSync(auth, "utf8");
    rmSync(auth);
    expect((await view())?.signedIn).toBe(true);
    // …until a refresh asks claude again.
    await f.profiles.refreshUsage(added.id);
    expect(await view()).toMatchObject({ signedIn: false, email: "second@example.com" });
    // Signed in again but past its expiry: it needs to sign in again too.
    writeFileSync(auth, kept.replace(LOGIN_EXPIRES, "2020-01-01T00:00:00.000Z"));
    const fresh = new ClaudeProfiles({ configDir: f.configDir, audit: f.audit, claudeHome: f.claudeHome, findBinary: async () => f.bin, probeUsage: async () => null, signInCheckMs: 0 });
    expect((await fresh.list()).profiles.find((p) => p.id === added.id)).toMatchObject({ signedIn: false, loginExpiresAt: Date.parse("2020-01-01T00:00:00.000Z") });
    writeFileSync(auth, kept);
    expect((await fresh.list()).profiles.find((p) => p.id === added.id)?.signedIn).toBe(true);
  });

  it("reads claude's sign-in expiry as text, seconds or milliseconds", () => {
    expect(expiryMs("2026-11-09T00:00:00Z")).toBe(Date.UTC(2026, 10, 9));
    expect(expiryMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(expiryMs(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect([expiryMs(null), expiryMs(undefined), expiryMs(""), expiryMs("soon")]).toEqual([0, 0, 0, 0]);
  });

  it("refuses to remove a profile claude cannot sign out, unless forced", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    await f.profiles.select(added.id, "x");
    process.env.FAKE_CLAUDE_LOGOUT_FAIL = "1";
    await expect(f.profiles.remove(added.id, "phone")).rejects.toThrow(/could not sign this account out/);
    expect(existsSync(profileHome(f.configDir, added.id))).toBe(true);
    expect((await f.profiles.list()).selectedId).toBe(added.id);
    await f.profiles.remove(added.id, "local", { force: true });
    expect(existsSync(profileDir(f.configDir, added.id))).toBe(false);
    expect(f.audit.list()[0]).toMatchObject({ action: "profile_remove", detail: "second@example.com (forced)" });
  });
});

// Claude profiles against a fake `claude` that prints its sign-in link and
// waits for a code: signing in from a device, a wrong code, an account that
// is already there, one attempt at a time, expiry, a claude that shows no
// link (sign in on the machine instead), the terminal way, picking, usage
// and removal.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileDir, profileHome } from "../src/profiles/paths.ts";
import type { ClaudeProfiles } from "../src/profiles/service.ts";
import { extractSignInUrl, validCode } from "../src/profiles/sign-in.ts";
import { GOOD_CODE, signInDefault } from "./support/fake-claude.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

const posix = process.platform !== "win32";
const saved = { ...process.env };

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_EMAIL;
  delete process.env.FAKE_CLAUDE_ORG;
  delete process.env.FAKE_CLAUDE_SILENT;
});

afterEach(() => {
  for (const k of ["CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_EMAIL", "FAKE_CLAUDE_ORG", "FAKE_CLAUDE_SILENT"]) {
    if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = saved[k];
  }
});

async function addProfile(profiles: ClaudeProfiles) {
  const begun = await profiles.beginRemote();
  if (!begun.ok) throw new Error(begun.error);
  return profiles.submitCode(begun.attemptId, GOOD_CODE);
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
    const list = await f.profiles.list();
    expect(list.selectedId).toBe("");
    expect(list.profiles.map((p) => [p.id === "" ? "default" : "added", p.email, p.signedIn])).toEqual([
      ["default", "owner@example.com", true],
      ["added", "second@example.com", true],
    ]);
    expect(f.audit.list().map((e) => [e.action, e.detail])).toEqual([["profile_add", "second@example.com"]]);
  });

  it("ends the attempt on a wrong code and leaves no folder", async () => {
    const f = profilesFixture();
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    expect(await f.profiles.submitCode(begun.attemptId, "WRONGCODE-0000#nope")).toEqual({ ok: false, error: "code-rejected" });
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(false);
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

  it("runs one attempt at a time: a new one cancels the one before", async () => {
    const f = profilesFixture();
    const first = await f.profiles.beginRemote();
    const second = await f.profiles.beginRemote();
    if (!first.ok || !second.ok) throw new Error("no link");
    expect(existsSync(profileDir(f.configDir, first.attemptId))).toBe(false);
    expect(await f.profiles.submitCode(first.attemptId, GOOD_CODE)).toEqual({ ok: false, error: "expired" });
    expect((await f.profiles.submitCode(second.attemptId, GOOD_CODE)).ok).toBe(true);
  });

  it("ends an attempt left alone", async () => {
    const f = profilesFixture({ ttlMs: 300 });
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    await new Promise((r) => setTimeout(r, 600));
    expect(await f.profiles.submitCode(begun.attemptId, GOOD_CODE)).toEqual({ ok: false, error: "expired" });
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(false);
  });

  it("says to sign in on the machine when claude shows no link", async () => {
    const f = profilesFixture({ urlTimeoutMs: 500 });
    process.env.FAKE_CLAUDE_SILENT = "1";
    expect(await f.profiles.beginRemote()).toEqual({ ok: false, error: "sign-in-on-machine" });
    expect(readdirSync(join(f.configDir, "claude-profiles")).filter((n) => n !== "profiles.json")).toEqual([]);
  });

  it("cancels on request and cleans folders a crash left", async () => {
    const f = profilesFixture();
    const begun = await f.profiles.beginRemote();
    if (!begun.ok) throw new Error(begun.error);
    await f.profiles.cancel(begun.attemptId);
    expect(existsSync(profileDir(f.configDir, begun.attemptId))).toBe(false);
    mkdirSync(profileHome(f.configDir, "left-over"), { recursive: true });
    await f.profiles.cleanLeftovers();
    expect(existsSync(profileDir(f.configDir, "left-over"))).toBe(false);
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
    f.profiles.select(added.id, "phone (abcd1234)");
    expect(f.profiles.sessionProfile()).toEqual({ id: added.id, accountDir: profileHome(f.configDir, added.id) });
    expect(f.audit.list()[0]).toMatchObject({ device: "phone (abcd1234)", action: "profile_select", detail: "second@example.com" });
    expect(() => f.profiles.select("nope", "x")).toThrow(/no such profile/);
    f.profiles.select("", "x");
    expect(f.profiles.sessionProfile()).toEqual({ id: "" });
  });

  it("refreshes usage per profile and keeps it with the time", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    await f.profiles.refreshUsage(added.id);
    await f.profiles.refreshUsage("");
    expect(f.probed).toEqual([profileHome(f.configDir, added.id), undefined]);
    expect(f.pushed.map(([id]) => id)).toEqual([added.id, ""]);
    const list = await f.profiles.list();
    for (const p of list.profiles) {
      expect(p.lastUsage?.fiveHour?.utilization).toBe(12);
      expect(p.lastUsage?.updatedAt).toBeGreaterThan(0);
    }
  });

  it("removes a profile: signed out, folder gone, the shared folder intact, selection back to default", async () => {
    const f = profilesFixture();
    const added = await addProfile(f.profiles);
    if (!added.ok) throw new Error(added.error);
    f.profiles.select(added.id, "x");
    f.busy.add(added.id);
    await expect(f.profiles.remove(added.id, "x")).rejects.toThrow(/open/);
    f.busy.clear();
    const shared = readdirSync(f.claudeHome, { recursive: true }).sort();
    await f.profiles.remove(added.id, "phone");
    expect(existsSync(profileDir(f.configDir, added.id))).toBe(false);
    expect(readdirSync(f.claudeHome, { recursive: true }).sort()).toEqual(shared);
    expect((await f.profiles.list()).selectedId).toBe("");
    await expect(f.profiles.remove("", "x")).rejects.toThrow(/default/);
    expect(f.audit.list()[0]).toMatchObject({ action: "profile_remove", detail: "second@example.com" });
  });
});

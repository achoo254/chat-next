// After signing Claude profiles in and out (a good code, a wrong code, a
// cancelled attempt, a removal), no file tunelo owns holds the sign-in code,
// the token claude stored, or the link's state, and neither do the service's
// log lines or anything printed. claude's own store, claude-profiles/*/home,
// is left out: that is where claude keeps its sign-in.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_TOKEN, FAKE_URL_STATE, GOOD_CODE } from "./support/fake-claude.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

const WRONG_CODE = "WRONGCODE-d41d8cd9#leak-check";
const SECRETS = [GOOD_CODE, WRONG_CODE, FAKE_TOKEN, FAKE_URL_STATE];
const saved = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  vi.restoreAllMocks();
});

/** Every file under `dir`, links not followed, `skip` folders left out. */
function files(dir: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip(path)) continue;
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...files(path, skip));
    else out.push(path);
  }
  return out;
}

describe.skipIf(process.platform === "win32")("no Claude secret outside claude's own store", () => {
  it("keeps the code, the token and the link's state out of tunelo's files and logs", async () => {
    const printed: string[] = [];
    for (const method of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")));
    }
    const f = profilesFixture();
    const wrong = await f.profiles.beginRemote();
    if (!wrong.ok) throw new Error(wrong.error);
    expect(await f.profiles.submitCode(wrong.attemptId, WRONG_CODE)).toMatchObject({ ok: false });
    const cancelled = await f.profiles.beginRemote();
    if (!cancelled.ok) throw new Error(cancelled.error);
    await f.profiles.cancel(cancelled.attemptId);
    const kept = await f.profiles.beginRemote();
    if (!kept.ok) throw new Error(kept.error);
    const added = await f.profiles.submitCode(kept.attemptId, GOOD_CODE);
    if (!added.ok) throw new Error(added.error);
    process.env.FAKE_CLAUDE_EMAIL = "third@example.com";
    const removed = await f.profiles.beginRemote();
    if (!removed.ok) throw new Error(removed.error);
    const third = await f.profiles.submitCode(removed.attemptId, GOOD_CODE);
    delete process.env.FAKE_CLAUDE_EMAIL;
    if (!third.ok) throw new Error(third.error);
    f.profiles.select(added.id, "phone");
    await f.profiles.refreshUsage(added.id);
    await f.profiles.remove(third.id, "phone");

    const store = (path: string) => {
      const parts = relative(f.configDir, path).split(sep);
      return parts[0] === "claude-profiles" && parts[2] === "home";
    };
    const owned = files(f.configDir, store);
    expect(owned.some((p) => p.endsWith("profiles.json"))).toBe(true);
    expect(owned.some((p) => p.endsWith("audit.jsonl"))).toBe(true);
    for (const path of owned) {
      const text = readFileSync(path, "utf8");
      for (const secret of SECRETS) expect(text.includes(secret), `${secret} in ${path}`).toBe(false);
    }
    for (const line of [...f.logs, ...printed]) {
      for (const secret of SECRETS) expect(line.includes(secret), `${secret} in a log line`).toBe(false);
    }
    // The check would see it: claude itself did store the token, in its own folder.
    const claudeStore = readFileSync(join(f.configDir, "claude-profiles", added.id, "home", ".credentials.json"), "utf8");
    expect(claudeStore).toContain(FAKE_TOKEN);
  });
});

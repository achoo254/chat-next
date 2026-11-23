// `tunelo observatory hook <event>` as a function: one filtered line in the
// spool; nothing at all when state.json says Observatory is off; no content
// for a project switched off (or when state.json cannot be read); and out
// within its hard deadline when stdin never ends.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FilteredHookRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { hookStatePath, writeHookState } from "../../src/observatory/spool/hook-state-file.ts";
import { type ObservatoryHookDeps, runObservatoryHook } from "../../src/observatory/spool/run-observatory-hook.ts";
import { SPOOL_DIR, spoolFilePath } from "../../src/observatory/spool/spool-files.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";
import { FAKE_HOME, HOOK_PAYLOADS, isFakeSensitive } from "./observatory-payloads.ts";

afterAll(removeObsTempDirs);

const NOW = 1_764_000_000_000;

async function* chunks(text: string): AsyncGenerator<Buffer> {
  yield Buffer.from(text.slice(0, 10));
  yield Buffer.from(text.slice(10));
}

function deps(dataDir: string, stdin: AsyncIterable<Buffer | string>, over: Partial<ObservatoryHookDeps> = {}): ObservatoryHookDeps {
  return { stdin, dataDir, home: FAKE_HOME, isSensitive: isFakeSensitive, repoKey: () => "github.com/example/app", now: () => NOW, ...over };
}

function spooled(dataDir: string): FilteredHookRecord[] {
  const file = spoolFilePath(dataDir, "events", Math.floor(NOW / 60_000));
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FilteredHookRecord);
}

describe("the Observatory hook", () => {
  it("appends one filtered line for a kept event", async () => {
    const dir = obsTempDir("hook");
    expect(await runObservatoryHook("UserPromptSubmit", deps(dir, chunks(JSON.stringify(HOOK_PAYLOADS.UserPromptSubmit))))).toBe("written");
    const [r] = spooled(dir);
    expect(r?.event).toBe("UserPromptSubmit");
    expect(r?.c?.prompt).toBe("fix the failing test in src/app.ts");
    expect(JSON.stringify(r)).not.toContain("example.invalid");
  });

  it("exits without reading or writing when state.json says Observatory is off", async () => {
    const dir = obsTempDir("hook");
    await writeHookState(dir, { enabled: false, contentOff: [] });
    let read = false;
    const stdin = (async function* () {
      read = true;
      yield Buffer.from("{}");
    })();
    expect(await runObservatoryHook("Stop", deps(dir, stdin))).toBe("off");
    expect(read).toBe(false);
    expect(existsSync(join(dir, SPOOL_DIR))).toBe(false);
  });

  it("keeps no content for a project switched off, nor when state.json cannot be read", async () => {
    const dir = obsTempDir("hook");
    await writeHookState(dir, { enabled: true, contentOff: ["github.com/example/app"] });
    expect(await runObservatoryHook("UserPromptSubmit", deps(dir, chunks(JSON.stringify(HOOK_PAYLOADS.UserPromptSubmit))))).toBe("written");
    writeFileSync(hookStatePath(dir), "{broken");
    expect(await runObservatoryHook("UserPromptSubmit", deps(dir, chunks(JSON.stringify(HOOK_PAYLOADS.UserPromptSubmit)), { repoKey: () => "other" }))).toBe("written");
    const records = spooled(dir);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.c).toBeUndefined();
      expect(r.f.prompt_length).toBe(34);
    }
  });

  it("gives up at its deadline when stdin never ends, and writes nothing", async () => {
    const dir = obsTempDir("hook");
    const never = (async function* () {
      yield Buffer.from('{"session_id":');
      await new Promise(() => undefined);
    })();
    const t = performance.now();
    expect(await runObservatoryHook("Stop", deps(dir, never, { deadlineMs: 150 }))).toBe("timeout");
    const took = performance.now() - t;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1_000);
    expect(existsSync(join(dir, SPOOL_DIR))).toBe(false);
  });

  it("ignores events it does not keep and payloads that are not JSON; drops and counts one too large", async () => {
    const dir = obsTempDir("hook");
    expect(await runObservatoryHook("MessageDisplay", deps(dir, chunks("{}")))).toBe("ignored");
    expect(await runObservatoryHook("Stop", deps(dir, chunks("not json")))).toBe("ignored");
    expect(await runObservatoryHook("Stop", deps(dir, chunks("x".repeat(100)), { maxStdinBytes: 50 }))).toBe("dropped");
    mkdirSync(join(dir, SPOOL_DIR), { recursive: true });
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual([`dropped-${Math.floor(NOW / 60_000)}.log`]);
  });
});

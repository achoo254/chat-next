// The Observatory store under Bun, the runtime of the released tunelo:
// test/support/observatory-store-under-bun.ts opens through bun:sqlite a
// database written here through node:sqlite, and writes one row this side
// reads back. Bun comes from TUNELO_TEST_BUN, else `bun` on PATH; without
// one these tests are skipped.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { SessionTimeline } from "../../src/observatory/store/observatory-store.ts";
import { sessionOps, tempDbPath } from "./store-fixture.ts";

const bun = process.env.TUNELO_TEST_BUN || "bun";
const probe = spawnSync(bun, ["--version"], { encoding: "utf8" });
const version = probe.status === 0 ? probe.stdout.trim() : "";

type Result = { runtime: string; schemaVersion: number; timeline: SessionTimeline };

describe.skipIf(version === "")(`the Observatory store under Bun ${version || "(not found)"}`, () => {
  it("reads through bun:sqlite what node:sqlite wrote, and the other way round", async () => {
    const path = tempDbPath();
    const T = Date.UTC(2026, 10, 21, 3);
    const store = await ObservatoryStore.open({ path });
    store.write(sessionOps("s1", T));
    const written = store.sessionTimeline("s1");
    store.close();

    const run = spawnSync(bun, [join(import.meta.dirname, "..", "support", "observatory-store-under-bun.ts"), path], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: join(import.meta.dirname, "..", ".."),
    });
    if (run.status !== 0) throw new Error(`bun failed: ${run.stderr}`);
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Result;
    expect(result.runtime).toBe("bun");
    expect(result.schemaVersion).toBe(1);
    expect(result.timeline).toEqual(written);

    const again = await ObservatoryStore.open({ path });
    expect(again.sessionTimeline("s1").prompts.map((p) => p.promptId)).toEqual(["from-bun", "s1-p1"]);
    again.close();
  });
});

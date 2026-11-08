// The forward path under Bun, the runtime of the released tunelo (its
// node:http differs from Node's): test/support/forward-under-bun.ts runs the
// scenarios in Bun and prints the results. Bun comes from TUNELO_TEST_BUN,
// else `bun` on PATH; without one these tests are skipped. A caller that
// leaves is only reported by Bun from the release's version on (1.3 reports
// nothing once the body was read), so that check needs at least it.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

/** The Bun of agent-release.yml. */
const RELEASE_BUN = [1, 4, 4];
const bun = process.env.TUNELO_TEST_BUN || "bun";
const probe = spawnSync(bun, ["--version"], { encoding: "utf8" });
const version = probe.status === 0 ? probe.stdout.trim() : "";
const atLeastRelease = (() => {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = RELEASE_BUN[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
})();

type Results = {
  basic: { status: number; body: string };
  ipv6: { status: number; body: string };
  uppercase: { status: number; body: string };
  chunkedTooLarge: { status: number };
  cutOff: { cut: boolean; callerLeft: boolean };
  callerLeft: { appClosed: boolean; logged: boolean };
};

let results: Results;

describe.skipIf(version === "")(`the forward path under Bun ${version || "(not found)"}`, () => {
  beforeAll(() => {
    const run = spawnSync(bun, [join(import.meta.dirname, "..", "support", "forward-under-bun.ts")], { encoding: "utf8", timeout: 30_000, cwd: join(import.meta.dirname, "..", "..") });
    if (run.status !== 0) throw new Error(`bun failed: ${run.stderr}`);
    results = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Results;
  });

  test("forwards with Host localhost, any case of the path, and to an app on ::1", () => {
    expect(results.basic.status).toBe(200);
    expect(results.basic.body).toMatch(/^app localhost:\d+ GET \/a\?b=1 0$/);
    expect(results.uppercase.body).toMatch(/GET \/up /);
    expect(results.ipv6.status).toBe(200);
  });

  test("a chunked body over the limit gets 413; a response over it is cut off for that reason", () => {
    expect(results.chunkedTooLarge.status).toBe(413);
    expect(results.cutOff).toEqual({ cut: true, callerLeft: false });
  });

  test.skipIf(!atLeastRelease)("a caller that leaves ends the request to the app at once", () => {
    expect(results.callerLeft).toEqual({ appClosed: true, logged: true });
  });
});

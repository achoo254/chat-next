// The CI watcher's pure logic: which project keys are GitHub repositories,
// reading `gh run list --json`, and one poll's step of a watch (events of runs
// newer than the push on its branch, each once; done when quiet or too old).
import { describe, expect, it } from "vitest";
import { MAX_WATCH_MS, PUSH_SLACK_MS, type CiRun, mergePush, newWatch, parseRunList, runListArgs, stepWatch } from "../../src/observatory/ci/ci-run-tracking.ts";
import { githubRepoOf } from "../../src/observatory/ci/github-repo.ts";
import type { SessionEventWrite, WriteOp } from "../../src/observatory/store/write-ops.ts";

const PUSH_AT = Date.parse("2026-11-25T10:00:00Z");

const run = (id: number, over: Partial<CiRun> = {}): CiRun => ({
  id,
  name: "CI",
  completed: false,
  success: false,
  createdAt: PUSH_AT + 5_000,
  updatedAt: PUSH_AT + 5_000,
  headBranch: "main",
  ...over,
});

const events = (ops: readonly WriteOp[]): SessionEventWrite[] => ops.flatMap((op) => (op.kind === "sessionEvent" ? [op.row] : []));

describe("githubRepoOf", () => {
  it("reads owner/repo from every form of a GitHub remote", () => {
    const cases: [string, string | undefined][] = [
      ["github.com/acme/app", "acme/app"],
      ["https://github.com/acme/app.git", "acme/app"],
      ["https://github.com/acme/app", "acme/app"],
      ["https://GitHub.com/acme/my.app/", "acme/my.app"],
      ["git@github.com:acme/app.git", "acme/app"],
      ["ssh://git@github.com/acme/app.git", "acme/app"],
      ["ssh://git@github.com:22/acme/app", "acme/app"],
      ["https://gitlab.com/acme/app.git", undefined],
      ["https://github.com.evil.example/acme/app", undefined],
      ["github.com/acme", undefined],
      ["github.com/acme/app/tree/main", undefined],
      ["github.com/-acme/app", undefined],
      ["github.com/acme/..", undefined],
      ["local:app", undefined],
      ["scratch", undefined],
    ];
    for (const [key, repo] of cases) expect(githubRepoOf(key), key).toBe(repo);
  });
});

describe("parseRunList", () => {
  it("reads the runs and skips an entry that is not one", () => {
    const out = JSON.stringify([
      { databaseId: 11, name: "CI", status: "in_progress", conclusion: "", createdAt: "2026-11-25T10:00:05Z", updatedAt: "2026-11-25T10:00:06Z", headBranch: "main" },
      { databaseId: 12, name: "Deploy", status: "completed", conclusion: "failure", createdAt: "2026-11-25T10:00:05Z", updatedAt: "2026-11-25T10:02:05Z", headBranch: "main" },
      { databaseId: "13", status: "queued", createdAt: "x", updatedAt: "y" },
      { databaseId: 14, status: "queued", createdAt: "not a date", updatedAt: "2026-11-25T10:00:06Z" },
    ]);
    expect(parseRunList(out)).toEqual([
      { id: 11, name: "CI", completed: false, success: false, createdAt: PUSH_AT + 5_000, updatedAt: PUSH_AT + 6_000, headBranch: "main" },
      { id: 12, name: "Deploy", completed: true, success: false, createdAt: PUSH_AT + 5_000, updatedAt: PUSH_AT + 125_000, headBranch: "main" },
    ]);
  });

  it("throws on output that is not a JSON list", () => {
    expect(() => parseRunList("gh: not found")).toThrow();
    expect(() => parseRunList('{"message":"x"}')).toThrow(/list/);
  });

  it("asks gh for push runs of the repository, as JSON with only the fields kept", () => {
    expect(runListArgs("acme/app")).toEqual(["run", "list", "-R", "acme/app", "--event", "push", "--limit", "20", "--json", "databaseId,name,status,conclusion,createdAt,updatedAt,headBranch"]);
  });
});

describe("stepWatch", () => {
  it("writes ci_started when a run is first seen and ci_finished once it completed, each once, at station GIT", () => {
    const w = newWatch("s1", "acme/app", PUSH_AT, "main");
    let step = stepWatch(w, [run(1)], PUSH_AT + 15_000);
    expect(events(step.ops).map((e) => [e.kind, e.at, e.label, e.station, e.flag, e.number])).toEqual([["ci_started", PUSH_AT + 5_000, "CI", "GIT", undefined, undefined]]);
    expect(step.done).toBe(false);
    step = stepWatch(w, [run(1)], PUSH_AT + 30_000);
    expect(step.ops).toEqual([]);
    expect(step.done).toBe(false);
    step = stepWatch(w, [run(1, { completed: true, success: true, updatedAt: PUSH_AT + 95_000 })], PUSH_AT + 45_000);
    expect(events(step.ops).map((e) => [e.kind, e.at, e.label, e.station, e.flag, e.number])).toEqual([["ci_finished", PUSH_AT + 95_000, "CI", "GIT", true, 90_000]]);
    step = stepWatch(w, [run(1, { completed: true, success: true, updatedAt: PUSH_AT + 95_000 })], PUSH_AT + 60_000);
    expect(step.ops).toEqual([]);
  });

  it("keys each event by the run's id and kind, so a run read again is one row", () => {
    const a = stepWatch(newWatch("s1", "acme/app", PUSH_AT, "main"), [run(7, { completed: true, success: false })], PUSH_AT);
    const b = stepWatch(newWatch("s1", "acme/app", PUSH_AT, "main"), [run(7, { completed: true, success: false })], PUSH_AT);
    const keysA = events(a.ops).map((e) => e.dedupeKey);
    expect(keysA).toEqual(events(b.ops).map((e) => e.dedupeKey));
    expect(new Set(keysA).size).toBe(2);
    expect(events(a.ops).map((e) => [e.kind, e.flag])).toEqual([
      ["ci_started", undefined],
      ["ci_finished", false],
    ]);
  });

  it("leaves out runs older than the push (less the slack) and runs of another branch", () => {
    const w = newWatch("s1", "acme/app", PUSH_AT, "main");
    const step = stepWatch(w, [run(1, { createdAt: PUSH_AT - PUSH_SLACK_MS - 1 }), run(2, { createdAt: PUSH_AT - PUSH_SLACK_MS + 1 }), run(3, { headBranch: "feature" })], PUSH_AT);
    expect(events(step.ops).map((e) => e.dedupeKey)).toEqual([expect.stringContaining("2]")]);
  });

  it("takes every branch when the pushed one is not known", () => {
    const w = newWatch("s1", "acme/app", PUSH_AT, undefined);
    expect(events(stepWatch(w, [run(1, { headBranch: "feature" }), run(2)], PUSH_AT).ops)).toHaveLength(2);
  });

  it("is done once every run completed and nothing new came for two polls", () => {
    const w = newWatch("s1", "acme/app", PUSH_AT, "main");
    const done = run(1, { completed: true, success: true });
    expect(stepWatch(w, [done], PUSH_AT + 15_000).done).toBe(false);
    expect(stepWatch(w, [done], PUSH_AT + 30_000).done).toBe(false);
    expect(stepWatch(w, [done], PUSH_AT + 45_000).done).toBe(true);
  });

  it("is done after two quiet polls when no run comes at all", () => {
    const w = newWatch("s1", "acme/app", PUSH_AT, "main");
    expect(stepWatch(w, [], PUSH_AT + 15_000).done).toBe(false);
    expect(stepWatch(w, [], PUSH_AT + 30_000).done).toBe(true);
  });

  it("goes on while a run is running, and ends at its deadline whatever runs", () => {
    const w = newWatch("s1", "acme/app", PUSH_AT, "main");
    for (let t = 1; t < 10; t++) expect(stepWatch(w, [run(1)], PUSH_AT + t * 15_000).done).toBe(false);
    expect(stepWatch(w, [run(1)], PUSH_AT + MAX_WATCH_MS).done).toBe(true);
  });

  it("merges a later push: longer deadline, quiet count reset, every branch when the branches differ", () => {
    const w = newWatch("s1", "acme/app", PUSH_AT, "main");
    stepWatch(w, [], PUSH_AT + 15_000);
    mergePush(w, PUSH_AT + 20_000, "feature");
    expect(w.quietPolls).toBe(0);
    expect(w.deadline).toBe(PUSH_AT + 20_000 + MAX_WATCH_MS);
    expect(w.since).toBe(PUSH_AT - PUSH_SLACK_MS);
    expect(w.branch).toBeUndefined();
  });
});

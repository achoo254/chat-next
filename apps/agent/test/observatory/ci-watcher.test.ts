// The CI watcher with a fake `gh` (no test ever starts the real one): a push
// of a GitHub project polls every 15 s and writes ci_started / ci_finished of
// the pushing session; it stops when the runs are done, when switched off, and
// never starts without gh or a GitHub remote; signed out, it tries again
// later. A watch that ends with runs not completed writes them as unknown. The
// ingest hands it every push that succeeded, and nothing else.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_RUN_GRACE_MS } from "../../src/observatory/ci/ci-run-tracking.ts";
import { AUTH_RETRY_MS, CiWatcher, MAX_WATCHES, POLL_MS } from "../../src/observatory/ci/ci-watcher.ts";
import type { GhRunner } from "../../src/observatory/ci/gh-runner.ts";
import type { PushToWatch } from "../../src/observatory/ingest/normalized-record.ts";
import { ObservatoryIngest } from "../../src/observatory/ingest/observatory-ingest.ts";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import type { FilteredHookRecord } from "../../src/observatory/privacy/filtered-record.ts";
import type { SessionEventWrite, WriteOp } from "../../src/observatory/store/write-ops.ts";

const PUSH_AT = Date.parse("2026-11-25T10:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

type RawRun = { databaseId: number; name: string; status: string; conclusion: string; createdAt: string; updatedAt: string; headBranch: string };
const raw = (id: number, status: string, conclusion = "", updatedAfterMs = 1_000, name = "CI"): RawRun => ({
  databaseId: id,
  name,
  status,
  conclusion,
  createdAt: iso(PUSH_AT + 2_000),
  updatedAt: iso(PUSH_AT + 2_000 + updatedAfterMs),
  headBranch: "main",
});

type FakeGh = { runGh: GhRunner; calls: string[][]; runs: RawRun[] | Error; missing: boolean; signedOut: boolean };

function fakeGh(): FakeGh {
  const gh: FakeGh = {
    calls: [],
    runs: [],
    missing: false,
    signedOut: false,
    runGh: async (args) => {
      gh.calls.push([...args]);
      if (gh.missing) throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      if (args[0] === "--version") return "gh version 2.80.0\n";
      if (args[0] === "auth") {
        if (gh.signedOut) throw new Error("not logged in");
        return "";
      }
      if (args[0] === "run" && args[1] === "list") {
        if (gh.runs instanceof Error) throw gh.runs;
        return JSON.stringify(gh.runs);
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
  return gh;
}

type Rig = { watcher: CiWatcher; gh: FakeGh; ops: WriteOp[]; problems: string[]; logs: string[]; on: { value: boolean } };

function rig(): Rig {
  const gh = fakeGh();
  const ops: WriteOp[] = [];
  const problems: string[] = [];
  const logs: string[] = [];
  const on = { value: true };
  const watcher = new CiWatcher({ enabled: () => on.value, push: (op) => ops.push(op), problems: (place) => problems.push(place), log: (line) => logs.push(line), runGh: gh.runGh });
  return { watcher, gh, ops, problems, logs, on };
}

const pushOf = (over: Partial<PushToWatch> = {}): PushToWatch => ({ sessionId: "s1", at: PUSH_AT, projectKey: "https://github.com/acme/app.git", branch: "main", ...over });
const events = (ops: readonly WriteOp[]): SessionEventWrite[] => ops.flatMap((op) => (op.kind === "sessionEvent" ? [op.row] : []));
const brief = (ops: readonly WriteOp[]): unknown[] => events(ops).map((e) => [e.sessionId, e.kind, e.label, e.flag, e.number, e.station]);
const listCalls = (gh: FakeGh): string[][] => gh.calls.filter((c) => c[0] === "run");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(PUSH_AT);
});
afterEach(() => vi.useRealTimers());

describe("CiWatcher", () => {
  it("writes ci_started for a new run and ci_finished with its outcome and duration, then stops", async () => {
    const r = rig();
    r.watcher.pushed(pushOf());
    expect(r.gh.calls).toEqual([]);
    r.gh.runs = [raw(1, "in_progress")];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(r.gh.calls.slice(0, 2)).toEqual([["--version"], ["auth", "status", "--hostname", "github.com"]]);
    expect(listCalls(r.gh)[0]).toEqual(["run", "list", "-R", "acme/app", "--event", "push", "--limit", "20", "--json", "databaseId,name,status,conclusion,createdAt,updatedAt,headBranch"]);
    expect(brief(r.ops)).toEqual([["s1", "ci_started", "CI", undefined, undefined, "GIT"]]);
    r.gh.runs = [raw(1, "completed", "success", 70_000)];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(brief(r.ops.slice(1))).toEqual([["s1", "ci_finished", "CI", true, 70_000, "GIT"]]);
    // Two quiet polls, then nothing more is asked.
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(r.watcher.watching).toBe(0);
    const asked = listCalls(r.gh).length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(listCalls(r.gh).length).toBe(asked);
    expect(r.ops).toHaveLength(2);
    // gh was checked once.
    expect(r.gh.calls.filter((c) => c[0] === "--version")).toHaveLength(1);
  });

  it("writes ci_cancelled, with no flag, for a run GitHub cancelled", async () => {
    const r = rig();
    r.gh.runs = [raw(7, "completed", "cancelled", 3_000)];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(brief(r.ops)).toEqual([
      ["s1", "ci_started", "CI", undefined, undefined, "GIT"],
      ["s1", "ci_cancelled", "CI", undefined, 3_000, "GIT"],
    ]);
  });

  it("flags a failed run as not successful", async () => {
    const r = rig();
    r.gh.runs = [raw(5, "completed", "failure", 30_000, "Deploy")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(brief(r.ops)).toEqual([
      ["s1", "ci_started", "Deploy", undefined, undefined, "GIT"],
      ["s1", "ci_finished", "Deploy", false, 30_000, "GIT"],
    ]);
  });

  it("leaves out runs created before the push, and gives up once the grace after the push passed without a run", async () => {
    const r = rig();
    r.gh.runs = [{ ...raw(1, "completed", "success"), createdAt: iso(PUSH_AT - 10 * 60_000), updatedAt: iso(PUSH_AT - 9 * 60_000) }];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(r.ops).toEqual([]);
    // No run yet: the quiet polls do not end it before the grace.
    expect(r.watcher.watching).toBe(1);
    await vi.advanceTimersByTimeAsync(FIRST_RUN_GRACE_MS);
    expect(r.watcher.watching).toBe(0);
    expect(r.ops).toEqual([]);
  });

  it("merges pushes of one session into one watch, and gives another session its own", async () => {
    const r = rig();
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    r.watcher.pushed(pushOf({ at: PUSH_AT + 1_000 }));
    r.watcher.pushed(pushOf({ sessionId: "s2", projectKey: "git@github.com:acme/app.git" }));
    expect(r.watcher.watching).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(listCalls(r.gh)).toHaveLength(2);
    expect(brief(r.ops).map((e) => (e as unknown[]).slice(0, 2))).toEqual([
      ["s1", "ci_started"],
      ["s2", "ci_started"],
    ]);
  });

  it("tries a failed poll again without writing anything", async () => {
    const r = rig();
    r.gh.runs = new Error("network");
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(r.ops).toEqual([]);
    expect(r.problems).toContain("ci-watch");
    expect(r.watcher.watching).toBe(1);
    r.gh.runs = [raw(1, "queued")];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(brief(r.ops)).toEqual([["s1", "ci_started", "CI", undefined, undefined, "GIT"]]);
  });

  it("stops after 30 minutes however the runs stand, writing a run still running as unknown", async () => {
    const r = rig();
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.watcher.watching).toBe(0);
    expect(brief(r.ops)).toEqual([
      ["s1", "ci_started", "CI", undefined, undefined, "GIT"],
      ["s1", "ci_finished", "CI", undefined, undefined, "GIT"],
    ]);
    const asked = listCalls(r.gh).length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(listCalls(r.gh).length).toBe(asked);
    expect(r.ops).toHaveLength(2);
  });

  it("writes a run still running as unknown when gh keeps failing until the deadline", async () => {
    const r = rig();
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    r.gh.runs = new Error("network");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.watcher.watching).toBe(0);
    expect(brief(r.ops).map((e) => (e as unknown[]).slice(1, 4))).toEqual([
      ["ci_started", "CI", undefined],
      ["ci_finished", "CI", undefined],
    ]);
  });

  it("writes nothing more once switched off, writes the runs still running as unknown when stopped, and follows pushes again after a stop", async () => {
    const r = rig();
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    r.on.value = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(r.watcher.watching).toBe(0);
    // Switched off: the started run gets no outcome row; a device ages it out by itself.
    expect(events(r.ops).map((e) => [e.kind, e.flag])).toEqual([["ci_started", undefined]]);
    r.on.value = true;
    r.ops.length = 0;
    r.gh.runs = [raw(2, "in_progress")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    r.watcher.stop();
    expect(r.watcher.watching).toBe(0);
    expect(events(r.ops).map((e) => [e.kind, e.flag])).toEqual([
      ["ci_started", undefined],
      ["ci_finished", undefined],
    ]);
    r.watcher.pushed(pushOf());
    expect(r.watcher.watching).toBe(1);
  });

  it("does not run without gh until the agent starts again", async () => {
    const r = rig();
    r.gh.missing = true;
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(listCalls(r.gh)).toEqual([]);
    expect(r.watcher.watching).toBe(0);
    r.gh.missing = false;
    vi.setSystemTime(PUSH_AT + AUTH_RETRY_MS * 3);
    r.watcher.pushed(pushOf({ at: Date.now() }));
    expect(r.watcher.watching).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(listCalls(r.gh)).toEqual([]);
    expect(r.ops).toEqual([]);
  });

  it("signed out, holds pushes back for a while and checks again at the next push after that", async () => {
    const r = rig();
    r.gh.signedOut = true;
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(listCalls(r.gh)).toEqual([]);
    expect(r.watcher.watching).toBe(0);
    r.gh.signedOut = false;
    // Within the back-off: not followed, gh not asked again.
    r.watcher.pushed(pushOf({ at: Date.now() }));
    expect(r.watcher.watching).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_MS);
    r.gh.runs = [{ ...raw(2, "in_progress"), createdAt: iso(Date.now() + 1_000), updatedAt: iso(Date.now() + 2_000) }];
    r.watcher.pushed(pushOf({ at: Date.now() }));
    expect(r.watcher.watching).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(r.gh.calls.filter((c) => c[0] === "auth")).toHaveLength(2);
    expect(listCalls(r.gh)).toHaveLength(1);
    expect(brief(r.ops)).toEqual([["s1", "ci_started", "CI", undefined, undefined, "GIT"]]);
  });

  it("follows at most MAX_WATCHES watches at once", () => {
    const r = rig();
    for (let i = 0; i < MAX_WATCHES + 3; i++) r.watcher.pushed(pushOf({ sessionId: `s${i}` }));
    expect(r.watcher.watching).toBe(MAX_WATCHES);
    expect(MAX_WATCHES * (3_600_000 / POLL_MS)).toBeLessThan(2_500);
  });

  it("does not run when switched off, and a running watch ends at its next poll once switched off", async () => {
    const r = rig();
    r.on.value = false;
    r.watcher.pushed(pushOf());
    expect(r.watcher.watching).toBe(0);
    r.on.value = true;
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    r.on.value = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(r.gh.calls).toEqual([]);
    expect(r.watcher.watching).toBe(0);
  });

  it("follows only GitHub projects, and not a push older than a watch's life", async () => {
    const r = rig();
    r.watcher.pushed(pushOf({ projectKey: "https://gitlab.com/acme/app.git" }));
    r.watcher.pushed(pushOf({ projectKey: "local:app" }));
    r.watcher.pushed(pushOf({ at: PUSH_AT - 31 * 60_000 }));
    expect(r.watcher.watching).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(r.gh.calls).toEqual([]);
  });

  it("writes nothing for a poll that was still running when it stopped", async () => {
    const r = rig();
    let release: (() => void) | undefined;
    const slow: GhRunner = (args) => (args[0] === "run" ? new Promise((resolve) => (release = () => resolve(JSON.stringify([raw(1, "queued")])))) : r.gh.runGh(args));
    const watcher = new CiWatcher({ enabled: () => true, push: (op) => r.ops.push(op), problems: () => undefined, runGh: slow });
    watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    watcher.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(r.ops).toEqual([]);
  });
});

describe("the ingest hands pushes to the watcher", () => {
  const hook = (event: string, at: number, f: Record<string, string | number | boolean>): FilteredHookRecord => ({
    v: 1,
    src: "hook",
    event,
    at,
    f: { session_id: "s1", cwd: "~/work/app", project_key: "https://github.com/acme/app.git", prompt_id: "p1", tool_name: "Bash", target: "git", station: "GIT", ...f },
  });

  it("calls onPushed for a push that succeeded, with the branch of its folder, and for nothing else", async () => {
    const pushes: PushToWatch[] = [];
    const ingest = new ObservatoryIngest({ push: () => undefined, home: "/home/nobody", log: () => undefined, branchOf: () => "main", onPushed: (p) => pushes.push(p) });
    await ingest.accept(hook("PreToolUse", 1_000, { tool_use_id: "t1", station_flags: StationFlag.push }), "spool");
    await ingest.accept(hook("PostToolUse", 1_500, { tool_use_id: "t1", station_flags: StationFlag.push }), "spool");
    await ingest.accept(hook("PostToolUseFailure", 2_500, { tool_use_id: "t2", station_flags: StationFlag.push }), "spool");
    await ingest.accept(hook("PostToolUse", 3_500, { tool_use_id: "t3", station_flags: StationFlag.commit }), "spool");
    await ingest.accept(hook("PostToolUse", 4_500, { tool_use_id: "t4", station_flags: StationFlag.push | StationFlag.ci }), "sdk");
    expect(pushes).toEqual([
      { sessionId: "s1", at: 1_500, projectKey: "https://github.com/acme/app.git", branch: "main" },
      { sessionId: "s1", at: 4_500, projectKey: "https://github.com/acme/app.git", branch: "main" },
    ]);
  });

  it("counts a watcher that throws as a failed record, never rethrowing", async () => {
    const ingest = new ObservatoryIngest({
      push: () => undefined,
      home: "/home/nobody",
      log: () => undefined,
      branchOf: () => undefined,
      onPushed: () => {
        throw new Error("boom");
      },
    });
    await expect(ingest.accept(hook("PostToolUse", 1_500, { tool_use_id: "t1", station_flags: StationFlag.push }), "spool")).resolves.toBeUndefined();
    expect(ingest.stats.failed).toBe(1);
  });
});

describe("CiWatcher log", () => {
  it("tells the start, the check of gh, the events and the end of a watch", async () => {
    const r = rig();
    r.gh.runs = [raw(1, "completed", "success", 5_000)];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(r.logs).toEqual([
      "ci: following acme/app after a push (branch main)",
      "ci: gh is ready",
      "ci: 2 event(s) written for acme/app (1 run(s) listed)",
      "ci: stopped following acme/app (1 run(s) seen)",
    ]);
  });

  it("says once why gh keeps a push from being followed: missing, or signed out", async () => {
    const missing = rig();
    missing.gh.missing = true;
    missing.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    missing.watcher.pushed(pushOf({ sessionId: "s2" }));
    missing.watcher.pushed(pushOf({ sessionId: "s3" }));
    expect(missing.logs).toEqual([
      "ci: following acme/app after a push (branch main)",
      "ci: gh is missing (spawn gh ENOENT): pushes are not followed until the agent restarts",
      "ci: stopped following acme/app (0 run(s) seen)",
      "ci: a push is not followed: gh is missing",
    ]);
    const out = rig();
    out.gh.signedOut = true;
    out.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    out.watcher.pushed(pushOf({ sessionId: "s2" }));
    out.watcher.pushed(pushOf({ sessionId: "s3" }));
    expect(out.logs).toEqual([
      "ci: following acme/app after a push (branch main)",
      "ci: gh is not signed in to github.com (not logged in): pushes are not followed for 10 minutes",
      "ci: stopped following acme/app (0 run(s) seen)",
      "ci: a push is not followed: gh is signed out, checking again later",
    ]);
  });

  it("says once that a push is not followed: a project that is not on GitHub, or the switch off", () => {
    const r = rig();
    r.watcher.pushed(pushOf({ projectKey: "https://gitlab.example.com/team/app.git" }));
    r.watcher.pushed(pushOf({ projectKey: "local:app" }));
    r.on.value = false;
    r.watcher.pushed(pushOf());
    r.watcher.pushed(pushOf());
    expect(r.logs).toEqual(["ci: a push is not followed: its project is not a GitHub repository", "ci: a push is not followed: the CI watcher or the Observatory is switched off"]);
  });
});

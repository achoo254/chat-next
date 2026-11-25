// The CI watcher with a fake `gh` (no test ever starts the real one): a push
// of a GitHub project polls every 15 s and writes ci_started / ci_finished of
// the pushing session; it stops when the runs are done, when switched off, and
// never starts without gh or a GitHub remote. The ingest hands it every push
// that succeeded, and nothing else.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CiWatcher, POLL_MS } from "../../src/observatory/ci/ci-watcher.ts";
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

type Rig = { watcher: CiWatcher; gh: FakeGh; ops: WriteOp[]; problems: string[]; on: { value: boolean } };

function rig(): Rig {
  const gh = fakeGh();
  const ops: WriteOp[] = [];
  const problems: string[] = [];
  const on = { value: true };
  const watcher = new CiWatcher({ enabled: () => on.value, push: (op) => ops.push(op), problems: (place) => problems.push(place), runGh: gh.runGh });
  return { watcher, gh, ops, problems, on };
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

  it("leaves out runs created before the push", async () => {
    const r = rig();
    r.gh.runs = [{ ...raw(1, "completed", "success"), createdAt: iso(PUSH_AT - 10 * 60_000), updatedAt: iso(PUSH_AT - 9 * 60_000) }];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(r.ops).toEqual([]);
    expect(r.watcher.watching).toBe(0);
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

  it("stops after 30 minutes however the runs stand", async () => {
    const r = rig();
    r.gh.runs = [raw(1, "in_progress")];
    r.watcher.pushed(pushOf());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.watcher.watching).toBe(0);
    const asked = listCalls(r.gh).length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(listCalls(r.gh).length).toBe(asked);
  });

  it("does not run without gh, nor when gh is signed out, until the agent starts again", async () => {
    for (const fault of ["missing", "signedOut"] as const) {
      const r = rig();
      r.gh[fault] = true;
      r.gh.runs = [raw(1, "in_progress")];
      r.watcher.pushed(pushOf());
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(listCalls(r.gh), fault).toEqual([]);
      expect(r.watcher.watching).toBe(0);
      r.gh[fault] = false;
      r.watcher.pushed(pushOf({ at: PUSH_AT + 20_000 }));
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(listCalls(r.gh), fault).toEqual([]);
      expect(r.ops).toEqual([]);
    }
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

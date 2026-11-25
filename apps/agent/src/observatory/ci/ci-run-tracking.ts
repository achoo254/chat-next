// The CI watcher's logic, pure (no process, no timer, no store): the
// `gh run list` call, reading its JSON, and one poll's step of a watch, which
// says the session events to write and whether the watch is done.
//
// A watch follows the push runs of one repository for one session: those
// created after its first push less PUSH_SLACK_MS (the run is created by
// GitHub, whose clock and the push's own may differ), on the pushed branch
// when it was read. Each run gives `ci_started` the first time it is seen and
// `ci_finished` once it completed; both are keyed by the run's id, so a run
// seen again, or by a second watch of the session, is stored once. A watch is
// done once every run it saw completed and no new run came for QUIET_POLLS
// polls, or MAX_WATCH_MS after its last push. Only the workflow's name, the
// run's outcome and its times are kept: never a URL, a commit message or a
// person's name.
import { z } from "zod";
import { sessionEventOp } from "../ingest/session-event-write.ts";
import { labelValue } from "../privacy/privacy-labels.ts";
import type { WriteOp } from "../store/write-ops.ts";

/** Runs created this long before the push still count as the push's. */
export const PUSH_SLACK_MS = 30_000;
/** Polls without a running or new run before a watch is done. */
export const QUIET_POLLS = 2;
/** A watch ends this long after its last push, however its runs stand. */
export const MAX_WATCH_MS = 30 * 60_000;
/** Runs read per poll. */
const RUN_LIST_LIMIT = 20;
const RUN_FIELDS = "databaseId,name,status,conclusion,createdAt,updatedAt,headBranch";
/** A workflow name longer than this is not kept. */
const MAX_NAME_CHARS = 120;

/** The `gh` arguments of one poll of `repo` (`owner/repo`). */
export function runListArgs(repo: string): string[] {
  return ["run", "list", "-R", repo, "--event", "push", "--limit", String(RUN_LIST_LIMIT), "--json", RUN_FIELDS];
}

/** One run as the watcher reads it; times in Unix ms. */
export type CiRun = { id: number; name: string | undefined; completed: boolean; success: boolean; createdAt: number; updatedAt: number; headBranch: string | undefined };

const rawRun = z.object({
  databaseId: z.number().int().positive(),
  name: z.string().optional(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headBranch: z.string().nullable().optional(),
});

/**
 * The runs of `gh run list --json` output. Throws when the output is not a
 * JSON array (gh changed or failed oddly: the poll counts as failed); an entry
 * that does not read as a run is skipped.
 */
export function parseRunList(stdout: string): CiRun[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new TypeError("gh run list did not answer with a list");
  const runs: CiRun[] = [];
  for (const entry of parsed) {
    const r = rawRun.safeParse(entry);
    if (!r.success) continue;
    const createdAt = Date.parse(r.data.createdAt);
    const updatedAt = Date.parse(r.data.updatedAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) continue;
    runs.push({
      id: r.data.databaseId,
      name: labelValue(r.data.name, MAX_NAME_CHARS),
      completed: r.data.status === "completed",
      success: r.data.conclusion === "success",
      createdAt,
      updatedAt,
      headBranch: r.data.headBranch ?? undefined,
    });
  }
  return runs;
}

/** What a watch knows: its session and repository, the runs it already wrote, and how long it goes on. */
export type CiWatchState = {
  sessionId: string;
  repo: string;
  /** Runs created before this are older than the push. */
  since: number;
  /** The pushed branch, when read: runs of other branches are not the push's. */
  branch: string | undefined;
  /** The watch ends at this time. */
  deadline: number;
  started: Set<number>;
  finished: Set<number>;
  quietPolls: number;
};

/** A watch of `repo` for the push of `sessionId` at `at`. */
export function newWatch(sessionId: string, repo: string, at: number, branch: string | undefined): CiWatchState {
  return { sessionId, repo, since: at - PUSH_SLACK_MS, branch, deadline: at + MAX_WATCH_MS, started: new Set(), finished: new Set(), quietPolls: 0 };
}

/** Another push of the same session and repository: one watch goes on, longer; a push of another (or an unknown) branch widens it to every branch. */
export function mergePush(state: CiWatchState, at: number, branch: string | undefined): void {
  state.since = Math.min(state.since, at - PUSH_SLACK_MS);
  state.deadline = Math.max(state.deadline, at + MAX_WATCH_MS);
  if (branch !== state.branch) state.branch = undefined;
  state.quietPolls = 0;
}

/** The session event of a run: started (at its creation) or finished (at its last update, with outcome and duration). */
function runEventOp(state: CiWatchState, run: CiRun, kind: "ci_started" | "ci_finished"): WriteOp {
  const facts =
    kind === "ci_started"
      ? { sessionId: state.sessionId, at: run.createdAt, station: "GIT", label: run.name }
      : { sessionId: state.sessionId, at: run.updatedAt, station: "GIT", label: run.name, flag: run.success, number: Math.max(0, run.updatedAt - run.createdAt) };
  return sessionEventOp(kind, facts, [run.id]);
}

/**
 * One poll's step of a watch with the runs `gh` listed: the events to write
 * (a run first seen already completed gets both), and whether the watch is
 * done. Updates `state`.
 */
export function stepWatch(state: CiWatchState, runs: readonly CiRun[], now: number): { ops: WriteOp[]; done: boolean } {
  const ops: WriteOp[] = [];
  let busy = false;
  for (const run of runs) {
    if (run.createdAt < state.since) continue;
    if (state.branch !== undefined && run.headBranch !== state.branch) continue;
    if (!state.started.has(run.id)) {
      state.started.add(run.id);
      ops.push(runEventOp(state, run, "ci_started"));
      busy = true;
    }
    if (!run.completed) busy = true;
    else if (!state.finished.has(run.id)) {
      state.finished.add(run.id);
      ops.push(runEventOp(state, run, "ci_finished"));
    }
  }
  state.quietPolls = busy ? 0 : state.quietPolls + 1;
  return { ops, done: state.quietPolls >= QUIET_POLLS || now >= state.deadline };
}

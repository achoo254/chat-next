// The CI watcher's logic, pure (no process, no timer, no store): the
// `gh run list` call, reading its JSON, and one poll's step of a watch, which
// says the session events to write and whether the watch is done.
//
// A watch follows the push runs of one repository for one session: those
// created after its first push less PUSH_SLACK_MS (the run is created by
// GitHub, whose clock and the push's own may differ), on the pushed branch
// when it was read. Each run gives `ci_started` the first time it is seen and
// `ci_finished` once it completed (`ci_cancelled` instead when GitHub cancelled
// it, usually because a newer push replaced it); each is keyed by the run's id, so a run
// seen again, or by a second watch of the session, is stored once. A watch is
// done once it saw a run, every run it saw completed and no new run came for
// QUIET_POLLS polls; before its first run it waits FIRST_RUN_GRACE_MS after
// the last push (GitHub can take a while to queue a run); and it ends
// MAX_WATCH_MS after its last push whatever its runs do. A watch that ends
// with runs not completed (its deadline, the switch, `gh` failing, the agent
// stopping) writes `ci_finished` for each of them with no flag: the outcome is
// unknown, so a device never shows such a run as running for ever. That event
// has its own key, so a real outcome read later is still stored beside it.
// Only the workflow's name, the run's outcome and its times are kept: never a
// URL, a commit message or a person's name.
import { z } from "zod";
import { sessionEventOp } from "../ingest/session-event-write.ts";
import { labelValue } from "../privacy/privacy-labels.ts";
import type { WriteOp } from "../store/write-ops.ts";

/** Runs created this long before the push still count as the push's. */
export const PUSH_SLACK_MS = 30_000;
/** Polls without a running or new run before a watch is done (counted once a run was seen). */
export const QUIET_POLLS = 2;
/** Before its first run, a watch waits this long after the last push. */
export const FIRST_RUN_GRACE_MS = 3 * 60_000;
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
export type CiRun = { id: number; name: string | undefined; completed: boolean; success: boolean; cancelled: boolean; createdAt: number; updatedAt: number; headBranch: string | undefined };

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
      cancelled: r.data.conclusion === "cancelled",
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
  /** The last push's time: the grace before the first run counts from it. */
  pushedAt: number;
  /** The watch ends at this time. */
  deadline: number;
  /** Runs whose `ci_started` was written, by id (kept to end them as unknown). */
  started: Map<number, CiRun>;
  finished: Set<number>;
  quietPolls: number;
};

/** A watch of `repo` for the push of `sessionId` at `at`. */
export function newWatch(sessionId: string, repo: string, at: number, branch: string | undefined): CiWatchState {
  return { sessionId, repo, since: at - PUSH_SLACK_MS, branch, pushedAt: at, deadline: at + MAX_WATCH_MS, started: new Map(), finished: new Set(), quietPolls: 0 };
}

/** Another push of the same session and repository: one watch goes on, longer; a push of another (or an unknown) branch widens it to every branch. */
export function mergePush(state: CiWatchState, at: number, branch: string | undefined): void {
  state.since = Math.min(state.since, at - PUSH_SLACK_MS);
  state.deadline = Math.max(state.deadline, at + MAX_WATCH_MS);
  state.pushedAt = Math.max(state.pushedAt, at);
  if (branch !== state.branch) state.branch = undefined;
  state.quietPolls = 0;
}

/** The session event of a run: started (at its creation) or finished (at its last update, with outcome and duration). */
function runEventOp(state: CiWatchState, run: CiRun, kind: "ci_started" | "ci_finished" | "ci_cancelled"): WriteOp {
  const facts =
    kind === "ci_started"
      ? { sessionId: state.sessionId, at: run.createdAt, station: "GIT", label: run.name }
      : kind === "ci_cancelled"
        ? // Cancelled (usually replaced by a newer push): neither a pass nor a failure, so no flag.
          { sessionId: state.sessionId, at: run.updatedAt, station: "GIT", label: run.name, number: Math.max(0, run.updatedAt - run.createdAt) }
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
      state.started.set(run.id, run);
      ops.push(runEventOp(state, run, "ci_started"));
      busy = true;
    }
    if (!run.completed) busy = true;
    else if (!state.finished.has(run.id)) {
      state.finished.add(run.id);
      ops.push(runEventOp(state, run, run.cancelled ? "ci_cancelled" : "ci_finished"));
    }
  }
  // Quiet polls count only once a run was seen; before that, the grace after the push decides.
  const seen = state.started.size > 0;
  state.quietPolls = busy || !seen ? 0 : state.quietPolls + 1;
  const quiet = seen ? state.quietPolls >= QUIET_POLLS : now >= state.pushedAt + FIRST_RUN_GRACE_MS;
  return { ops, done: quiet || now >= state.deadline };
}

/**
 * The events that end a watch at `now` with runs not completed: a
 * `ci_finished` without a flag (outcome unknown) for each, keyed apart from
 * the real one. Marks them finished, so calling it twice writes nothing more.
 */
export function endWatch(state: CiWatchState, now: number): WriteOp[] {
  const ops: WriteOp[] = [];
  for (const [id, run] of state.started) {
    if (state.finished.has(id)) continue;
    state.finished.add(id);
    ops.push(sessionEventOp("ci_finished", { sessionId: state.sessionId, at: Math.max(now, run.createdAt), station: "GIT", label: run.name }, [id, "unknown"]));
  }
  return ops;
}

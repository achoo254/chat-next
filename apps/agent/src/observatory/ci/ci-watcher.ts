// Follows GitHub Actions after a session's push, inside the agent. The ingest
// tells it every push that succeeded (observatory-ingest.ts `onPushed`); for a
// session whose project key is a GitHub remote it polls `gh run list` every
// POLL_MS and writes `ci_started` / `ci_finished` session events of that
// session (ci-run-tracking.ts) through the store's writer, so the hub sends
// them to the devices watching it like any other row.
//
// - One watch per session and repository: more pushes of the session merge
//   into it; another session pushing the same repository gets its own.
// - `gh` is checked once per agent run, at the first push (`gh --version`,
//   then `gh auth status`): missing or signed out, the watcher stays off,
//   silently, until the agent starts again.
// - A poll that fails (no network, `gh` failing) is reported to the throttled
//   problem log (no content) and tried again at the next poll; it writes
//   nothing. Switched off (the config or the Observatory switch), a watch ends
//   at its next poll.
// - A push older than a watch's whole life (a spool read again after a
//   restart) starts nothing.
import type { PushToWatch } from "../ingest/normalized-record.ts";
import type { WriteOp } from "../store/write-ops.ts";
import { type CiWatchState, MAX_WATCH_MS, mergePush, newWatch, parseRunList, runListArgs, stepWatch } from "./ci-run-tracking.ts";
import { type GhRunner, execGh } from "./gh-runner.ts";
import { githubRepoOf } from "./github-repo.ts";

export const POLL_MS = 15_000;
/** Watches at once, at most: a push past this is not followed. */
const MAX_WATCHES = 32;

export type CiWatcherOptions = {
  /** Whether the watcher may run now (the Observatory and CI switches, the service started). */
  enabled: () => boolean;
  /** Queues a write (the store's batch writer). */
  push: (op: WriteOp) => void;
  problems: (place: string, err: unknown) => void;
  /** Runs `gh` (execGh by default; tests pass a fake). */
  runGh?: GhRunner | undefined;
  now?: () => number;
  pollMs?: number;
};

type Watch = { state: CiWatchState; timer: ReturnType<typeof setTimeout> | undefined };

export class CiWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly now: () => number;
  private readonly runGh: GhRunner;
  /** The one check of `gh` this agent run; undefined until the first push. */
  private ghCheck: Promise<boolean> | undefined;
  /** `gh` is missing or signed out: nothing is followed until the agent starts again. */
  private ghOff = false;

  constructor(private readonly opts: CiWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.runGh = opts.runGh ?? execGh;
  }

  /** How many watches run now. */
  get watching(): number {
    return this.watches.size;
  }

  /** A push that succeeded: starts (or extends) the watch of its session and repository. Never throws. */
  pushed(push: PushToWatch): void {
    try {
      if (this.ghOff || !this.opts.enabled()) return;
      const repo = githubRepoOf(push.projectKey);
      if (!repo || this.now() - push.at > MAX_WATCH_MS) return;
      const key = `${push.sessionId}\n${repo}`;
      const current = this.watches.get(key);
      if (current) {
        mergePush(current.state, push.at, push.branch);
        return;
      }
      if (this.watches.size >= MAX_WATCHES) return;
      const watch: Watch = { state: newWatch(push.sessionId, repo, push.at, push.branch), timer: undefined };
      this.watches.set(key, watch);
      this.schedule(key, watch);
    } catch (err) {
      this.opts.problems("ci-watch", err);
    }
  }

  /** Ends every watch (the service stops); the check of `gh` is kept for this agent run. */
  stop(): void {
    for (const watch of this.watches.values()) clearTimeout(watch.timer);
    this.watches.clear();
  }

  private schedule(key: string, watch: Watch): void {
    watch.timer = setTimeout(() => void this.poll(key, watch), this.opts.pollMs ?? POLL_MS);
    watch.timer.unref?.();
  }

  /** `watch` is still the one of `key` (not ended by stop() or a switch while a call ran). */
  private live(key: string, watch: Watch): boolean {
    return this.watches.get(key) === watch;
  }

  private async poll(key: string, watch: Watch): Promise<void> {
    try {
      if (!this.live(key, watch)) return;
      if (!this.opts.enabled()) {
        this.watches.delete(key);
        return;
      }
      if (!(await this.ghReady())) {
        this.stop();
        return;
      }
      if (!this.live(key, watch)) return;
      let stdout: string | undefined;
      try {
        stdout = await this.runGh(runListArgs(watch.state.repo));
      } catch (err) {
        this.opts.problems("ci-watch", err);
      }
      if (!this.live(key, watch)) return;
      if (stdout !== undefined) {
        const step = stepWatch(watch.state, parseRunList(stdout), this.now());
        for (const op of step.ops) this.opts.push(op);
        if (step.done) {
          this.watches.delete(key);
          return;
        }
      } else if (this.now() >= watch.state.deadline) {
        this.watches.delete(key);
        return;
      }
      this.schedule(key, watch);
    } catch (err) {
      // Output that is not a run list: tried again at the next poll, until the watch's deadline.
      this.opts.problems("ci-watch", err);
      if (!this.live(key, watch)) return;
      if (this.now() >= watch.state.deadline) this.watches.delete(key);
      else this.schedule(key, watch);
    }
  }

  private ghReady(): Promise<boolean> {
    this.ghCheck ??= this.checkGh();
    return this.ghCheck;
  }

  /** `gh` installed and signed in to github.com; either failing switches the watcher off for this agent run. */
  private async checkGh(): Promise<boolean> {
    try {
      await this.runGh(["--version"]);
      await this.runGh(["auth", "status", "--hostname", "github.com"]);
      return true;
    } catch {
      this.ghOff = true;
      return false;
    }
  }
}

// Follows GitHub Actions after a session's push, inside the agent. The ingest
// tells it every push that succeeded (observatory-ingest.ts `onPushed`); for a
// session whose project key is a GitHub remote it polls `gh run list` every
// POLL_MS and writes `ci_started` / `ci_finished` session events of that
// session (ci-run-tracking.ts) through the store's writer, so the hub sends
// them to the devices watching it like any other row.
//
// - One watch per session and repository: more pushes of the session merge
//   into it; another session pushing the same repository gets its own.
// - `gh` is checked at the first poll (`gh --version`, then `gh auth
//   status`). Missing (`--version` fails): the watcher stays off, silently,
//   until the agent starts again. Signed out: the pushes of the next
//   AUTH_RETRY_MS are not followed, then the next push checks again.
// - A poll that fails (no network, `gh` failing) is reported to the throttled
//   problem log (no content) and tried again at the next poll; it writes
//   nothing. Switched off (the config or the Observatory switch), a watch ends
//   at its next poll and writes nothing more.
// - A watch that ends otherwise with runs not completed (its deadline, `gh`
//   signed out, stop()) writes their outcome as unknown (ci-run-tracking.ts
//   endWatch), so a device never shows them running for ever.
// - At most MAX_WATCHES watches poll at once: 8 watches at 4 polls a minute
//   stay under 2 000 calls an hour, well inside GitHub's 5 000 an hour.
// - A push older than a watch's whole life (a spool read again after a
//   restart) starts nothing.
import type { PushToWatch } from "../ingest/normalized-record.ts";
import type { WriteOp } from "../store/write-ops.ts";
import { type CiWatchState, endWatch, MAX_WATCH_MS, mergePush, newWatch, parseRunList, runListArgs, stepWatch } from "./ci-run-tracking.ts";
import { type GhRunner, execGh } from "./gh-runner.ts";
import { githubRepoOf } from "./github-repo.ts";

export const POLL_MS = 15_000;
/** Watches at once, at most: a push past this is not followed (keeps the polls far below GitHub's hourly limit). */
export const MAX_WATCHES = 8;
/** After `gh auth status` failed, pushes are not followed for this long; the next push then checks again. */
export const AUTH_RETRY_MS = 10 * 60_000;

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
  /** The check of `gh` in effect; undefined until the first poll, and again after a sign-in check failed. */
  private ghCheck: Promise<boolean> | undefined;
  /** `gh` is missing: nothing is followed until the agent starts again. */
  private ghMissing = false;
  /** `gh` was signed out: pushes before this time are not followed. */
  private authRetryAt = 0;

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
      if (this.ghMissing || this.now() < this.authRetryAt || !this.opts.enabled()) return;
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

  /**
   * Ends every watch (the service stops, a wipe), writing the runs not
   * completed as unknown; pushes start new watches afterwards. The check of
   * `gh` is kept.
   */
  stop(): void {
    for (const key of [...this.watches.keys()]) this.end(key);
  }

  /**
   * Ends the watch of `key`: its timer cleared, its runs not completed written as unknown unless `quiet`
   * (switched off: nothing more is written once the user turned Observatory or CI off; a device ages a run
   * left running out by itself, pipeline-model.ts).
   */
  private end(key: string, quiet = false): void {
    const watch = this.watches.get(key);
    if (!watch) return;
    clearTimeout(watch.timer);
    this.watches.delete(key);
    if (quiet) return;
    try {
      for (const op of endWatch(watch.state, this.now())) this.opts.push(op);
    } catch (err) {
      this.opts.problems("ci-watch", err);
    }
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
        this.end(key, true);
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
      const done = stdout === undefined ? this.now() >= watch.state.deadline : this.step(watch.state, stdout);
      if (done) this.end(key);
      else this.schedule(key, watch);
    } catch (err) {
      // Output that is not a run list: tried again at the next poll, until the watch's deadline.
      this.opts.problems("ci-watch", err);
      if (!this.live(key, watch)) return;
      if (this.now() >= watch.state.deadline) this.end(key);
      else this.schedule(key, watch);
    }
  }

  /** One poll's runs: their events written; whether the watch is done. Throws when the output is not a run list. */
  private step(state: CiWatchState, stdout: string): boolean {
    const step = stepWatch(state, parseRunList(stdout), this.now());
    for (const op of step.ops) this.opts.push(op);
    return step.done;
  }

  private ghReady(): Promise<boolean> {
    this.ghCheck ??= this.checkGh();
    return this.ghCheck;
  }

  /**
   * `gh` installed and signed in to github.com. Missing switches the watcher
   * off for this agent run; signed out holds pushes back for AUTH_RETRY_MS,
   * after which the next push checks again.
   */
  private async checkGh(): Promise<boolean> {
    try {
      await this.runGh(["--version"]);
    } catch {
      this.ghMissing = true;
      return false;
    }
    try {
      await this.runGh(["auth", "status", "--hostname", "github.com"]);
      return true;
    } catch {
      this.authRetryAt = this.now() + AUTH_RETRY_MS;
      this.ghCheck = undefined;
      return false;
    }
  }
}

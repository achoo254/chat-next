// Rolls the store's detail rows into `daily_rollups` on a schedule: a
// retention pass (store/retention.ts) counts rows past the 90 days of detail
// into their day, project and model, then deletes them, leaving out every
// session with an internal label (the Advisor's). Days still in the detail
// tables are read from there; the rollup only ever grows by whole old rows,
// so nothing is counted twice. A pass handles a bounded number of rows; a
// run repeats it (a turn of the event loop between) while rows are left, up
// to MAX_PASSES_PER_RUN, and the next run goes on.
import type { PruneResult } from "../store/retention.ts";

export const ROLLUP_EVERY_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;
const MAX_PASSES_PER_RUN = 20;

export type DailyRollupSchedulerOptions = {
  /** One retention pass on the current store; undefined when there is no store open now. */
  prune: () => PruneResult | undefined;
  problems: (place: string, err: unknown) => void;
  everyMs?: number;
  firstDelayMs?: number;
};

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class DailyRollupScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly opts: DailyRollupSchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    const run = (): void => void this.runOnce();
    this.first = setTimeout(run, this.opts.firstDelayMs ?? FIRST_RUN_DELAY_MS);
    this.first.unref?.();
    this.timer = setInterval(run, this.opts.everyMs ?? ROLLUP_EVERY_MS);
    this.timer.unref?.();
  }

  /** Stops the schedule and waits for a run in progress (it ends after its current pass). */
  async stop(): Promise<void> {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One run now (or the one in progress); never rejects. */
  runOnce(): Promise<void> {
    this.running ??= this.passes()
      .catch((err: unknown) => this.opts.problems("rollup", err))
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async passes(): Promise<void> {
    for (let i = 0; i < MAX_PASSES_PER_RUN; i++) {
      const result = this.opts.prune();
      if (!result?.more) return;
      await yieldLoop();
    }
  }
}

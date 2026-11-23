// The `accept` calls still running into the ingest, so the service's stop can
// let them push their writes before the writer closes, but never waits for
// them without end: a call that never settles (a bug in a sink) must not hang
// the agent's shutdown. After the deadline the stop goes on; what such a call
// pushes later finds no writer and is dropped.

/** How long stop() waits for running `accept` calls (and the spool reader's run) at most. */
export const STOP_WAIT_MS = 5_000;

export class AcceptTracker {
  private readonly running = new Set<Promise<void>>();

  /** Runs `accept` tracked until it settles; resolves or rejects as it does. */
  async track(accept: Promise<void>): Promise<void> {
    this.running.add(accept);
    try {
      await accept;
    } finally {
      this.running.delete(accept);
    }
  }

  /** Settles once every call running now has (never rejects). */
  settled(): Promise<unknown> {
    return Promise.allSettled([...this.running]);
  }
}

/** Waits for `work` at most `ms`; true when it settled in time. The timer never keeps the process alive. */
export async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

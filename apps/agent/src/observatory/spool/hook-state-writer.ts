// The agent's only way to write state.json: one write at a time, in order,
// each taking the state from the config at the moment it runs (not when it
// was asked for), so the last write always holds every change made before
// it, however close together the changes come.
import { writeHookState } from "./hook-state-file.ts";

export type HookStateSource = () => { enabled: boolean; contentOff: readonly string[] };

export class HookStateWriter {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly source: HookStateSource,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Queues a write of the current state; resolves once it (and every write before it) is done. Never rejects. */
  write(): Promise<void> {
    // The source runs inside the guarded write: a throw there is reported, and the queue goes on.
    this.tail = this.tail.then(async () => {
      try {
        await writeHookState(this.dataDir, this.source());
      } catch (err) {
        this.onError(err);
      }
    });
    return this.tail;
  }
}

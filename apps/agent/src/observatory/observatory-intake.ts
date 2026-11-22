// How records come into the running Observatory: the ingest (the sink the
// store's writes go through), the hook spool reader, the queue of the SDK
// sessions' hook callbacks (sdk-hook-feed.ts), and the `accept` calls still
// running, which stop and a wipe wait for (within a bound). The OTLP
// receiver hands its records to `accept` too (observatory-service.ts owns the
// receiver). Holds no store: writes go through the sink, and the spool reader
// commits through the `commit` it is given.
import { homedir } from "node:os";
import type { ConfigStore } from "../config.ts";
import { createSensitiveCheck } from "../safety/sensitive-paths.ts";
import { repoKeyOf } from "../usage/repo-key.ts";
import { contentOffOf } from "./content-settings-config.ts";
import { AcceptTracker, STOP_WAIT_MS, settledWithin } from "./ingest/accept-tracker.ts";
import { type IngestStats, ObservatoryIngest } from "./ingest/observatory-ingest.ts";
import type { FilteredRecord, ObservatorySink, RecordOrigin } from "./privacy/filtered-record.ts";
import { machineAccountNames } from "./privacy/home-and-account.ts";
import { redactRecordAgain } from "./privacy/redact-record-again.ts";
import { type SdkFeedStats, SdkHookFeed } from "./sdk-hook-feed.ts";
import { contentAllowed } from "./spool/hook-state-file.ts";
import { SpoolReader, type SpoolStats } from "./spool/spool-reader.ts";
import { ObservatoryStoreError } from "./store/store-errors.ts";

export type ObservatoryIntakeOptions = {
  config: ConfigStore;
  dataDir: string;
  /** The secret values the agent hides now (the machine's and the receiver's tokens). */
  secrets: () => string[];
  /** Observatory runs now (on in the config, and started). */
  running: () => boolean;
  /** Makes what the sink pushed durable; throws when it could not (AgentStoreHost.commit). */
  commit: () => void;
  problems: (place: string, err: unknown) => void;
  now: () => number;
  stopWaitMs?: number | undefined;
  isSensitive?: ((absolutePath: string) => boolean) | undefined;
  scheduleSdkFeed?: ((work: () => void) => void) | undefined;
};

export class ObservatoryIntake {
  private sink: ObservatorySink | undefined;
  private spool: SpoolReader | undefined;
  /** `accept` calls still running (stop waits for them, within stopWaitMs). */
  private readonly accepting = new AcceptTracker();
  private readonly sdkFeed: SdkHookFeed;
  /** When the last record of any source was taken (Unix ms). */
  lastRecordAt: number | undefined;

  constructor(private readonly opts: ObservatoryIntakeOptions) {
    const home = homedir();
    this.sdkFeed = new SdkHookFeed({
      accept: (record) => this.accept(record, "sdk"),
      home,
      isSensitive: opts.isSensitive ?? createSensitiveCheck({ home }),
      repoKey: repoKeyOf,
      contentAllowed: (projectKey) => contentAllowed({ enabled: true, contentOff: contentOffOf(opts.config), unreadable: false }, projectKey),
      known: () => opts.secrets(),
      accountNames: machineAccountNames(home),
      enabled: opts.running,
      problems: opts.problems,
      now: opts.now,
      ...(opts.scheduleSdkFeed ? { schedule: opts.scheduleSdkFeed } : {}),
    });
  }

  /** Takes records into `sink` from now on, the spool's too. */
  open(sink: ObservatorySink): void {
    this.sink = sink;
    this.startSpool();
  }

  get hasSink(): boolean {
    return this.sink !== undefined;
  }

  /** Takes one record from any source; resolves once its writes are queued (without a sink it is dropped). */
  async accept(record: FilteredRecord, origin: RecordOrigin): Promise<void> {
    const sink = this.sink;
    if (!sink) return;
    this.lastRecordAt = this.opts.now();
    await this.accepting.track(sink.accept(record, origin));
  }

  /** One hook event of a session the agent runs through the SDK (sdk-hook-feed.ts). */
  takeHookEvent(event: string, payload: unknown, label?: string): void {
    this.sdkFeed.take(event, payload, label);
  }

  /** Reads the settled spool files now instead of at the next tick. */
  async drainSpool(): Promise<void> {
    await this.spool?.drainOnce();
  }

  /** Stops the spool reader (waited for stopWaitMs at most) for a wipe; resumeSpool() starts a new one. */
  async pauseSpool(): Promise<void> {
    if (this.spool && !(await settledWithin(this.spool.stop(), this.waitMs))) this.opts.problems("ingest-stop", new ObservatoryStoreError("a spool run still taking records at the wipe was left behind"));
    this.spool = undefined;
  }

  resumeSpool(): void {
    if (this.sink && !this.spool) this.startSpool();
  }

  /**
   * Stops taking records: the spool reader and the `accept` calls still
   * running are waited for, stopWaitMs at most (one that never settles is
   * left behind, logged). The writer may close after this resolves.
   */
  async close(): Promise<void> {
    const taken = (async () => {
      await this.spool?.stop();
      // Writes a sink still pushes go in before the writer closes.
      await this.accepting.settled();
    })();
    if (!(await settledWithin(taken, this.waitMs))) this.opts.problems("ingest-stop", new ObservatoryStoreError("records still being taken at stop were left behind"));
    this.spool = undefined;
    this.sink = undefined;
  }

  get spoolStats(): SpoolStats | undefined {
    return this.spool?.stats;
  }

  get ingestStats(): IngestStats | undefined {
    return this.sink instanceof ObservatoryIngest ? this.sink.stats : undefined;
  }

  get sdkStats(): SdkFeedStats {
    return this.sdkFeed.stats;
  }

  private get waitMs(): number {
    return this.opts.stopWaitMs ?? STOP_WAIT_MS;
  }

  private startSpool(): void {
    this.spool = new SpoolReader({
      dataDir: this.opts.dataDir,
      // Before the ingest gets a record, and before one it refuses is set aside: the quarantine is as private as the store.
      secondPass: (record) => redactRecordAgain(record, this.opts.secrets()),
      accept: (record) => this.accept(record, "spool"),
      commit: async () => this.opts.commit(),
      problems: this.opts.problems,
      now: this.opts.now,
    });
    this.spool.start();
  }
}

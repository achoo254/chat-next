// Observatory inside the running agent: the store (opened with the agent's
// short busy timeout) and its batch writer, the OTLP receiver, the intake of
// records (observatory-intake.ts: the ingest, the hook spool reader, the SDK
// sessions' hook callbacks), and state.json for the hooks. Started with the
// agent after the usage ledger, stopped before the core: the receiver's queue
// is filtered and handed on, the spool reader finishes its chunk, the writer
// writes what waits, then the store closes. Nothing here ever throws into the
// agent or stops it: a part that fails stays off, the problem goes to the
// throttled log (no content), and status() tells.
//
// The projects without content live in the agent's config
// (content-settings-config.ts); state.json and the store's content_settings
// are rebuilt from it at start, on every change, and after a wipe. Records
// reach the store through the ingest (ingest/observatory-ingest.ts, or the one
// given as `ingest`), which also rolls old detail into daily totals on a
// schedule. Stop waits for records still being taken, but only so long.
//
// The spool's tail is read for the sessions someone watches
// (spool/spool-live-tail.ts): watchSession/unwatchSession say which, and
// onLiveEvent listeners get the provisional events (never content). It runs
// while the service runs and stops with it, within the same wait.
//
// The hub (hub/observatory-hub.ts) serves the devices watching a session's
// timeline: every batch the store takes is handed to it, and it starts with
// the service (a new epoch), stops first when the service stops, and takes a
// new epoch after a wipe. It hears the spool's tail too (onLiveEvent): the
// sessions it watches are the ones whose tail is read, and their provisional
// rows go to their watchers before the store has them.
//
// The bottleneck rules (bottlenecks/bottleneck-runner.ts) score every batch
// the store takes and every provisional event, and every 15 s what time
// changes; their findings go back through the writer, so the hub sends them
// to devices like any other row. They start after the store, stop with the
// hub, and stop around a wipe (their read connection closed first).
//
// The CI watcher (ci/ci-watcher.ts) hears every push the ingest takes and,
// for a GitHub repository, writes the session's CI runs through the same
// writer while the service runs and its switch (`observatory.ci`) is on. Its
// watches end when the service stops and around a wipe (runs not completed
// written as unknown); pushes after that start new ones.
import { homedir } from "node:os";
import type { ConfigStore } from "../config.ts";
import { rememberSecret } from "../mcp/redact.ts";
import { ProblemLog } from "../activity/problem-log.ts";
import { AgentStoreHost } from "./agent-store-host.ts";
import { BottleneckRunner } from "./bottlenecks/bottleneck-runner.ts";
import { ciWatchEnabled } from "./ci/ci-watch-config.ts";
import { CiWatcher } from "./ci/ci-watcher.ts";
import type { GhRunner } from "./ci/gh-runner.ts";
import { contentOffOf, setContentOff } from "./content-settings-config.ts";
import { STOP_WAIT_MS, settledWithin } from "./ingest/accept-tracker.ts";
import { DailyRollupScheduler } from "./ingest/daily-rollup-scheduler.ts";
import { ObservatoryIngest } from "./ingest/observatory-ingest.ts";
import { ObservatoryHub } from "./hub/observatory-hub.ts";
import { contextWindowOf } from "./live-map/model-window.ts";
import { ObservatoryIntake } from "./observatory-intake.ts";
import { type ObservatoryStatus, observatoryStatus } from "./observatory-status.ts";
import type { FilteredRecord, ObservatorySink, RecordOrigin } from "./privacy/filtered-record.ts";
import { OtlpReceiverHost, type OtlpReceiverHostOptions } from "./receiver/otlp-receiver-host.ts";
import type { ReceiverTokens, RotateOptions } from "./receiver/receiver-token.ts";
import { deleteTargetKeySalt, ensureTargetKeySalt, readTargetKeySalt } from "./privacy/target-key-salt.ts";

/** How often the agent reads the target key salt file again (observatory-service.ts followTargetKeySalt). */
const TARGET_KEY_SALT_CHECK_MS = 60_000;
import { redactRecordAgain } from "./privacy/redact-record-again.ts";
import { clearSpool } from "./spool/clear-spool.ts";
import { type LiveTailEvent, SpoolLiveTail } from "./spool/spool-live-tail.ts";
import { setAsideBrokenHookState } from "./spool/hook-state-file.ts";
import { HookStateWriter } from "./spool/hook-state-writer.ts";
import { ObservatoryStoreError } from "./store/store-errors.ts";
import type { ObservatoryStore } from "./store/observatory-store.ts";
import type { WriteOp } from "./store/write-ops.ts";

export type ObservatoryServiceOptions = {
  config: ConfigStore;
  /** The Observatory data folder (spool/observatory-data-dir.ts). */
  dataDir: string;
  log: (line: string) => void;
  /** The machine's secret values hidden in records, besides those mcp/redact.ts remembers (the OTLP tokens are added here). */
  knownSecrets: () => readonly string[];
  /** The ingest: takes filtered records and pushes their writes (ObservatoryIngest by default). */
  ingest?: (push: (op: WriteOp) => void) => ObservatorySink;
  /** Opens the store at `path` (tests pass a failing one). */
  openStore?: (path: string) => Promise<ObservatoryStore>;
  now?: () => number;
  /** How long stop() waits for records still being taken (STOP_WAIT_MS by default). */
  stopWaitMs?: number;
  /** When an unreadable OTLP token file is read again (receiver-token.ts, receiver/otlp-receiver-host.ts); tests pass short ones. */
  tokenTimings?: Pick<OtlpReceiverHostOptions, "tokenRetryMs" | "tokenRetryEveryMs">;
  /** Paths whose content is never kept, for the SDK sessions' hook records (safety/sensitive-paths.ts; the machine's own by default). */
  isSensitive?: (absolutePath: string) => boolean;
  /** Schedules the SDK hook queue's work (sdk-hook-feed.ts); tests pass their own. */
  scheduleSdkFeed?: (work: () => void) => void;
  /** Runs `gh` for the CI watcher (ci/gh-runner.ts execGh by default); tests pass a fake. */
  runGh?: GhRunner;
};

export class ObservatoryService {
  private readonly store: AgentStoreHost;
  private readonly receiver: OtlpReceiverHost;
  private readonly intake: ObservatoryIntake;
  private started = false;
  private readonly rollups: DailyRollupScheduler;
  private readonly state: HookStateWriter;
  private readonly problems: ProblemLog;
  /** The salt of `target_key` (privacy/target-key-salt.ts); undefined until made, or when it could not be. */
  private targetKeySalt: Buffer | undefined;
  /** Reads the salt file again now and then, so a salt another process replaced (an offline delete) is followed. */
  private saltTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly liveTail: SpoolLiveTail;
  private readonly liveListeners = new Set<(event: LiveTailEvent) => void>();
  /** The sink records go to while running (the ingest), asked which sessions the agent runs itself. */
  private sink: ObservatorySink | undefined;
  /** The sessions devices watch (ObservatoryWatch and the requests beside it). */
  readonly hub: ObservatoryHub;
  /** The bottleneck rules; onFinding() hears every finding opened, raised or closed. */
  readonly bottlenecks: BottleneckRunner;
  /** Follows GitHub Actions after a session's push. */
  readonly ci: CiWatcher;

  constructor(private readonly opts: ObservatoryServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.problems = new ProblemLog(opts.log, this.now, undefined, "observatory");
    const problems = (place: string, err: unknown): void => this.problems.report(place, err);
    this.state = new HookStateWriter(opts.dataDir, () => ({ enabled: this.enabled, contentOff: contentOffOf(opts.config) }), (err) => problems("state-file", err));
    this.hub = new ObservatoryHub({
      store: () => this.store.store,
      watchSession: (sessionId) => this.watchSession(sessionId),
      unwatchSession: (sessionId) => this.unwatchSession(sessionId),
      problems,
      now: this.now,
    });
    this.onLiveEvent((event) => this.hub.provisional(event));
    this.bottlenecks = new BottleneckRunner({
      config: opts.config,
      store: () => this.store.store,
      push: (op) => this.store.writer?.push(op),
      problems,
      now: this.now,
      // Only a window known for sure: Claude Code's records cannot tell a 1M session, so an assumed 200 000 would read it too full.
      contextWindow: (model, largest) => {
        const window = contextWindowOf(model, largest);
        return window && !window.assumed ? window.tokens : undefined;
      },
    });
    this.onLiveEvent((event) => this.bottlenecks.liveEvent(event));
    this.ci = new CiWatcher({
      enabled: () => this.enabled && this.started && ciWatchEnabled(opts.config.get().observatory?.ci),
      push: (op) => this.store.writer?.push(op),
      problems,
      runGh: opts.runGh,
      log: opts.log,
      now: this.now,
    });
    // The runner only queues (it scores once the writer's flush returned), so it never throws into the hub's turn.
    const written = (ops: readonly WriteOp[]): void => {
      this.bottlenecks.written(ops);
      this.hub.written(ops);
    };
    this.store = new AgentStoreHost({ config: opts.config, dataDir: opts.dataDir, open: opts.openStore, problems, now: this.now, onWritten: written });
    this.intake = new ObservatoryIntake({
      config: opts.config,
      dataDir: opts.dataDir,
      secrets: () => this.secrets(),
      running: () => this.enabled && this.started,
      commit: () => this.store.commit(),
      problems,
      now: this.now,
      stopWaitMs: opts.stopWaitMs,
      isSensitive: opts.isSensitive,
      scheduleSdkFeed: opts.scheduleSdkFeed,
      targetKeySalt: () => this.targetKeySalt,
    });
    this.receiver = new OtlpReceiverHost({
      config: opts.config,
      dataDir: opts.dataDir,
      known: () => this.secrets(),
      onRecords: (records) => {
        for (const r of records) this.accept(r, "otlp").catch((err: unknown) => problems("ingest", err));
      },
      problems,
      now: this.now,
      ...opts.tokenTimings,
    });
    this.rollups = new DailyRollupScheduler({ prune: () => this.store.store?.prune(this.now()), problems });
    this.liveTail = new SpoolLiveTail({
      dataDir: opts.dataDir,
      secondPass: (record) => redactRecordAgain(record, this.secrets()),
      skipSession: (sessionId) => this.sink instanceof ObservatoryIngest && this.sink.isAgentSession(sessionId),
      onEvent: (event) => {
        for (const listener of this.liveListeners) {
          try {
            listener(event);
          } catch (err) {
            problems("live-tail-listener", err);
          }
        }
      },
      onTaken: (file) => this.hub.spoolFileTaken(file),
      problems,
      now: this.now,
    });
  }

  /**
   * start, stop and wipe run one at a time in the order called: a stop asked
   * (from a device) while the first start still opens the store, or a wipe
   * while a stop closes it, would otherwise open the store or the receiver twice.
   */
  private lifecycle: Promise<void> = Promise.resolve();

  private serial(step: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(step);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  /** The master switch of the agent's config (unset is on). */
  get enabled(): boolean {
    return this.opts.config.get().observatory?.enabled !== false;
  }

  /** Starts every part that can start; resolves when they did (or stayed off), never rejects. */
  start(): Promise<void> {
    return this.serial(() => this.startNow());
  }

  private async startNow(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await setAsideBrokenHookState(this.opts.dataDir, this.now()).catch((err: unknown) => this.problems.report("state-file", err));
    await this.state.write();
    if (!this.enabled) return;
    // Hidden in every output of this process from now on, in every encoded form too.
    for (const secret of this.opts.knownSecrets()) rememberSecret(secret);
    await this.makeTargetKeySalt();
    this.saltTimer = setInterval(() => void this.followTargetKeySalt(), TARGET_KEY_SALT_CHECK_MS);
    this.saltTimer.unref?.();
    await this.store.open();
    // The ingest pushes into whichever writer is current (a wipe makes a new one).
    const ingest =
      this.opts.ingest ??
      ((push) => new ObservatoryIngest({ push, home: homedir(), log: this.opts.log, storedLoads: (...key) => this.storeNow().instructionLoads(...key), onPushed: (p) => this.ci.pushed(p) }));
    const sink = this.store.writer ? this.guard("ingest-create", () => ingest((op) => this.store.writer?.push(op))) : undefined;
    await this.receiver.start();
    this.sink = sink;
    if (sink) {
      this.intake.open(sink);
      this.liveTail.start();
    }
    if (this.store.store) this.rollups.start();
    this.hub.start();
    if (this.store.writer) await this.bottlenecks.start();
  }

  /**
   * Stops in order: hub (what waits for devices dropped), receiver (its
   * queue handed on), rollups, spool reader and the records still being
   * taken (waited for stopWaitMs at most: one that never settles is left
   * behind, logged), writer (what waits written), store.
   * Never rejects; start() works again after.
   */
  stop(): Promise<void> {
    return this.serial(() => this.stopNow());
  }

  private async stopNow(): Promise<void> {
    this.hub.stop();
    this.bottlenecks.stop();
    this.ci.stop();
    clearInterval(this.saltTimer);
    this.saltTimer = undefined;
    await this.receiver.stop();
    await this.rollups.stop();
    const tail = settledWithin(this.liveTail.stop(), this.opts.stopWaitMs ?? STOP_WAIT_MS).then((done) => {
      if (!done) this.problems.report("live-tail-stop", new ObservatoryStoreError("a spool tail read still running at stop was left behind"));
    });
    await Promise.all([this.intake.close(), tail]);
    this.sink = undefined;
    this.store.close();
    this.started = false;
  }

  /**
   * Deletes everything stored and spooled, keeping the settings: the writer
   * closes (what waits goes in and is deleted with the rest), the store is
   * wiped, the spool's files deleted, then a new store and writer are made
   * whether the wipe worked or not, and the projects without content are
   * written into it again from the config. Throws the wipe's error after that.
   */
  wipe(): Promise<void> {
    return this.serial(() => this.wipeNow());
  }

  private async wipeNow(): Promise<void> {
    await this.intake.pauseSpool();
    // Its read connection is closed before the files go (Windows cannot delete an open file).
    this.bottlenecks.stop();
    // Its watches end (their unknown outcomes are queued and wiped with the rest); pushes after the wipe start new ones.
    this.ci.stop();
    let failure = await this.store.wipe(this.started && this.enabled);
    await clearSpool(this.opts.dataDir).catch((err: unknown) => (failure ??= err));
    // The keys stored under the old salt are gone with the database; new ones start from a new salt.
    this.targetKeySalt = undefined;
    await deleteTargetKeySalt(this.opts.dataDir).catch((err: unknown) => (failure ??= err));
    if (this.started && this.enabled) await this.makeTargetKeySalt();
    await this.state.write();
    if (this.store.writer) this.intake.resumeSpool();
    if (this.store.writer) await this.bottlenecks.start();
    // Devices watching a session take it again from the new store.
    this.hub.reset();
    if (failure !== undefined) throw failure;
  }

  /** Takes the salt file's current bytes when they changed (the hook process reads the file for every call). */
  private async followTargetKeySalt(): Promise<void> {
    const onDisk = await readTargetKeySalt(this.opts.dataDir);
    if (onDisk && !onDisk.equals(this.targetKeySalt ?? Buffer.alloc(0))) this.targetKeySalt = onDisk;
    else if (!onDisk) await this.makeTargetKeySalt();
  }

  /** Reads or makes the salt of `target_key`; a failure is reported and calls keep no key. */
  private async makeTargetKeySalt(): Promise<void> {
    try {
      this.targetKeySalt = await ensureTargetKeySalt(this.opts.dataDir);
    } catch (err) {
      this.problems.report("target-key-salt", err);
    }
  }

  /**
   * Switches content on or off for a project: the config first (the truth),
   * then state.json (the hooks follow at once), then the store's setting
   * (writes still queued go in before it) and, when off, the content already
   * stored is removed and the spool's settled files are taken in now (their
   * content blocked by the store) and deleted; the minute still being written
   * follows within a minute and a few seconds, blocked the same way. Throws
   * when the store cannot take it now (the config and the hooks already follow
   * the new setting; the next start copies it and clears the content).
   */
  async setProjectContent(projectKey: string, storeContent: boolean): Promise<void> {
    setContentOff(this.opts.config, projectKey, storeContent);
    await this.state.write();
    this.store.writer?.push({ kind: "contentSetting", row: { projectKey, storeContent, updatedAt: this.now() } });
    this.store.writer?.flush();
    if (storeContent) return;
    this.store.store?.clearContent(projectKey);
    await this.intake.drainSpool();
  }

  /**
   * A new OTLP token for the running receiver; the current one stays accepted
   * until the next rotation or revokePreviousToken(). `replaceUnreadable`
   * replaces a token file that cannot be read (receiver-token.ts).
   */
  rotateToken(opts: RotateOptions = {}): Promise<ReceiverTokens> {
    return this.receiver.rotate(opts);
  }

  /** Stops accepting the token before the last rotation, now. */
  revokePreviousToken(): Promise<ReceiverTokens> {
    return this.receiver.revokePrevious();
  }

  /** Where Claude Code sends its logs to the running receiver: its port and current token; undefined unless it listens. */
  otlpClient(): { port: number; token: string } | undefined {
    const port = this.receiver.running?.port;
    const [token] = this.receiver.tokenValues();
    return this.receiver.state === "listening" && port !== undefined && token !== undefined ? { port, token } : undefined;
  }

  /** One hook event of a session the agent runs through the SDK: queued, returns at once, never throws (sdk-hook-feed.ts). */
  takeHookEvent(event: string, payload: unknown, label?: string): void {
    this.intake.takeHookEvent(event, payload, label);
  }

  /** Writes the export of everything stored to `file` (store/observatory-export.ts), after what waits is written. */
  async exportToFile(file: string, overwrite: boolean): Promise<{ rows: number }> {
    this.store.writer?.flush();
    return this.storeNow().exportToFile(file, { overwrite });
  }

  /** Reads the settled spool files now instead of at the next tick (a command waiting for its data, tests). */
  async drainSpool(): Promise<void> {
    await this.intake.drainSpool();
  }

  status(): ObservatoryStatus {
    return observatoryStatus({
      enabled: this.enabled,
      store: this.store.state,
      newerDb: this.store.newerDb,
      receiverState: this.receiver.state,
      receiver: this.receiver.running,
      spool: this.intake.spoolStats,
      lastDbWriteAt: this.store.lastWriteAt,
      pendingWrites: this.store.writer?.pending ?? 0,
      lastRecordAt: this.intake.lastRecordAt,
      ingest: this.intake.ingestStats,
      sdkHooks: this.intake.sdkStats,
    });
  }

  /**
   * Someone watches `sessionId`: its records still in the spool are read
   * every half second and handed to the onLiveEvent listeners. Counted: each
   * call needs its unwatchSession. Remembered across stop and start.
   */
  watchSession(sessionId: string): void {
    this.liveTail.watch(sessionId);
  }

  /** One watcher of `sessionId` left. */
  unwatchSession(sessionId: string): void {
    this.liveTail.unwatch(sessionId);
  }

  /** Calls `listener` with every provisional event of a watched session; returns the call that removes it. */
  onLiveEvent(listener: (event: LiveTailEvent) => void): () => void {
    this.liveListeners.add(listener);
    return () => void this.liveListeners.delete(listener);
  }

  /** Takes one record from any source; resolves once its writes are queued (without an ingest it is dropped). */
  accept(record: FilteredRecord, origin: RecordOrigin): Promise<void> {
    return this.intake.accept(record, origin);
  }

  /** The secret values the agent hides: the machine's and the receiver's tokens. */
  secrets(): string[] {
    return [...this.opts.knownSecrets(), ...this.receiver.tokenValues()].filter((s) => s.length > 0);
  }

  /** The store open now; throws when there is none (a read then waits for the next time). */
  private storeNow(): ObservatoryStore {
    const store = this.store.store;
    if (!store) throw new ObservatoryStoreError("the Observatory store is not open");
    return store;
  }

  private guard<T>(place: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.problems.report(place, err);
      return undefined;
    }
  }
}

// Observatory inside the running agent: the store (opened with the agent's
// short busy timeout) and its batch writer, the OTLP receiver, the hook
// spool reader, and state.json for the hooks. Started with the agent after
// the usage ledger, stopped before the core: the receiver's queue is filtered
// and handed on, the spool reader finishes its chunk, the writer writes what
// waits, then the store closes. Nothing here ever throws into the agent or
// stops it: a part that fails stays off, the problem goes to the throttled
// log (no content), and status() tells.
//
// The projects without content live in the agent's config
// (content-settings-config.ts); state.json and the store's content_settings
// are rebuilt from it at start, on every change, and after a wipe. Records
// reach the store through the ingest (the normalizer), given as `ingest`;
// without it records are only counted and the spool is left for later.
import type { ConfigStore } from "../config.ts";
import { rememberSecret } from "../mcp/redact.ts";
import { OfficeProblems } from "../office/office-problem-log.ts";
import { AgentStoreHost } from "./agent-store-host.ts";
import { contentOffOf, setContentOff } from "./content-settings-config.ts";
import { type ObservatoryStatus, observatoryStatus } from "./observatory-status.ts";
import type { FilteredRecord, ObservatorySink, RecordOrigin } from "./privacy/filtered-record.ts";
import { redactRecordAgain } from "./privacy/redact-record-again.ts";
import { OtlpReceiverHost, type OtlpReceiverHostOptions } from "./receiver/otlp-receiver-host.ts";
import type { ReceiverTokens } from "./receiver/receiver-token.ts";
import { clearSpool } from "./spool/clear-spool.ts";
import { setAsideBrokenHookState } from "./spool/hook-state-file.ts";
import { HookStateWriter } from "./spool/hook-state-writer.ts";
import { SpoolReader } from "./spool/spool-reader.ts";
import type { ObservatoryStore } from "./store/observatory-store.ts";
import type { WriteOp } from "./store/write-ops.ts";

export type ObservatoryServiceOptions = {
  config: ConfigStore;
  /** The Observatory data folder (spool/observatory-data-dir.ts). */
  dataDir: string;
  log: (line: string) => void;
  /** The machine's secret values hidden in records, besides those mcp/redact.ts remembers (the OTLP tokens are added here). */
  knownSecrets: () => readonly string[];
  /** The ingest: takes filtered records and pushes their writes. */
  ingest?: (push: (op: WriteOp) => void) => ObservatorySink;
  /** Opens the store at `path` (tests pass a failing one). */
  openStore?: (path: string) => Promise<ObservatoryStore>;
  now?: () => number;
  /** When an unreadable OTLP token file is read again (receiver-token.ts, receiver/otlp-receiver-host.ts); tests pass short ones. */
  tokenTimings?: Pick<OtlpReceiverHostOptions, "tokenRetryMs" | "tokenRetryEveryMs">;
};

export class ObservatoryService {
  private readonly store: AgentStoreHost;
  private readonly receiver: OtlpReceiverHost;
  private sink: ObservatorySink | undefined;
  private spool: SpoolReader | undefined;
  private started = false;
  /** `accept` calls still running (stop waits for them). */
  private readonly accepting = new Set<Promise<void>>();
  private readonly state: HookStateWriter;
  private readonly problems: OfficeProblems;
  private readonly now: () => number;

  constructor(private readonly opts: ObservatoryServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.problems = new OfficeProblems((line) => opts.log(line.replace(/^office: /, "observatory: ")), this.now);
    this.state = new HookStateWriter(opts.dataDir, () => ({ enabled: this.enabled, contentOff: contentOffOf(opts.config) }), (err) => this.problems.report("state-file", err));
    this.store = new AgentStoreHost({ config: opts.config, dataDir: opts.dataDir, open: opts.openStore, problems: (place, err) => this.problems.report(place, err), now: this.now });
    this.receiver = new OtlpReceiverHost({
      config: opts.config,
      dataDir: opts.dataDir,
      known: () => this.secrets(),
      onRecords: (records) => {
        for (const r of records) this.accept(r, "otlp").catch((err: unknown) => this.problems.report("ingest", err));
      },
      problems: (place, err) => this.problems.report(place, err),
      now: this.now,
      ...opts.tokenTimings,
    });
  }

  /** The master switch of the agent's config (unset is on). */
  get enabled(): boolean {
    return this.opts.config.get().observatory?.enabled !== false;
  }

  /** Starts every part that can start; resolves when they did (or stayed off), never rejects. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await setAsideBrokenHookState(this.opts.dataDir, this.now()).catch((err: unknown) => this.problems.report("state-file", err));
    await this.state.write();
    if (!this.enabled) return;
    // Hidden in every output of this process from now on, in every encoded form too.
    for (const secret of this.opts.knownSecrets()) rememberSecret(secret);
    await this.store.open();
    // The ingest pushes into whichever writer is current (a wipe makes a new one).
    if (this.store.writer && this.opts.ingest) this.sink = this.guard("ingest-create", () => this.opts.ingest?.((op) => this.store.writer?.push(op)));
    await this.receiver.start();
    if (this.sink) this.startSpool();
  }

  /** Stops in order: receiver (its queue handed on), spool reader, writer (what waits written), store. Never rejects; start() works again after. */
  async stop(): Promise<void> {
    await this.receiver.stop();
    await this.spool?.stop();
    // Writes an ingest still pushes go in before the writer closes.
    await Promise.allSettled([...this.accepting]);
    this.store.close();
    this.spool = undefined;
    this.sink = undefined;
    this.started = false;
  }

  /**
   * Deletes everything stored and spooled, keeping the settings: the writer
   * closes (what waits goes in and is deleted with the rest), the store is
   * wiped, the spool's files deleted, then a new store and writer are made
   * whether the wipe worked or not, and the projects without content are
   * written into it again from the config. Throws the wipe's error after that.
   */
  async wipe(): Promise<void> {
    await this.spool?.stop();
    this.spool = undefined;
    let failure = await this.store.wipe(this.started && this.enabled);
    await clearSpool(this.opts.dataDir).catch((err: unknown) => (failure ??= err));
    await this.state.write();
    if (this.sink && this.store.writer) this.startSpool();
    if (failure !== undefined) throw failure;
  }

  /**
   * Switches content on or off for a project: the config first (the truth),
   * then state.json (the hooks follow at once), then the store's setting
   * (writes still queued go in before it) and, when off, the content already
   * stored is removed. Throws when the store cannot take it now (the config
   * and the hooks already follow the new setting; the next start copies it).
   */
  async setProjectContent(projectKey: string, storeContent: boolean): Promise<void> {
    setContentOff(this.opts.config, projectKey, storeContent);
    await this.state.write();
    this.store.writer?.push({ kind: "contentSetting", row: { projectKey, storeContent, updatedAt: this.now() } });
    this.store.writer?.flush();
    if (!storeContent) this.store.store?.clearContent(projectKey);
  }

  /** A new OTLP token for the running receiver; the current one stays accepted until the next rotation or revokePreviousToken(). */
  rotateToken(): Promise<ReceiverTokens> {
    return this.receiver.rotate();
  }

  /** Stops accepting the token before the last rotation, now. */
  revokePreviousToken(): Promise<ReceiverTokens> {
    return this.receiver.revokePrevious();
  }

  /** Reads the settled spool files now instead of at the next tick (a command waiting for its data, tests). */
  async drainSpool(): Promise<void> {
    await this.spool?.drainOnce();
  }

  status(): ObservatoryStatus {
    return observatoryStatus({
      enabled: this.enabled,
      store: this.store.state,
      receiverState: this.receiver.state,
      receiver: this.receiver.running,
      spool: this.spool?.stats,
      lastDbWriteAt: this.store.lastWriteAt,
      pendingWrites: this.store.writer?.pending ?? 0,
    });
  }

  /** Takes one record from any source; resolves once its writes are queued (without an ingest it is dropped). */
  async accept(record: FilteredRecord, origin: RecordOrigin): Promise<void> {
    const sink = this.sink;
    if (!sink) return;
    const running = sink.accept(record, origin);
    this.accepting.add(running);
    try {
      await running;
    } finally {
      this.accepting.delete(running);
    }
  }

  /** The secret values the agent hides: the machine's and the receiver's tokens. */
  secrets(): string[] {
    return [...this.opts.knownSecrets(), ...this.receiver.tokenValues()].filter((s) => s.length > 0);
  }

  private startSpool(): void {
    this.spool = new SpoolReader({
      dataDir: this.opts.dataDir,
      accept: (record) => this.accept(redactRecordAgain(record, this.secrets()), "spool"),
      commit: async () => this.store.commit(),
      problems: (place, err) => this.problems.report(place, err),
      now: this.now,
    });
    this.spool.start();
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

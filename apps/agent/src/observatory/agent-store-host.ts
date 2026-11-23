// The agent's Observatory store and its batch writer as one part of the
// service: the database in the data folder, opened with the agent's short
// busy timeout (the store's default, AGENT_BUSY_TIMEOUT_MS), and a writer
// whose every batch written is noted for status. Opening copies the
// projects without content from the config into the store (a new or wiped
// store has none) and removes the content they still hold. A wipe follows the order the writer asks for: writer
// closed, store wiped, then a new store and writer whether the wipe worked or
// not.
import { join } from "node:path";
import type { ConfigStore } from "../config.ts";
import { contentOffOf, contentOffWrites } from "./content-settings-config.ts";
import { ObservatoryBatchWriter } from "./store/batch-writer.ts";
import { OBSERVATORY_DB_FILE } from "./store/observatory-db-path.ts";
import { ObservatoryStore } from "./store/observatory-store.ts";
import { ObservatoryStoreError } from "./store/store-errors.ts";
import type { WriteOp } from "./store/write-ops.ts";

export type AgentStoreHostOptions = {
  config: ConfigStore;
  dataDir: string;
  /** Opens the store at `path`; ObservatoryStore.open by default. */
  open?: ((path: string) => Promise<ObservatoryStore>) | undefined;
  problems: (place: string, err: unknown) => void;
  now: () => number;
};

/** The schema versions of a database a newer agent wrote, and of this agent. */
export type NewerDb = { databaseVersion: number; agentVersion: number };

export class AgentStoreHost {
  store: ObservatoryStore | undefined;
  writer: ObservatoryBatchWriter | undefined;
  state: "open" | "failed" | "off" = "off";
  /** When a batch last went into the store (Unix ms). */
  lastWriteAt: number | undefined;
  /** Set while the open database was written by a newer agent that lets this one use it (store/migrate.ts). */
  newerDb: NewerDb | undefined;

  constructor(private readonly opts: AgentStoreHostOptions) {}

  /** Opens the store and its writer; on failure the state says so (reported, never thrown). */
  async open(): Promise<void> {
    try {
      const store = await (this.opts.open ?? ((p: string) => ObservatoryStore.open({ path: p })))(join(this.opts.dataDir, OBSERVATORY_DB_FILE));
      const sink = {
        write: (ops: readonly WriteOp[]): void => {
          store.write(ops);
          this.lastWriteAt = this.opts.now();
        },
      };
      const writer = new ObservatoryBatchWriter(sink, { onError: (err) => this.opts.problems("store-write", err) });
      this.store = store;
      this.writer = writer;
      this.state = "open";
      this.newerDb = store.newerThanAgent ? { databaseVersion: store.schemaVersion, agentVersion: store.agentSchemaVersion } : undefined;
      const off = contentOffOf(this.opts.config);
      for (const op of contentOffWrites(off, this.opts.now())) writer.push(op);
      writer.flush();
      // A project switched off while the store was closed (Observatory off, the agent stopped, the store failing to open):
      // its content stored before is removed now. Once per project at each open; nothing left to remove the next time.
      this.clearContentOf(off);
    } catch (err) {
      this.store = undefined;
      this.writer = undefined;
      this.state = "failed";
      this.newerDb = undefined;
      this.opts.problems("store-open", err);
    }
  }

  /** Removes the content stored for `projectKeys`; a failure is reported (the store stays open, the next open tries again). */
  private clearContentOf(projectKeys: readonly string[]): void {
    for (const projectKey of projectKeys) {
      try {
        this.store?.clearContent(projectKey);
      } catch (err) {
        this.opts.problems("content-clear", err);
      }
    }
  }

  /** Writes what waits, closes; never throws. */
  close(): void {
    try {
      this.writer?.close();
      this.store?.close();
    } catch (err) {
      this.opts.problems("store-close", err);
    }
    this.store = undefined;
    this.writer = undefined;
    this.state = "off";
    this.newerDb = undefined;
  }

  /** Wipes the database and opens a new one (when `reopen`); resolves with the wipe's error, if any, instead of throwing it. */
  async wipe(reopen: boolean): Promise<unknown> {
    this.writer?.close();
    let failure: unknown;
    try {
      await this.store?.wipe();
    } catch (err) {
      failure = err;
    }
    this.close();
    if (reopen) await this.open();
    return failure;
  }

  /**
   * Writes what the writer holds now; throws when it is not all in the store
   * (the writer stopped, or the database cannot take writes now and they wait
   * for a later try). Writes the store refused for their own data were dropped
   * and reported by the writer: they count as done.
   */
  commit(): void {
    const writer = this.writer;
    if (!writer || writer.isStopped) throw new ObservatoryStoreError("the Observatory store does not take writes");
    writer.flush();
    if (writer.isStopped || writer.pending > 0) throw new ObservatoryStoreError("the Observatory store could not take the writes now");
  }
}

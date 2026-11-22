// What `tunelo observatory status` shows of the running agent's Observatory:
// counts and states only, never content or a token.
import type { IngestStats } from "./ingest/observatory-ingest.ts";
import type { OtlpReceiver } from "./receiver/otlp-receiver.ts";
import { type ReceiverStats, emptyReceiverStats } from "./receiver/receiver-stats.ts";
import type { ReceiverStatusState } from "./receiver/start-otlp-receiver.ts";
import type { SdkFeedStats } from "./sdk-hook-feed.ts";
import type { SpoolStats } from "./spool/spool-reader.ts";

export type ObservatoryStatus = {
  enabled: boolean;
  /** off: not opened (Observatory off); failed: could not be opened (see the agent's log). */
  store: "open" | "failed" | "off";
  receiver: {
    state: ReceiverStatusState;
    /** The machine's port, when one is set. */
    port: number | undefined;
    queueDepth: number;
    stats: ReceiverStats;
  };
  /** Undefined while the spool is not read (Observatory off, store failed, no ingest yet). */
  spool: SpoolStats | undefined;
  /** When a batch last went into the store (Unix ms). */
  lastDbWriteAt: number | undefined;
  /** Writes waiting for the next batch. */
  pendingWrites: number;
  /** When the last record of any source was taken (Unix ms). */
  lastRecordAt: number | undefined;
  /** The ingest's counts (unknown events and fields, missing keys…); undefined with another ingest or none running. */
  ingest: IngestStats | undefined;
  /** The hook callbacks of the SDK sessions the agent runs. */
  sdkHooks: SdkFeedStats;
};

export type StatusParts = {
  enabled: boolean;
  store: ObservatoryStatus["store"];
  receiverState: ReceiverStatusState;
  receiver: OtlpReceiver | undefined;
  spool: SpoolStats | undefined;
  lastDbWriteAt: number | undefined;
  pendingWrites: number;
  lastRecordAt: number | undefined;
  ingest: IngestStats | undefined;
  sdkHooks: SdkFeedStats;
};

/** A snapshot (copies, so later counting does not change it). */
export function observatoryStatus(p: StatusParts): ObservatoryStatus {
  return {
    enabled: p.enabled,
    store: p.store,
    receiver: {
      state: p.receiverState,
      port: p.receiver?.port,
      queueDepth: p.receiver?.queueDepth ?? 0,
      stats: { ...(p.receiver?.stats ?? emptyReceiverStats()) },
    },
    spool: p.spool ? { ...p.spool } : undefined,
    lastDbWriteAt: p.lastDbWriteAt,
    pendingWrites: p.pendingWrites,
    lastRecordAt: p.lastRecordAt,
    ingest: p.ingest ? { ...p.ingest } : undefined,
    sdkHooks: { ...p.sdkHooks },
  };
}

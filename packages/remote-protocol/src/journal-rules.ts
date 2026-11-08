// Rules both sides follow for the per-thread journal: where a device resumes
// from its cursor, when it must reset, and how repeated items merge.
import { ResetReason } from "@achoo254/chat-proto/remote/remote";

/** What the machine still holds for a thread. */
export type JournalBounds = {
  /** Bumped on every agent restart. */
  epoch: bigint;
  /** Oldest seq still stored (older items were compacted away). */
  firstSeq: bigint;
  /** Newest seq; 0 when empty. */
  lastSeq: bigint;
};

export type DeviceCursor = { epoch: bigint; seq: bigint };

export type Resume = { kind: "send"; fromSeq: bigint } | { kind: "reset"; reason: ResetReason };

/** Where to continue for a device that last applied `cursor`. */
export function resumeFrom(bounds: JournalBounds, cursor: DeviceCursor | undefined): Resume {
  if (!cursor || (cursor.epoch === 0n && cursor.seq === 0n)) return { kind: "send", fromSeq: bounds.firstSeq };
  if (cursor.epoch !== bounds.epoch) return { kind: "reset", reason: ResetReason.EPOCH_CHANGED };
  if (cursor.seq > bounds.lastSeq) return { kind: "reset", reason: ResetReason.CURSOR_AHEAD };
  if (cursor.seq + 1n < bounds.firstSeq) return { kind: "reset", reason: ResetReason.CURSOR_COMPACTED };
  return { kind: "send", fromSeq: cursor.seq + 1n };
}

/** Seqs must arrive without holes; a hole means the device must reset. */
export function isContiguous(lastApplied: bigint, seqs: readonly bigint[]): boolean {
  let prev = lastApplied;
  for (const s of seqs) {
    if (s <= prev) continue; // already applied: an update of an older item
    if (s !== prev + 1n) return false;
    prev = s;
  }
  return true;
}

type Revisioned = { id: string; revision: number };

/** Keep the newer revision of the same item. */
export function newer<T extends Revisioned>(current: T | undefined, incoming: T): T {
  if (!current || incoming.revision >= current.revision) return incoming;
  return current;
}

/** An approval/question answer counts only against the revision the user saw. */
export function answerIsCurrent(item: Revisioned & { pending: boolean }, expectedRevision: number): boolean {
  return item.pending && item.revision === expectedRevision;
}

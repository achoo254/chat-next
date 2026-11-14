// Rules both sides follow for the per-thread journal: where a device resumes
// from its cursor, when it must reset, and how repeated items merge.
import { ResetReason, type Item } from "@achoo254/chat-proto/remote/remote";

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

/**
 * A conversation break: the AI's CLI in a thread's terminal went on in
 * another conversation (Claude: /clear, /resume). Items written after it (by
 * seq) belong to that conversation; the ones before it stay in the journal.
 * It is a status item with no text under an id of this prefix, not an item
 * type of its own: every agent and device already released reads a status
 * item (an agent's journal loader that met an unknown type would cut the
 * journal there) and draws one with no text as nothing.
 */
export const CONVERSATION_BREAK_ID_PREFIX = "conversation-break:";

/** The break item opening segment `segment` of a thread, in conversation `sessionId`. */
export function conversationBreakItem(segment: number, sessionId: string): { id: string; body: { case: "status"; value: { text: string } } } {
  return { id: `${CONVERSATION_BREAK_ID_PREFIX}${segment}:${sessionId}`, body: { case: "status", value: { text: "" } } };
}

/** Whether the item is a conversation break (conversationBreakItem). */
export function isConversationBreak(item: Pick<Item, "id" | "body">): boolean {
  return item.id.startsWith(CONVERSATION_BREAK_ID_PREFIX) && item.body.case === "status" && item.body.value.text === "";
}

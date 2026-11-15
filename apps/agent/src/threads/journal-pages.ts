// Pages of a thread's journal from its end, so a device opening a long
// session gets its newest items first and the older ones only as the user
// scrolls up (ThreadSubscribe.tail, ThreadEarlier).
//
// Paging order is the order a device shows items in: the conversation the
// session is in now (items written after its latest conversation break)
// after every earlier one, then by creation time, then by id. Ids never
// change, so a page boundary stays put while items get new revisions; an item
// that moves across one (a revision written after the break) still reaches a
// following device as a live ThreadItems.
import { type Item, PromptState } from "@achoo254/chat-proto/remote/remote";
import { isConversationBreak } from "@achoo254/chat-remote-protocol";

/** Items per page when the device does not say. */
export const DEFAULT_PAGE = 200;
/** The most items one page may carry, whatever the device asks. */
export const MAX_PAGE = 500;

export type Page = {
  /** Items to send, in paging order. */
  items: Item[];
  /** Mark of the first paged item, for the next ThreadEarlier; "" when nothing is earlier. */
  earlier: string;
};

type Key = { current: number; at: bigint; id: string };

function compareKeys(a: Key, b: Key): number {
  if (a.current !== b.current) return a.current - b.current;
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The seq of the latest conversation break; 0n when there is none (seqs start at 1). */
function latestBreakSeq(items: readonly Item[]): bigint {
  let latest = 0n;
  for (const item of items) if (isConversationBreak(item) && item.seq > latest) latest = item.seq;
  return latest;
}

/** Items in paging order, split at the break with seq `breakSeq` (0n: none). */
function keyed(items: readonly Item[], breakSeq: bigint): { item: Item; key: Key }[] {
  return items
    .map((item) => ({ item, key: { current: breakSeq > 0n && item.seq > breakSeq ? 1 : 0, at: item.at, id: item.id } }))
    .sort((a, b) => compareKeys(a.key, b.key));
}

/**
 * The mark is opaque to devices: "<breakSeq>:<current>:<at>:<id>" (ids may
 * hold colons; they come last). It keeps the break it was made against, so a
 * break written later (a /clear) does not move the pages already sent.
 */
type Mark = { breakSeq: bigint; key: Key };

function markOf(breakSeq: bigint, key: Key): string {
  return `${breakSeq}:${key.current}:${key.at}:${key.id}`;
}

function parseMark(mark: string): Mark | undefined {
  const parts: string[] = [];
  let rest = mark;
  for (let i = 0; i < 3; i++) {
    const at = rest.indexOf(":");
    if (at < 0) return undefined;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  const [breakSeq = "", current = "", at = ""] = parts;
  if (!/^\d+$/.test(breakSeq) || (current !== "0" && current !== "1") || !/^\d+$/.test(at)) return undefined;
  return { breakSeq: BigInt(breakSeq), key: { current: Number(current), at: BigInt(at), id: rest } };
}

/** The page size a device asked for, within bounds. */
export function pageSize(asked: number): number {
  return asked <= 0 ? DEFAULT_PAGE : Math.min(asked, MAX_PAGE);
}

function isPendingPrompt(item: Item): boolean {
  const b = item.body;
  return (b.case === "approval" || b.case === "question") && b.value.state === PromptState.PENDING;
}

/**
 * The last `tail` items, plus what a device needs before it pages: the latest
 * conversation break (so it tells the current conversation from earlier ones
 * at once) and every approval or question still waiting for the user.
 */
export function tailPage(items: readonly Item[], tail: number): Page {
  const breakSeq = latestBreakSeq(items);
  const sorted = keyed(items, breakSeq);
  if (sorted.length <= tail) return { items: sorted.map((k) => k.item), earlier: "" };
  const start = sorted.length - tail;
  const kept = sorted.slice(start).map((k) => k.item);
  const extra = sorted.slice(0, start).filter((k) => isConversationBreak(k.item) || isPendingPrompt(k.item));
  // The break that matters is the latest one only; older breaks wait for their page.
  const needed = extra.filter((k) => !isConversationBreak(k.item) || k.item.seq === breakSeq).map((k) => k.item);
  const first = sorted[start];
  return { items: [...needed, ...kept], earlier: first === undefined ? "" : markOf(breakSeq, first.key) };
}

/** Up to `limit` items that come before `mark`; undefined when the mark is not one this machine made. */
export function earlierPage(items: readonly Item[], mark: string, limit: number): Page | undefined {
  const before = parseMark(mark);
  if (before === undefined) return undefined;
  const older = keyed(items, before.breakSeq).filter((k) => compareKeys(k.key, before.key) < 0);
  const start = Math.max(0, older.length - limit);
  const first = older[start];
  return { items: older.slice(start).map((k) => k.item), earlier: start > 0 && first !== undefined ? markOf(before.breakSeq, first.key) : "" };
}

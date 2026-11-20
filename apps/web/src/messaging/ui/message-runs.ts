// Pure helpers that decide which bubbles read as one run (Telegram grouping). Kept apart from
// message-list.tsx so a screen that only needs them does not load the whole list.
import { sameDay } from "../data/format.ts";
import type { WindowItem } from "../data/store.ts";

export function itemDate(item: WindowItem | undefined): number {
	if (item === undefined) return 0;
	return item.kind === "message" ? item.message.date : item.pending.date;
}

/** Messages of one sender this close together (seconds) read as one run of bubbles. */
export const RUN_GAP_S = 5 * 60;

/** Who a bubble speaks as, for runs: "" for service lines, which never join a run. */
function runSender(item: WindowItem | undefined, selfId: number): string {
	if (item === undefined) return "";
	if (item.kind === "pending") return `u${selfId}`;
	if (item.message.action !== null) return "";
	return `u${item.message.fromId}:${item.message.integrationLabel}`;
}

/**
 * Whether `next` continues the run of `previous` (Telegram grouping): the
 * same sender, the same day and at most RUN_GAP_S apart. Runs draw tightly,
 * with the name on the first bubble and the avatar by the last.
 */
export function joinsRun(previous: WindowItem | undefined, next: WindowItem | undefined, selfId: number): boolean {
	const sender = runSender(previous, selfId);
	if (sender === "" || sender !== runSender(next, selfId)) return false;
	const a = itemDate(previous);
	const b = itemDate(next);
	return a !== 0 && b !== 0 && sameDay(a, b) && Math.abs(b - a) <= RUN_GAP_S;
}

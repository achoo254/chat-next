// Where a message written on a person's merged screen goes (ADR 0025): the
// person's private chats are the targets, each toggled on the target row.
// At least one stays selected. The first time, only the chat of the newest
// message is selected; after that the person's own choice is kept
// (send-prefs.ts). A chat that cannot take a message stays selectable: it
// is shown dimmed with its reason, and a send there reports why instead of
// holding the others back.

/**
 * Why a chat may not take a message. The first three mean it takes nothing,
 * so a send there is not tried; the last two still queue the message, which
 * waits for the account of the other app.
 */
export type TargetReason = "readOnly" | "closed" | "noSend" | "needsLogin" | "stopped";

export interface SendTarget {
	readonly chatId: number;
	/** "telegram", …; "" for a Chat account. */
	readonly app: string;
	readonly reason: TargetReason | null;
}

/** The chat takes nothing: a read-only copy, a chat that is closed, an app that does not send. */
export function blocks(reason: TargetReason | null | undefined): boolean {
	return reason === "readOnly" || reason === "closed" || reason === "noSend";
}

/** The chat whose newest message is the newest of all, among the targets without a reason if any has a date; 0 when none has. */
export function newestChat(targets: readonly SendTarget[], dates: ReadonlyMap<number, number>): number {
	const newestOf = (pool: readonly SendTarget[]): number => {
		let best = 0;
		let bestDate = 0;
		for (const target of pool) {
			const date = dates.get(target.chatId) ?? 0;
			if (date > bestDate) {
				best = target.chatId;
				bestDate = date;
			}
		}
		return best;
	};
	return newestOf(targets.filter((target) => target.reason === null)) || newestOf(targets);
}

/** What the targets are selected from: the remembered choice still among the chats, else the chat of the newest message, else the first chat that can send. */
export function initialSelection(targets: readonly SendTarget[], remembered: readonly number[] | null, newest: number): number[] {
	const kept = targets.filter((target) => remembered?.includes(target.chatId) === true).map((target) => target.chatId);
	if (kept.length > 0) return kept;
	if (targets.some((target) => target.chatId === newest)) return [newest];
	const first = targets.find((target) => target.reason === null) ?? targets[0];
	return first === undefined ? [] : [first.chatId];
}

/** The selection with `chatId` switched, in row order; the last selected chat stays selected. */
export function toggleTarget(targets: readonly SendTarget[], selected: readonly number[], chatId: number): number[] {
	const on = selected.includes(chatId);
	if (on && selected.length === 1) return [...selected];
	return targets.filter((target) => (target.chatId === chatId ? !on : selected.includes(target.chatId))).map((target) => target.chatId);
}

/** The chat the composer belongs to: the first selected one that takes messages, else the first selected; 0 for none. */
export function primaryOf(targets: readonly SendTarget[], selected: readonly number[]): number {
	const chosen = targets.filter((target) => selected.includes(target.chatId));
	return (chosen.find((target) => !blocks(target.reason)) ?? chosen[0])?.chatId ?? 0;
}

/** Whether the person has the target row: two chats or more that can send. */
export function hasRow(targets: readonly SendTarget[]): boolean {
	return targets.filter((target) => target.reason === null).length >= 2;
}

/**
 * The chats a new message goes to. With the row, the selection; without it,
 * the one chat that can send, else the selected one (its reason is told when
 * a send is tried).
 */
export function effectiveTargets(targets: readonly SendTarget[], selected: readonly number[]): number[] {
	if (hasRow(targets)) return targets.filter((target) => selected.includes(target.chatId)).map((target) => target.chatId);
	const only = targets.find((target) => target.reason === null) ?? targets.find((target) => selected.includes(target.chatId)) ?? targets[0];
	return only === undefined ? [] : [only.chatId];
}

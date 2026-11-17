// The batch of chats to sync that an old sign-in interrupted. It is kept in
// this tab's sessionStorage across the sign-in round trip (the page is left and
// opened again), so the batch carries on by itself once the user is back. Only
// conversation ids and the history choice are kept: nothing private.

const KEY = "chat.bridge.pending";
/** How long a stopped batch may wait for the sign-in: past this the user has to ask again. */
const PENDING_MS = 15 * 60 * 1000;

export interface PendingBatch {
	readonly account: number;
	/** Conversation ids not started yet. */
	readonly ids: readonly string[];
	readonly window: number;
}

interface Stored extends PendingBatch {
	readonly at: number;
}

/** Remembers the batch; an empty one forgets it. Storage that is blocked or full is ignored: the user then starts again by hand. */
export function savePending(batch: PendingBatch): void {
	try {
		if (batch.ids.length === 0) window.sessionStorage.removeItem(KEY);
		else window.sessionStorage.setItem(KEY, JSON.stringify({ ...batch, at: Date.now() } satisfies Stored));
	} catch {
		// Nothing to do: see above.
	}
}

export function clearPending(): void {
	savePending({ account: 0, ids: [], window: 0 });
}

/** The waiting batch of `account`, removed from storage so it runs once; null when none, stale or of another account. */
export function takePending(account: number): PendingBatch | null {
	try {
		const raw = window.sessionStorage.getItem(KEY);
		if (raw === null) return null;
		const stored = JSON.parse(raw) as Partial<Stored>;
		if (stored.account !== account || !Array.isArray(stored.ids) || typeof stored.window !== "number" || typeof stored.at !== "number") return null;
		if (Date.now() - stored.at > PENDING_MS) {
			window.sessionStorage.removeItem(KEY);
			return null;
		}
		window.sessionStorage.removeItem(KEY);
		return { account, ids: stored.ids.filter((id): id is string => typeof id === "string"), window: stored.window };
	} catch {
		return null;
	}
}

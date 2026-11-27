// One tab owns the local database (ADR 0007): opfs-sahpool allows a single
// connection, and a single sync engine keeps pts bookkeeping consistent.
// Ownership is an exclusive Web Lock held for the lifetime of the owning
// worker; the browser releases it when that tab closes or crashes, and the
// next tab waiting in line becomes the leader.

/** The part of navigator.locks the election needs. */
export interface LockManagerLike {
	request(name: string, options: { mode: "exclusive"; signal?: AbortSignal; steal?: boolean }, callback: () => Promise<void>): Promise<void>;
	/** What is held and queued (absent where the context cannot tell: then nothing is ever taken over). */
	query?(): Promise<{ held?: readonly { name?: string }[]; pending?: readonly { name?: string }[] }>;
}

/** How often a tab waiting in line looks whether the line is stuck. */
const STUCK_CHECK_MS = 2_000;
/** Looks in a row that found the lock free with tabs still waiting: then the line is stuck. */
const STUCK_LOOKS = 2;

/**
 * Grants every request at once: for a context without Web Locks (a WebView
 * of the native app, where the page is the only one), where nobody else can
 * want the database.
 */
export const soloLocks: LockManagerLike = {
	request: (_name, _options, callback) => callback(),
};

/**
 * Chrome can leave the line stuck: the lock is free, yet the request at its
 * head is never granted (a background tab Chrome froze, or the request of a
 * page that was reloaded), and every tab behind it waits forever. A tab in
 * line looks every STUCK_CHECK_MS; once it finds the lock held by nobody
 * STUCK_LOOKS times in a row, it leaves the line and takes the lock (steal:
 * nobody held it, so no leader is pushed out).
 */
export class LeaderLock {
	private releaseHeld: (() => void) | null = null;
	private released = false;

	constructor(
		private readonly locks: LockManagerLike,
		private readonly name: string,
		private readonly checkMs = STUCK_CHECK_MS,
	) {}

	/**
	 * Queues for the lock and runs `onLeader` once it is granted. The lock is
	 * then held until release() or until this context dies. Resolves when the
	 * lock is let go.
	 */
	acquire(onLeader: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
		// This turn as leader, shared by the queued request and a takeover, whichever the lock went to.
		let leading: Promise<void> | null = null;
		const lead = (): Promise<void> => {
			leading ??= this.lead(onLeader, onError);
			return leading;
		};
		const queued = new AbortController();
		let takeover: Promise<void> | null = null;
		const stopWatching = this.watchLine(() => {
			queued.abort();
			takeover = this.locks.request(this.name, { mode: "exclusive", steal: true }, lead);
		});
		return this.locks
			.request(this.name, { mode: "exclusive", signal: queued.signal }, () => {
				stopWatching();
				return lead();
			})
			.catch((err: unknown) => {
				// Left the line to take the lock over: this turn goes on there.
				if (takeover !== null) return takeover;
				throw err;
			});
	}

	private async lead(onLeader: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
		if (this.released) return;
		const held = new Promise<void>((resolve) => {
			this.releaseHeld = resolve;
		});
		try {
			await onLeader();
		} catch (err) {
			// Keep the lock: another tab could not do better, and letting go
			// would make every tab fail in turn.
			onError(err);
		}
		await held;
	}

	/** Calls `stuck` once the line has been stuck long enough; returns what stops the watch (the lock came). */
	private watchLine(stuck: () => void): () => void {
		const query = this.locks.query?.bind(this.locks);
		if (query === undefined) return () => undefined;
		let stopped = false;
		let looks = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const look = async () => {
			const state = await query().catch(() => null);
			if (stopped || this.released) return;
			const held = state?.held?.some((lock) => lock.name === this.name) ?? true;
			const waiting = state?.pending?.some((lock) => lock.name === this.name) ?? false;
			looks = !held && waiting ? looks + 1 : 0;
			if (looks >= STUCK_LOOKS) {
				stopped = true;
				stuck();
				return;
			}
			timer = setTimeout(() => void look(), this.checkMs);
		};
		timer = setTimeout(() => void look(), this.checkMs);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}

	/**
	 * Lets the next tab in line lead, and queues again behind it: this tab stays open
	 * and may lead again once the tabs before it are gone.
	 */
	requeue(onLeader: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
		this.releaseHeld?.();
		this.releaseHeld = null;
		return this.acquire(onLeader, onError);
	}

	/** Lets the next tab take over (this tab is closing or signing out). */
	release(): void {
		this.released = true;
		this.releaseHeld?.();
		this.releaseHeld = null;
	}
}

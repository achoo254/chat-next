// One tab owns the local database (ADR 0007): opfs-sahpool allows a single
// connection, and a single sync engine keeps pts bookkeeping consistent.
// Ownership is an exclusive Web Lock held for the lifetime of the owning
// worker; the browser releases it when that tab closes or crashes, and the
// next tab waiting in line becomes the leader.

/** The part of navigator.locks the election needs. */
export interface LockManagerLike {
	request(name: string, options: { mode: "exclusive" }, callback: () => Promise<void>): Promise<void>;
}

export class LeaderLock {
	private releaseHeld: (() => void) | null = null;
	private released = false;

	constructor(
		private readonly locks: LockManagerLike,
		private readonly name: string,
	) {}

	/**
	 * Queues for the lock and runs `onLeader` once it is granted. The lock is
	 * then held until release() or until this context dies. Resolves when the
	 * lock is let go.
	 */
	acquire(onLeader: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
		return this.locks.request(this.name, { mode: "exclusive" }, async () => {
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
		});
	}

	/** Lets the next tab take over (this tab is closing or signing out). */
	release(): void {
		this.released = true;
		this.releaseHeld?.();
		this.releaseHeld = null;
	}
}

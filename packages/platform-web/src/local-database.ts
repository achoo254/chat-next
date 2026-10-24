// Which local database and leader lock the worker uses. The web keeps its
// one path: SQLite on OPFS (opfs-sahpool), whose failure fails the start
// (the tab shows the error and retries), and Web Locks for the election. The
// native app's WebView may lack both (OPFS sync access handles before
// iOS 17, Web Locks outside a secure context), and there the app must still
// open: an in-memory database for the run, and no election for its single
// page.
import type { SqlDriverFactory } from "@achoo254/chat-platform";
import { soloLocks, type LockManagerLike } from "./leader.ts";

export interface LocalDatabaseOptions {
	/** The native app's worker (WorkerConfig.native set). */
	readonly native: boolean;
	/** Whether the worker has OPFS with sync access handles. */
	readonly opfsAvailable: boolean;
	/** Opens the OPFS pool, with its retries. */
	readonly openPool: () => Promise<SqlDriverFactory>;
	/** Opens in-memory databases of the same SQLite build. */
	readonly openMemory: () => Promise<SqlDriverFactory>;
	/** Told why the native app fell back to memory. */
	readonly report: (err: unknown) => void;
}

/** The database factory: OPFS, or for the native app memory when OPFS is missing or refuses. */
export async function openLocalDatabase(options: LocalDatabaseOptions): Promise<SqlDriverFactory> {
	if (!options.native) return options.openPool();
	if (!options.opfsAvailable) {
		options.report(new Error("OPFS is not available; using an in-memory database"));
		return options.openMemory();
	}
	try {
		return await options.openPool();
	} catch (err) {
		options.report(err);
		return options.openMemory();
	}
}

/** The native app's lock manager: Web Locks when the WebView has them, otherwise none for its single page. */
export function nativeLocks(locks: LockManagerLike | undefined): LockManagerLike {
	return locks ?? soloLocks;
}

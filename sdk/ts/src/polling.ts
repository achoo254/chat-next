import { ApiError, NetworkError } from "./client.ts";
import type { Client } from "./client.ts";
import type { Update } from "./generated.ts";
import { sleep } from "./sleep.ts";

/** Seconds the server holds a long poll open. */
export const POLL_TIMEOUT_S = 50;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Options of `poll`. */
export interface PollOptions {
	/** Stops the loop; `poll` then resolves. */
	readonly signal?: AbortSignal;
	/** Kinds to receive, stored by the server like the webhook's `allowed_updates`. */
	readonly allowedUpdates?: readonly string[];
	/** Receives handler errors (default: `console.error`). */
	readonly onError?: (error: unknown, update: Update) => void;
	/** Receives errors the loop recovers from by waiting (default: `console.error`). */
	readonly onRetry?: (error: unknown, delayMs: number) => void;
}

/**
 * Long polls `getUpdates` and hands every update to `handler`, one at a
 * time and in order. An update is acknowledged (next `offset`) after its
 * handler finished, also when the handler threw (the error goes to
 * `onError`), so one bad update never blocks the queue.
 *
 * Connection failures, 5xx and `429` answers are retried after a pause
 * (`retry_after`, else 1 s doubling up to 30 s). Resolves when `signal`
 * aborts; rejects with the ApiError on `409 conflict` (another poll or a
 * webhook) and on any other error answer.
 */
export async function poll(
	client: Client,
	handler: (update: Update) => unknown,
	options: PollOptions = {},
): Promise<void> {
	const { signal } = options;
	// A function, not a narrowed property: the signal changes during awaits.
	const stopped = (): boolean => signal?.aborted === true;
	const onError = options.onError ?? ((error: unknown) => console.error("update handler failed:", error));
	const onRetry =
		options.onRetry ??
		((error: unknown, delayMs: number) => console.error(`getUpdates failed, retrying in ${delayMs} ms:`, describe(error)));
	let offset: number | undefined;
	let acknowledged: number | undefined;
	let backoffMs = BACKOFF_START_MS;
	// The first request sends allowed_updates; the server stores it.
	let allowed = options.allowedUpdates?.join(",");

	while (!stopped()) {
		let updates: Update[];
		try {
			updates = await client.request<Update[]>("GET", "/updates", {
				query: {
					timeout: POLL_TIMEOUT_S,
					...(offset === undefined ? {} : { offset }),
					...(allowed === undefined ? {} : { allowed_updates: allowed }),
				},
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			if (stopped()) {
				break;
			}
			if (!isTransient(error)) {
				throw error;
			}
			const delayMs = error instanceof ApiError && error.retryAfter > 0 ? error.retryAfter * 1000 : backoffMs;
			backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
			onRetry(error, delayMs);
			await sleep(delayMs, signal);
			continue;
		}
		backoffMs = BACKOFF_START_MS;
		allowed = undefined;
		acknowledged = offset;

		for (const update of updates) {
			try {
				await handler(update);
			} catch (error) {
				onError(error, update);
			}
			offset = update.update_id + 1;
			if (stopped()) {
				break;
			}
		}
	}

	// Stopped: acknowledge what was handled so a restart does not see it again.
	if (offset !== undefined && offset !== acknowledged) {
		try {
			await client.getUpdates({ offset, timeout: 0, limit: 1 });
		} catch (error) {
			// The updates come again on the next start; handlers see them twice.
			console.error("acknowledging handled updates failed:", describe(error));
		}
	}
}

function isTransient(error: unknown): boolean {
	if (error instanceof NetworkError) {
		return true;
	}
	return error instanceof ApiError && (error.status === 429 || error.status >= 500);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

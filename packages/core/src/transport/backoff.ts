export interface BackoffPolicy {
	readonly baseMs: number;
	readonly maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 500, maxMs: 30_000 };

/**
 * Delay before retry number `attempt` (0-based): exponential with "equal
 * jitter", i.e. uniformly in [cap/2, cap] where cap = min(max, base * 2^attempt).
 * The random half spreads reconnect storms after a server restart; the fixed
 * half keeps a client from hammering a server that is down.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number): number {
	const exponent = Math.min(Math.max(attempt, 0), 30);
	const cap = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
	return cap / 2 + random() * (cap / 2);
}

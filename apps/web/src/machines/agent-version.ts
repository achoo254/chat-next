// Which tunelo a machine runs, for features a newer one adds.

/** `version` ("2.0.1", "v2.1.0-beta") is at least `min`; false when unreadable. */
export function versionAtLeast(version: string, min: readonly number[]): boolean {
	const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (parts === null) return false;
	for (let i = 0; i < min.length; i++) {
		const have = Number(parts[i + 1]);
		const want = min[i] ?? 0;
		if (have !== want) return have > want;
	}
	return true;
}

/** The first tunelo that deletes and archives sessions (ThreadDelete, ThreadSetArchived). */
export const AGENT_THREAD_ACTIONS = [2, 0, 6] as const;
